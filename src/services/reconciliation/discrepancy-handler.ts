import { RISK_CONSTANTS } from '../../config/risk-constants.js';

export function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

export function computeDiscrepancyUsd(localUsd: number, exchangeUsd: number): number {
  return roundUsd(localUsd - exchangeUsd);
}

export function isUnexplained(
  discrepancyUsd: number,
  toleranceUsd: number = RISK_CONSTANTS.DISCREPANCY_TOLERANCE_USD,
): boolean {
  return Math.abs(discrepancyUsd) > toleranceUsd;
}

export interface ReconciliationInput {
  localBalanceUsd: number;
  exchangeBalanceUsd: number;
}

export function evaluateReport(input: ReconciliationInput): {
  isSynced: boolean;
  discrepancyUsd: number;
} {
  const discrepancyUsd = computeDiscrepancyUsd(input.localBalanceUsd, input.exchangeBalanceUsd);
  return { isSynced: !isUnexplained(discrepancyUsd), discrepancyUsd };
}
