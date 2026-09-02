import type { Venue } from '../../../db/schema.js';
import { RISK_CONSTANTS } from '../../config/risk-constants.js';
import { timeService } from '../ingestion/time-sync.js';
import type { Balance, OrderExecutionReport, PermissionProbe, PlaceOrderRequest } from '../../types/exchange.js';
import type { ExchangeAdapter, ExchangeCredentials } from './exchange-adapter.js';
import { OrderTimeoutError } from './exchange-adapter.js';

export interface PriceFeed {
  priceUsd(symbol: string): number | null;
}

export interface PositionWithOrder {
  symbol: string;
  sizePct: string;
  entryPrice: string;
  executedQty: string;
  requestedQty: string;
}

export class StaticPriceFeed implements PriceFeed {
  constructor(private readonly prices: Record<string, number>) {}

  priceUsd(symbol: string): number | null {
    return this.prices[symbol.toUpperCase()] ?? null;
  }
}

export class InMemoryPriceFeed implements PriceFeed {
  private prices = new Map<string, number>();

  set(symbol: string, priceUsd: number): void {
    this.prices.set(symbol.toUpperCase(), priceUsd);
  }

  priceUsd(symbol: string): number | null {
    return this.prices.get(symbol.toUpperCase()) ?? null;
  }
}

interface PaperRecord {
  report: OrderExecutionReport;
}

export class PaperAdapter implements ExchangeAdapter {
  readonly venue: Venue = 'BINANCE_SPOT';
  private records = new Map<string, PaperRecord>();
  private cashUsd: number;
  failNextWithTimeout = false;

  constructor(
    private readonly feed: PriceFeed,
    startingCashUsd = 10_000,
  ) {
    this.cashUsd = startingCashUsd;
  }

  cash(): number {
    return this.cashUsd;
  }

  getTotalEquityUsd(positions: PositionWithOrder[]): number {
    let inventoryValue = 0;
    for (const pos of positions) {
      const price = this.feed.priceUsd(pos.symbol);
      if (price !== null) {
        const qty = Number(pos.executedQty) > 0 ? Number(pos.executedQty) : Number(pos.requestedQty);
        inventoryValue += qty * price;
      }
    }
    return this.cashUsd + inventoryValue;
  }

  async serverTime(): Promise<number> {
    return timeService.now();
  }

  async balances(_creds?: ExchangeCredentials): Promise<Balance[]> {
    void _creds;
    return [{ asset: 'USDT', free: this.cashUsd, locked: 0, usdValue: this.cashUsd }];
  }

  private baseAssetFor(symbol: string): string {
    return symbol.replace(/USDT$/i, '').replace(/USDC$/i, '').replace(/BUSD$/i, '') || symbol;
  }

  private holdings = new Map<string, number>();

  holdingsFor(symbol: string): number {
    return this.holdings.get(this.baseAssetFor(symbol)) ?? 0;
  }

  async placeOrder(req: PlaceOrderRequest, _creds?: ExchangeCredentials): Promise<OrderExecutionReport> {
    void _creds;
    if (this.failNextWithTimeout) {
      this.failNextWithTimeout = false;
      throw new OrderTimeoutError(req.clientOrderId);
    }
    let price = this.feed.priceUsd(req.symbol);
    if (price === null) {
      try {
        const { analyzeOrderbook, toGatePair } = await import('../scanner/orderbook-service.js');
        const ob = await analyzeOrderbook(toGatePair(req.symbol)).catch(()=>null);
        price = ob?.mid ?? null;
      } catch { price = null; }
      if (price === null) price = 100;
      if ('set' in this.feed && typeof (this.feed as unknown as {set: unknown}).set === 'function') {
        (this.feed as unknown as InMemoryPriceFeed).set(req.symbol, price);
      }
    }
    if (req.side === 'SELL') {
      const held = this.holdingsFor(req.symbol);
      if (req.qty > held) {
        const report: OrderExecutionReport = {
          clientOrderId: req.clientOrderId,
          externalRef: null,
          status: 'REJECTED',
          executedQty: 0,
          avgFillPrice: null,
          serverTimeMs: await this.serverTime(),
        };
        this.records.set(req.clientOrderId, { report });
        return report;
      }
    }
    const slippage = req.side === 'BUY' ? 1 + req.slippageBps / 10_000 : 1 - req.slippageBps / 10_000;
    const fillPrice = price * slippage;
    const notional = fillPrice * req.qty;
    if (req.side === 'BUY') {
      if (notional > this.cashUsd) {
        const report: OrderExecutionReport = {
          clientOrderId: req.clientOrderId,
          externalRef: null,
          status: 'REJECTED',
          executedQty: 0,
          avgFillPrice: null,
          serverTimeMs: await this.serverTime(),
        };
        this.records.set(req.clientOrderId, { report });
        return report;
      }
      this.cashUsd -= notional;
      this.holdings.set(this.baseAssetFor(req.symbol), this.holdingsFor(req.symbol) + req.qty);
    } else {
      this.cashUsd += notional;
      this.holdings.set(this.baseAssetFor(req.symbol), Math.max(0, this.holdingsFor(req.symbol) - req.qty));
    }
    const report: OrderExecutionReport = {
      clientOrderId: req.clientOrderId,
      externalRef: `paper-${req.clientOrderId}`,
      status: 'FILLED',
      executedQty: req.qty,
      avgFillPrice: fillPrice,
      serverTimeMs: await this.serverTime(),
    };
    this.records.set(req.clientOrderId, { report });
    return report;
  }

  async queryByClientOrderId(clientOrderId: string): Promise<OrderExecutionReport | null> {
    return this.records.get(clientOrderId)?.report ?? null;
  }

  async cancelAll(_symbol?: string, _creds?: ExchangeCredentials): Promise<number> {
    void _symbol;
    void _creds;
    return 0;
  }

  async probePermissions(creds: ExchangeCredentials): Promise<PermissionProbe> {
    void creds;
    return { valid: true, violations: [], effectiveScopes: ['paper'] };
  }
}

export const paperFeed = new InMemoryPriceFeed();
export const paperAdapter = new PaperAdapter(paperFeed);

export function paperSlippageBps(): number {
  return Math.round(RISK_CONSTANTS.STALENESS_LIMIT_MS / 100) % 50 + 10;
}
