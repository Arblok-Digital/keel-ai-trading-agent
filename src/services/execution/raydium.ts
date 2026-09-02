import {
  Connection,
  Keypair,
  MessageV0,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import type { Venue } from '../../../db/schema.js';
import { getEnv } from '../../config/env.js';
import type { Balance, OrderExecutionReport, PermissionProbe, PlaceOrderRequest } from '../../types/exchange.js';
import {
  OrderTimeoutError,
  SpotOnlyViolationError,
  type ExchangeAdapter,
  type ExchangeCredentials,
} from './exchange-adapter.js';

const AMM_V4_SWAP_BASE_IN = 9;

const LAMPORTS_PER_SOL = 1_000_000_000;

export interface RaydiumPoolAccounts {
  ammId: PublicKey;
  ammAuthority: PublicKey;
  ammOpenOrders: PublicKey;
  poolCoinTokenAccount: PublicKey;
  poolPcTokenAccount: PublicKey;
  serumProgram: PublicKey;
  serumMarket: PublicKey;
  serumBids: PublicKey;
  serumAsks: PublicKey;
  serumEventQueue: PublicKey;
  serumCoinVault: PublicKey;
  serumPcVault: PublicKey;
  serumVaultSigner: PublicKey;
  coinMint: PublicKey;
  pcMint: PublicKey;
  coinDecimals: number;
}

export class RaydiumAdapter implements ExchangeAdapter {
  readonly venue: Venue = 'RAYDIUM';
  private connection?: Connection;
  private pools = new Map<string, RaydiumPoolAccounts>();

  constructor() {
    const rpc = getEnv().SOLANA_RPC_URL;
    if (rpc) this.connection = new Connection(rpc, 'confirmed');
  }

  private conn(): Connection {
    if (!this.connection) throw new Error('SOLANA_RPC_URL not configured');
    return this.connection;
  }

  registerPool(symbol: string, pool: RaydiumPoolAccounts): void {
    this.pools.set(symbol.toUpperCase(), pool);
  }

  async serverTime(): Promise<number> {
    const perf = await this.conn().getRecentPerformanceSamples(1);
    void perf;
    const slot = await this.conn().getSlot();
    const blockTime = await this.conn().getBlockTime(slot).catch(() => null);
    if (blockTime) return blockTime * 1000;
    throw new Error('solana block time unavailable');
  }

  async balances(creds?: ExchangeCredentials): Promise<Balance[]> {
    void creds;
    const owner = this.ownerKey();
    const lamports = await this.conn().getBalance(owner.publicKey);
    const out: Balance[] = [
      { asset: 'SOL', free: lamports / LAMPORTS_PER_SOL, locked: 0, usdValue: 0 },
    ];
    const tokenAccounts = await this.conn()
      .getParsedTokenAccountsByOwner(owner.publicKey, { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') })
      .catch(() => ({ value: [] }));
    for (const item of tokenAccounts.value) {
      const info = item.account.data.parsed.info;
      out.push({
        asset: String(info.mint).slice(0, 8),
        free: Number(info.tokenAmount.uiAmount ?? 0),
        locked: 0,
        usdValue: 0,
      });
    }
    return out;
  }

  private ownerKey(): Keypair {
    const secret = process.env.SOLANA_WALLET_SECRET_B58;
    if (!secret) throw new Error('SOLANA_WALLET_SECRET_B64 not configured');
    const raw = Buffer.from(secret, 'base64');
    return Keypair.fromSeed(raw.subarray(0, 32));
  }

  async placeOrder(req: PlaceOrderRequest, _creds?: ExchangeCredentials): Promise<OrderExecutionReport> {
    void _creds;
    const pool = this.pools.get(req.symbol.toUpperCase());
    if (!pool) throw new Error(`no raydium pool registered for ${req.symbol}`);
    const programId = new PublicKey(
      getEnv().RAYDIUM_AMM_V4_PROGRAM ?? '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    );
    const owner = this.ownerKey();
    const userSource = req.side === 'BUY' ? this.derivedAta(pool.pcMint, owner) : this.derivedAta(pool.coinMint, owner);
    const userDest = req.side === 'BUY' ? this.derivedAta(pool.coinMint, owner) : this.derivedAta(pool.pcMint, owner);

    const amountInRaw = BigInt(Math.floor(req.qty * 10 ** 9));
    const minOutRaw = (amountInRaw * BigInt(10_000 - Math.round(req.slippageBps))) / BigInt(10_000);
    const data = Buffer.alloc(17);
    data.writeUInt8(AMM_V4_SWAP_BASE_IN, 0);
    data.writeBigUInt64LE(amountInRaw, 1);
    data.writeBigUInt64LE(minOutRaw, 9);

    const keys = [
      { pubkey: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), isSigner: false, isWritable: false },
      { pubkey: pool.ammId, isSigner: false, isWritable: true },
      { pubkey: pool.ammAuthority, isSigner: false, isWritable: false },
      { pubkey: pool.ammOpenOrders, isSigner: false, isWritable: true },
      { pubkey: pool.ammOpenOrders, isSigner: false, isWritable: true },
      { pubkey: pool.poolCoinTokenAccount, isSigner: false, isWritable: true },
      { pubkey: pool.poolPcTokenAccount, isSigner: false, isWritable: true },
      { pubkey: pool.serumProgram, isSigner: false, isWritable: false },
      { pubkey: pool.serumMarket, isSigner: false, isWritable: false },
      { pubkey: pool.serumBids, isSigner: false, isWritable: true },
      { pubkey: pool.serumAsks, isSigner: false, isWritable: true },
      { pubkey: pool.serumEventQueue, isSigner: false, isWritable: true },
      { pubkey: pool.serumCoinVault, isSigner: false, isWritable: false },
      { pubkey: pool.serumPcVault, isSigner: false, isWritable: false },
      { pubkey: pool.serumVaultSigner, isSigner: false, isWritable: false },
      { pubkey: userSource, isSigner: false, isWritable: true },
      { pubkey: userDest, isSigner: false, isWritable: true },
      { pubkey: owner.publicKey, isSigner: true, isWritable: false },
    ];

    const swapIx = new TransactionInstruction({ keys, programId, data });

    const startedAtServerMs = await this.serverTime().catch(() => 0);
    try {
      const conn = this.conn();
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash({ commitment: 'finalized' });
      const msg = new VersionedTransaction(
        MessageV0.compile({
          payerKey: owner.publicKey,
          instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), swapIx],
          recentBlockhash: blockhash,
        }),
      );
      msg.sign([owner]);
      const signature = await conn.sendTransaction(msg, { maxRetries: 0 });
      const confirmation = await conn.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed',
      );
      const ok = !confirmation.value.err;
      return {
        clientOrderId: req.clientOrderId,
        externalRef: signature,
        status: ok ? 'FILLED' : 'REJECTED',
        executedQty: ok ? req.qty : 0,
        avgFillPrice: null,
        serverTimeMs: startedAtServerMs,
      };
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.message.toLowerCase().includes('timeout'))) {
        throw new OrderTimeoutError(req.clientOrderId);
      }
      throw err;
    }
  }

  private derivedAta(mint: PublicKey, owner: Keypair): PublicKey {
    const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    const [ata] = PublicKey.findProgramAddressSync(
      [owner.publicKey.toBuffer(), mint.toBuffer(), TOKEN_PROGRAM.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM,
    );
    return ata;
  }

  async queryByClientOrderId(_clientOrderId: string): Promise<OrderExecutionReport | null> {
    void _clientOrderId;
    return null;
  }

  async cancelAll(): Promise<number> {
    return 0;
  }

  async probePermissions(creds: ExchangeCredentials): Promise<PermissionProbe> {
    const forbidden = ['withdrawal', 'margin', 'transfer'];
    const violations = creds.scopes.filter((s) => forbidden.includes(s.toLowerCase()));
    if (violations.length > 0) throw new SpotOnlyViolationError(violations);
    return { valid: true, violations: [], effectiveScopes: ['spot-wallet-swap'] };
  }
}

export const raydiumAdapter = new RaydiumAdapter();
