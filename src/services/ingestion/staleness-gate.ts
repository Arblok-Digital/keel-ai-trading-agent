import { RISK_CONSTANTS } from '../../config/risk-constants.js';
import { timeService } from './time-sync.js';

export interface StalenessRejection {
  symbol: string;
  venue: string;
  latencyMs: number;
  limitMs: number;
}

export type StalenessListener = (rejection: StalenessRejection) => void;

const staleListeners = new Set<StalenessListener>();

export function onStaleTick(listener: StalenessListener): void {
  staleListeners.add(listener);
}

export function subscribeStale(listener: StalenessListener): () => void {
  staleListeners.add(listener);
  return () => {
    staleListeners.delete(listener);
  };
}

export function isTickFresh(symbol: string, venue: string, tsServerMs: number, limitMs: number = RISK_CONSTANTS.STALENESS_LIMIT_MS): boolean {
  const latencyMs = timeService.now() - tsServerMs;
  if (latencyMs < 0) {
    for (const listener of staleListeners) {
      listener?.({ symbol, venue, latencyMs, limitMs });
    }
    return false;
  }
  if (latencyMs <= limitMs) return true;
  for (const listener of staleListeners) {
    listener?.({ symbol, venue, latencyMs, limitMs });
  }
  return false;
}
