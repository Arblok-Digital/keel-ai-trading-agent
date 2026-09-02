import type { Venue } from '../../../db/schema.js';
import type { Balance, OrderExecutionReport, PermissionProbe, PlaceOrderRequest } from '../../types/exchange.js';

export class OrderTimeoutError extends Error {
  constructor(public readonly clientOrderId: string) {
    super(`order placement timed out for ${clientOrderId}; query-by-clientOrderId required before retry`);
    this.name = 'OrderTimeoutError';
  }
}

export class SpotOnlyViolationError extends Error {
  constructor(public readonly violations: string[]) {
    super(`credential rejected: non-spot scopes ${violations.join(',')}`);
    this.name = 'SpotOnlyViolationError';
  }
}

export interface ExchangeCredentials {
  apiKey: string;
  apiSecret: string;
  scopes: string[];
}

export interface ExchangeAdapter {
  readonly venue: Venue;
  serverTime(): Promise<number>;
  balances(creds?: ExchangeCredentials): Promise<Balance[]>;
  placeOrder(req: PlaceOrderRequest, creds?: ExchangeCredentials): Promise<OrderExecutionReport>;
  queryByClientOrderId(clientOrderId: string, creds?: ExchangeCredentials): Promise<OrderExecutionReport | null>;
  cancelAll(symbol: string | undefined, creds?: ExchangeCredentials): Promise<number>;
  probePermissions(creds: ExchangeCredentials): Promise<PermissionProbe>;
}
