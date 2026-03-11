import type { CashFlowRow, NonFundingLedgerUpdate } from "./types.js";
import { parseFiniteNumber } from "./utils.js";

export const MIN_CASH_FLOW_ABS = 1e-8;
export const INFERRED_CASH_FLOW_SOURCE = "inferred_equity_delta";
export const API_NON_FUNDING_CASH_FLOW_SOURCE =
  "api_user_non_funding_ledger_updates";

export function toInferredCashFlowRow(
  address: string,
  eventTime: number,
  previousTotalValue: number,
  currentTotalValue: number,
  realizedPnl: number,
): CashFlowRow | null {
  const equityDelta = currentTotalValue - previousTotalValue;
  const amount = equityDelta - realizedPnl;

  if (!Number.isFinite(amount) || Math.abs(amount) < MIN_CASH_FLOW_ABS) {
    return null;
  }

  return {
    address,
    event_time: eventTime,
    amount,
    direction: amount >= 0 ? "in" : "out",
    source: INFERRED_CASH_FLOW_SOURCE,
    pnl_component: realizedPnl,
    equity_delta: equityDelta,
    raw_json: JSON.stringify({
      previous_total_value: previousTotalValue,
      current_total_value: currentTotalValue,
      realized_pnl: realizedPnl,
    }),
  };
}

export function toApiNonFundingCashFlowRow(
  address: string,
  event: NonFundingLedgerUpdate,
): CashFlowRow | null {
  const eventTime = parseFiniteNumber(event.time);
  const amount = parseFiniteNumber(event.delta?.usdc);
  if (eventTime === null || amount === null) {
    return null;
  }
  if (Math.abs(amount) < MIN_CASH_FLOW_ABS) {
    return null;
  }

  return {
    address,
    event_time: eventTime,
    amount,
    direction: amount >= 0 ? "in" : "out",
    source: API_NON_FUNDING_CASH_FLOW_SOURCE,
    pnl_component: 0,
    equity_delta: 0,
    raw_json: JSON.stringify(event),
  };
}
