import type { Venue } from '../../../db/schema.js';
import { getEnv } from '../../config/env.js';
import { RISK_CONSTANTS } from '../../config/risk-constants.js';
import type { Balance, OrderExecutionReport, PermissionProbe, PlaceOrderRequest } from '../../types/exchange.js';
import { hmacSha256Hex } from './vault.js';
import { OrderTimeoutError, SpotOnlyViolationError, type ExchangeAdapter, type ExchangeCredentials } from './exchange-adapter.js';

interface BinanceOrderResponse {
  origClientOrderId?: string;
  executedQty?: string;
  cummulativeQuoteQty?: string;
  status?: string;
  orderId?: number;
}

function statusToOrderStatus(status: string): OrderExecutionReport['status'] {
  switch (status) {
    case 'NEW':
    case 'PENDING_NEW':
      return 'PENDING';
    case 'PARTIALLY_FILLED':
      return 'PARTIALLY_FILLED';
    case 'FILLED':
      return 'FILLED';
    case 'REJECTED':
    case 'EXPIRED':
      return 'REJECTED';
    case 'CANCELED':
    case 'CANCELLED':
      return 'CANCELLED';
    default:
      return 'PENDING';
  }
}

export class BinanceSpotAdapter implements ExchangeAdapter {
  readonly venue: Venue = 'BINANCE_SPOT';

  private baseUrl(): string {
    return getEnv().BINANCE_API_URL;
  }

  async serverTime(): Promise<number> {
    const res = await fetch(`${this.baseUrl()}/api/v3/time`, { signal: AbortSignal.timeout(3000) });
    const json = (await res.json()) as { serverTime: number };
    return json.serverTime;
  }

  async balances(creds: ExchangeCredentials): Promise<Balance[]> {
    const data = await this.signedRequest<{ balances?: Array<{ asset: string; free: string; locked: string }> }>('/api/v3/account', new URLSearchParams(), creds);
    const prices = await this.fetchUsdPrices();
    return (data.balances ?? []).map((b) => {
      const qty = Number(b.free) + Number(b.locked);
      if (!Number.isFinite(qty) || qty === 0) return { asset: b.asset, free: Number(b.free), locked: Number(b.locked), usdValue: 0 };
      if (b.asset === 'USDT' || b.asset === 'USDC' || b.asset === 'BUSD' || b.asset === 'FDUSD') return { asset: b.asset, free: Number(b.free), locked: Number(b.locked), usdValue: qty };
      const usdPerUnit = prices.get(b.asset) ?? 0;
      return { asset: b.asset, free: Number(b.free), locked: Number(b.locked), usdValue: qty * usdPerUnit };
    });
  }

  private async fetchUsdPrices(): Promise<Map<string, number>> {
    try {
      const tickers = await fetch(`${this.baseUrl()}/api/v3/ticker/price`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json() as Promise<Array<{ symbol: string; price: string }>>);
      const byAsset = new Map<string, number>();
      for (const t of tickers) {
        if (t.symbol.endsWith('USDT')) {
          const asset = t.symbol.slice(0, -4);
          const p = Number(t.price);
          if (Number.isFinite(p) && p > 0) byAsset.set(asset, p);
        }
      }
      return byAsset;
    } catch {
      return new Map();
    }
  }

  private async signedRequest<T>(path: string, params: URLSearchParams, creds: ExchangeCredentials): Promise<T> {
    params.set('timestamp', String(await this.serverTime()));
    params.set('recvWindow', '5000');
    const query = params.toString();
    const signature = hmacSha256Hex(creds.apiSecret, query);
    const res = await fetch(`${this.baseUrl()}${path}?${query}&signature=${signature}`, {
      headers: { 'X-MBX-APIKEY': creds.apiKey },
      signal: AbortSignal.timeout(RISK_CONSTANTS.ORDER_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`binance ${path} http ${res.status}: ${body}`);
    }
    return (await res.json()) as T;
  }

  async placeOrder(req: PlaceOrderRequest, creds: ExchangeCredentials): Promise<OrderExecutionReport> {
    if (req.venue !== this.venue) throw new Error(`venue mismatch: ${req.venue}`);
    const serverTimeMs = await this.serverTime();
    try {
      const params = new URLSearchParams({
        symbol: req.symbol,
        side: req.side,
        type: 'MARKET',
        quantity: String(req.qty),
        newClientOrderId: req.clientOrderId.slice(0, 36),
      });
      const raw = await this.signedRequest<BinanceOrderResponse>('/api/v3/order', params, creds);
      const executedQty = Number(raw.executedQty ?? '0');
      const quote = Number(raw.cummulativeQuoteQty ?? '0');
      return {
        clientOrderId: raw.origClientOrderId ?? req.clientOrderId,
        externalRef: raw.orderId ? String(raw.orderId) : null,
        status: statusToOrderStatus(raw.status ?? 'NEW'),
        executedQty,
        avgFillPrice: executedQty > 0 ? quote / executedQty : null,
        serverTimeMs,
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') throw new OrderTimeoutError(req.clientOrderId);
      throw err;
    }
  }

  async queryByClientOrderId(clientOrderId: string, creds: ExchangeCredentials): Promise<OrderExecutionReport | null> {
    try {
      const params = new URLSearchParams({ origClientOrderId: clientOrderId });
      const raw = await this.signedRequest<BinanceOrderResponse>('/api/v3/order', params, creds);
      const executedQty = Number(raw.executedQty ?? '0');
      const quote = Number(raw.cummulativeQuoteQty ?? '0');
      return {
        clientOrderId,
        externalRef: raw.orderId ? String(raw.orderId) : null,
        status: statusToOrderStatus(raw.status ?? 'NEW'),
        executedQty,
        avgFillPrice: executedQty > 0 ? quote / executedQty : null,
        serverTimeMs: await this.serverTime(),
      };
    } catch (err) {
      if (err instanceof Error && err.message.includes('http 404')) return null;
      if (err instanceof Error && err.message.includes('-2011')) return null;
      throw err;
    }
  }

  async cancelAll(symbol: string | undefined, creds: ExchangeCredentials): Promise<number> {
    const target = symbol ?? undefined;
    const getParams = new URLSearchParams();
    if (target) getParams.set('symbol', target);
    const before = await this.signedRequest<unknown[]>('/api/v3/openOrders', getParams, creds).catch(() => [] as unknown[]);
    const delParams = new URLSearchParams();
    if (target) delParams.set('symbol', target);
    try {
      const cancelled = await this.signedDeleteRequest<unknown[]>('/api/v3/openOrders', delParams, creds);
      if (Array.isArray(cancelled)) return cancelled.length;
    } catch {
      if (Array.isArray(before)) return before.length;
      return 0;
    }
    if (Array.isArray(before)) return before.length;
    return 0;
  }

  private async signedDeleteRequest<T>(path: string, params: URLSearchParams, creds: ExchangeCredentials): Promise<T> {
    params.set('timestamp', String(await this.serverTime()));
    params.set('recvWindow', '5000');
    const query = params.toString();
    const signature = hmacSha256Hex(creds.apiSecret, query);
    const res = await fetch(`${this.baseUrl()}${path}?${query}&signature=${signature}`, {
      method: 'DELETE',
      headers: { 'X-MBX-APIKEY': creds.apiKey },
      signal: AbortSignal.timeout(RISK_CONSTANTS.ORDER_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`binance ${path} http ${res.status}: ${body}`);
    }
    return (await res.json()) as T;
  }

  async probePermissions(creds: ExchangeCredentials): Promise<PermissionProbe> {
    const forbidden = ['withdrawal', 'withdraw', 'margin', 'transfer', 'futures', 'leverage'];
    const violations = creds.scopes.filter((s) => forbidden.includes(s.toLowerCase()));
    if (violations.length > 0) throw new SpotOnlyViolationError(violations);
    await this.balances(creds);
    return { valid: true, violations: [], effectiveScopes: creds.scopes };
  }
}

export const binanceSpotAdapter = new BinanceSpotAdapter();
