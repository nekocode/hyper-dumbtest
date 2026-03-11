import { describe, expect, it } from "vitest";
import {
  toApiNonFundingCashFlowRow,
  toInferredCashFlowRow,
} from "../cash_flows.js";
import type { NonFundingLedgerUpdate } from "../types.js";

describe("cash flow mapping", () => {
  it("should map inferred cash flow and keep pnl/equity components", () => {
    const row = toInferredCashFlowRow("0xabc", 123, 1000, 1200, 50);
    expect(row).not.toBeNull();
    expect(row?.amount).toBe(150);
    expect(row?.direction).toBe("in");
    expect(row?.pnl_component).toBe(50);
    expect(row?.equity_delta).toBe(200);
    expect(row?.source).toBe("inferred_equity_delta");
  });

  it("should skip inferred cash flow when net amount is near zero", () => {
    const row = toInferredCashFlowRow("0xabc", 123, 1000, 1010, 10);
    expect(row).toBeNull();
  });

  it("should map non-funding ledger update as real cash flow", () => {
    const event: NonFundingLedgerUpdate = {
      delta: {
        type: "deposit",
        usdc: "1000.5",
      },
      hash: "0xhash",
      time: 1681222254710,
    };
    const row = toApiNonFundingCashFlowRow("0xabc", event);
    expect(row).not.toBeNull();
    expect(row?.amount).toBe(1000.5);
    expect(row?.direction).toBe("in");
    expect(row?.source).toBe("api_user_non_funding_ledger_updates");
    expect(row?.pnl_component).toBe(0);
    expect(row?.equity_delta).toBe(0);
  });

  it("should map negative usdc as outflow", () => {
    const event: NonFundingLedgerUpdate = {
      delta: {
        type: "withdraw",
        usdc: "-12.34",
      },
      time: 1681222254710,
    };
    const row = toApiNonFundingCashFlowRow("0xabc", event);
    expect(row).not.toBeNull();
    expect(row?.direction).toBe("out");
    expect(row?.amount).toBe(-12.34);
  });

  it("should skip invalid non-funding ledger update", () => {
    const missingTime: NonFundingLedgerUpdate = {
      delta: { type: "deposit", usdc: "100" },
    };
    const missingAmount: NonFundingLedgerUpdate = {
      delta: { type: "deposit" },
      time: 1681222254710,
    };
    expect(toApiNonFundingCashFlowRow("0xabc", missingTime)).toBeNull();
    expect(toApiNonFundingCashFlowRow("0xabc", missingAmount)).toBeNull();
  });
});
