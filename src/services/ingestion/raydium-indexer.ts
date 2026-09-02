import { Connection, PublicKey } from '@solana/web3.js';
import type { DEXPoolUpdate } from '../../types/exchange.js';
import { getEnv } from '../../config/env.js';
import { isTickFresh } from './staleness-gate.js';

export interface RaydiumWatchConfig {
  ammId: string;
  symbol: string;
  coinDecimals: number;
  vaultA?: string;
  vaultB?: string;
  baseMint?: string;
  quoteMint?: string;
}

interface AMMLayout {
  status: bigint;
  nonce: bigint;
  orderNum: bigint;
  depth: bigint;
  baseDecimal: bigint;
  quoteDecimal: bigint;
  state: bigint;
  resetFlag: bigint;
  minSize: bigint;
  volMaxCutRatio: bigint;
  amountWaveRatio: bigint;
  baseLotSize: bigint;
  quoteLotSize: bigint;
  minOrderQuoteQty: bigint;
  baseVault: string;
  quoteVault: string;
  baseMint: string;
  quoteMint: string;
  lpMint: string;
  openOrders: string;
  marketId: string;
}

export class RaydiumIndexer {
  private connection: Connection | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private isRunning = false;

  private conn(): Connection {
    if (!this.connection) {
      const rpc = getEnv().SOLANA_RPC_URL;
      this.connection = new Connection(rpc ?? 'https://api.mainnet-beta.solana.com', 'confirmed');
    }
    return this.connection;
  }

  start(pools: RaydiumWatchConfig[], onUpdate: (u: DEXPoolUpdate) => void, intervalMs = 15_000): void {
    if (this.timer || this.isRunning) return;
    this.isRunning = true;
    const tick = async () => {
      await Promise.all(
        pools.map(async (pool) => {
          try {
            await this.pollPool(pool, onUpdate);
          } catch (err) {
            console.error(`[raydium-indexer] ${pool.symbol}:`, err instanceof Error ? err.message : err);
          }
        }),
      );
    };
    void tick();
    this.timer = setInterval(() => void tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.isRunning = false;
  }

  private async emitPoolUpdate(
    pool: RaydiumWatchConfig,
    onUpdate: (u: DEXPoolUpdate) => void,
    vaultA: string,
    vaultB: string,
    priceA: number,
    priceB: number,
    tsServerMs: number,
  ): Promise<void> {
    const conn = this.conn();
    const [balA, balB] = await Promise.all([
      conn.getTokenAccountBalance(new PublicKey(vaultA)).catch(() => null),
      conn.getTokenAccountBalance(new PublicKey(vaultB)).catch(() => null),
    ]);

    const amtA = balA?.value?.uiAmount ?? 0;
    const amtB = balB?.value?.uiAmount ?? 0;
    const liquidityUsd = amtA * priceA + amtB * priceB;

    onUpdate({
      poolAddress: pool.ammId,
      venue: 'RAYDIUM',
      symbol: pool.symbol,
      baseLiquidityUsd: liquidityUsd / 2,
      quoteLiquidityUsd: liquidityUsd / 2,
      swapVolumeUsdWindow: Math.max(0, liquidityUsd * 0.01),
      tsServerMs,
    });
  }

  private async pollPool(pool: RaydiumWatchConfig, onUpdate: (u: DEXPoolUpdate) => void): Promise<void> {
    const conn = this.conn();
    const slot = await conn.getSlot();
    const blockTime = await conn.getBlockTime(slot).catch(() => null);
    if (!blockTime) return;
    const tsServerMs = blockTime * 1000;
    if (!isTickFresh(pool.symbol, 'RAYDIUM', tsServerMs)) return;

    let vaultA = pool.vaultA;
    let vaultB = pool.vaultB;
    const priceA = 1;
    const priceB = 1;

    if (!vaultA || !vaultB) {
      const info = await conn.getAccountInfo(new PublicKey(pool.ammId)).catch(() => null);
      if (info) {
        const a = parseAmmLayout(info.data);
        vaultA = a?.baseVault ?? vaultA;
        vaultB = a?.quoteVault ?? vaultB;
      }
    }

    if (!vaultA || !vaultB) {
      console.warn(`[raydium-indexer] ${pool.symbol}: no vault addresses resolved`);
      return;
    }

    await this.emitPoolUpdate(pool, onUpdate, vaultA, vaultB, priceA, priceB, tsServerMs);
  }
}

function parseAmmLayout(data: Uint8Array): AMMLayout | null {
  try {
    const buf = Buffer.from(data);
    if (buf.length < 500) return null;
    const read64 = (off: number): bigint => buf.readBigUInt64LE(off);
    const toPubkey = (off: number): string =>
      new PublicKey(buf.subarray(off, off + 32)).toBase58();

    const baseVault = toPubkey(118);
    const quoteVault = toPubkey(150);
    const baseMint = toPubkey(182);
    const quoteMint = toPubkey(214);

    return {
      status: read64(8),
      nonce: read64(16),
      orderNum: read64(24),
      depth: read64(32),
      baseDecimal: read64(40),
      quoteDecimal: read64(48),
      state: read64(56),
      resetFlag: read64(64),
      minSize: read64(72),
      volMaxCutRatio: read64(80),
      amountWaveRatio: read64(88),
      baseLotSize: read64(96),
      quoteLotSize: read64(104),
      minOrderQuoteQty: read64(112),
      baseVault,
      quoteVault,
      baseMint,
      quoteMint,
      lpMint: toPubkey(246),
      openOrders: toPubkey(278),
      marketId: toPubkey(310),
    };
  } catch {
    return null;
  }
}
