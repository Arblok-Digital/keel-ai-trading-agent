import { createPublicClient, http, parseAbiItem, type PublicClient } from 'viem';
import type { DEXPoolUpdate } from '../../types/exchange.js';
import { getEnv } from '../../config/env.js';
import { evmChain } from '../execution/uniswap-v3.js';
import { isTickFresh } from './staleness-gate.js';

const SWAP_EVENT = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
);

const SLOT0_ABI = [
  {
    name: 'slot0',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
] as const;

const LIQUIDITY_ABI = [
  {
    name: 'liquidity',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint128' }],
  },
] as const;

const DECIMALS_ABI = [
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

export interface UniswapPoolConfig {
  poolAddress: `0x${string}`;
  symbol: string;
  token0Address?: `0x${string}`;
  token1Address?: `0x${string}`;
  token0Decimals?: number;
  token1Decimals?: number;
}

const decimalCache = new Map<`0x${string}`, number>();

async function getDecimals(client: PublicClient, addr: `0x${string}` | undefined): Promise<number> {
  if (!addr) return 18;
  const cached = decimalCache.get(addr);
  if (cached !== undefined) return cached;
  const decimals = await client
    .readContract({
      address: addr,
      abi: DECIMALS_ABI,
      functionName: 'decimals',
    })
    .then((d) => Number(d))
    .catch(() => 18);
  decimalCache.set(addr, decimals);
  return decimals;
}

function sqrtPriceToPrice(sqrtPriceX96: bigint, dec0: number, dec1: number): number {
  const Q96 = 1n << 96n;
  const ratio = Number(sqrtPriceX96) / Number(Q96);
  return ratio * ratio * Math.pow(10, dec0 - dec1);
}

export class UniswapV3Indexer {
  private client: PublicClient | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastPolledBlock = new Map<string, bigint>();

  constructor(private readonly pools: UniswapPoolConfig[]) {}

  private ensureClient(): PublicClient {
    if (!this.client) {
      const env = getEnv();
      this.client = createPublicClient({ chain: evmChain(), transport: http(env.EVM_RPC_URL) });
    }
    return this.client;
  }

  start(onUpdate: (update: DEXPoolUpdate) => void, intervalMs = 12_000): void {
    if (this.timer) return;
    const tick = async () => {
      await Promise.all(
        this.pools.map(async (pool) => {
          try {
            await this.pollPool(pool, onUpdate);
          } catch (err) {
            console.error(`[dex-indexer] poll failed ${pool.symbol}:`, err instanceof Error ? err.message : err);
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
  }

  private async pollPool(pool: UniswapPoolConfig, onUpdate: (u: DEXPoolUpdate) => void): Promise<void> {
    const client = this.ensureClient();
    const latest = await client.getBlockNumber();
    const lastCursor = this.lastPolledBlock.get(pool.poolAddress) ?? 0n;
    const fromBlock = lastCursor === 0n ? latest - 10n : lastCursor + 1n;
    if (latest < fromBlock) return;

    const [logs, slot0Raw, liquidityRaw] = await Promise.all([
      client.getLogs({
        address: pool.poolAddress,
        event: SWAP_EVENT,
        fromBlock,
        toBlock: latest,
      }),
      client.readContract({
        address: pool.poolAddress,
        abi: SLOT0_ABI,
        functionName: 'slot0',
      }) as Promise<readonly [bigint, number, number, number, number, number, boolean]>,
      client.readContract({
        address: pool.poolAddress,
        abi: LIQUIDITY_ABI,
        functionName: 'liquidity',
      }) as Promise<bigint>,
    ]);

    this.lastPolledBlock.set(pool.poolAddress, latest);

    const block = await client.getBlock({ blockNumber: latest });
    const tsServerMs = Number(block.timestamp) * 1000;
    if (!isTickFresh(pool.symbol, 'UNISWAP_V3', tsServerMs)) return;

    const [dec0, dec1] = await Promise.all([
      getDecimals(client, pool.token0Address),
      getDecimals(client, pool.token1Address),
    ]);

    const slot0Tuple = slot0Raw as readonly [bigint, number, number, number, number, number, boolean];
    const sqrtPriceX96 = slot0Tuple[0];
    if (!sqrtPriceX96) return;

    const price = sqrtPriceToPrice(sqrtPriceX96, dec0, dec1);
    if (price <= 0) return;

    const Q96 = 1n << 96n;
    const priceRaw = Number(sqrtPriceX96) / Number(Q96);
    const normalizedPriceForL = priceRaw * priceRaw;
    const liquidityUsd = normalizedPriceForL > 0 ? (Number(liquidityRaw) * normalizedPriceForL) / Math.pow(10, dec1) : 0;

    let swapVolumeUsdWindow = 0;
    for (const log of logs) {
      const amount0 = log.args.amount0 ?? 0n;
      const amount1 = log.args.amount1 ?? 0n;
      const abs0 = Number(amount0 < 0n ? -amount0 : amount0) / Math.pow(10, dec0);
      const abs1 = Number(amount1 < 0n ? -amount1 : amount1) / Math.pow(10, dec1);
      const usdFrom1 = abs1;
      swapVolumeUsdWindow = Math.max(swapVolumeUsdWindow, usdFrom1 || abs0 * price);
    }

    const totalLiquidityUsd = Math.max(liquidityUsd, 0);
    onUpdate({
      poolAddress: pool.poolAddress,
      venue: 'UNISWAP_V3',
      symbol: pool.symbol,
      baseLiquidityUsd: totalLiquidityUsd / 2,
      quoteLiquidityUsd: totalLiquidityUsd / 2,
      swapVolumeUsdWindow,
      tsServerMs,
    });
  }
}
