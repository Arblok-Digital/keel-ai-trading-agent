import { createPublicClient, createWalletClient, http, defineChain, parseUnits, type PublicClient, type Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Venue } from '../../../db/schema.js';
import { getEnv } from '../../config/env.js';
import { RISK_CONSTANTS } from '../../config/risk-constants.js';
import type { Balance, OrderExecutionReport, PermissionProbe, PlaceOrderRequest } from '../../types/exchange.js';
import {
  OrderTimeoutError,
  SpotOnlyViolationError,
  type ExchangeAdapter,
  type ExchangeCredentials,
} from './exchange-adapter.js';

const SWAP_ROUTER_ABI = [
  {
    name: 'exactInputSingle',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

export function evmChain(): Chain {
  const env = getEnv();
  const rpc = env.EVM_RPC_URL ?? 'http://localhost:8545';
  return defineChain({
    id: env.EVM_CHAIN_ID,
    name: 'keel-evm',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
}

export interface UniswapRouteConfig {
  walletPrivateKey: string;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  feeTier: number;
  poolFeeBps: number;
}

export class UniswapV3Adapter implements ExchangeAdapter {
  readonly venue: Venue = 'UNISWAP_V3';
  private client?: PublicClient;
  private routes = new Map<string, UniswapRouteConfig>();

  constructor() {
    const env = getEnv();
    if (env.EVM_RPC_URL) {
      this.client = createPublicClient({ chain: evmChain(), transport: http(env.EVM_RPC_URL) });
    }
  }

  registerSymbol(symbol: string, route: UniswapRouteConfig): void {
    this.routes.set(symbol.toUpperCase(), route);
  }

  async serverTime(): Promise<number> {
    if (!this.client) throw new Error('EVM_RPC_URL not configured');
    const block = await this.client.getBlock({ blockTag: 'latest' });
    return Number(block.timestamp) * 1000;
  }

  async balances(_creds?: ExchangeCredentials): Promise<Balance[]> {
    void _creds;
    return [];
  }

  async placeOrder(req: PlaceOrderRequest, _creds?: ExchangeCredentials): Promise<OrderExecutionReport> {
    void _creds;
    const client = this.client;
    const route = this.routes.get(req.symbol.toUpperCase());
    if (!client || !route) throw new Error(`no uniswap route for ${req.symbol}`);
    const router = getEnv().UNISWAP_ROUTER_ADDRESS as `0x${string}` | undefined;
    if (!router) throw new Error('UNISWAP_ROUTER_ADDRESS not configured');

    const startedAtServerMs = await this.serverTime();
    try {
      const wallet = createWalletClient({
        account: privateKeyToAccount(route.walletPrivateKey as `0x${string}`),
        chain: evmChain(),
        transport: http(getEnv().EVM_RPC_URL),
      });
      const amountIn = parseUnits(String(req.qty), 18);
      const minOut = (amountIn * BigInt(10_000 - Math.round(req.slippageBps))) / BigInt(10_000);
      const hash = await wallet.writeContract({
        address: router,
        abi: SWAP_ROUTER_ABI,
        functionName: 'exactInputSingle',
        args: [
          {
            tokenIn: route.tokenIn,
            tokenOut: route.tokenOut,
            fee: route.feeTier,
            recipient: wallet.account.address,
            amountIn,
            amountOutMinimum: minOut,
            sqrtPriceLimitX96: BigInt(0),
          },
        ],
      });
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: RISK_CONSTANTS.ORDER_TIMEOUT_MS });
      const filled = receipt.status === 'success';
      return {
        clientOrderId: req.clientOrderId,
        externalRef: hash,
        status: filled ? 'FILLED' : 'REJECTED',
        executedQty: filled ? req.qty : 0,
        avgFillPrice: null,
        serverTimeMs: startedAtServerMs,
      };
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.message.includes('timeout'))) {
        throw new OrderTimeoutError(req.clientOrderId);
      }
      throw err;
    }
  }

  async queryByClientOrderId(clientOrderId: string): Promise<OrderExecutionReport | null> {
    void clientOrderId;
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

export const uniswapV3Adapter = new UniswapV3Adapter();
