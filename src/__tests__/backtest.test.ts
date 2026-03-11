import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import {
  computeAddressStats,
  initDatabase,
  insertAddresses,
  insertTrades,
} from "../lib/db.js";
import {
  buildEquityAtOpenResolver,
  buildEqualWeightAllocations,
  capTradePnlByEquity,
  compactDateLabel,
  computeNumericStats,
  computePositionSizingByBalanceRatio,
  computePositionValueByBalanceRatio,
  mergeTimedDeltas,
  resolveTradeWindow,
  selectCashFlowEventsForEquity,
} from "../backtest.js";
import type {
  AddressRow,
  CashFlowEventRow,
  TimedPnlRow,
  TradeRow,
} from "../lib/types.js";
import type Database from "better-sqlite3";

const TEST_DB = "./test_backtest.sqlite";
const TEST_GROUP = "test-group";

function cleanup() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = TEST_DB + suffix;
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
}

describe("backtest address stats", () => {
  let db: Database.Database;

  beforeEach(() => {
    cleanup();
    db = initDatabase(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  function seedAddress(address: string): void {
    const row: AddressRow = {
      address,
      group_name: TEST_GROUP,
      discovered_at: "2026-01-01",
      account_balance: 3000,
      raw_json: "{}",
    };
    insertAddresses(db, [row]);
  }

  function seedTrade(address: string, openTime: number, pnl: number): void {
    const row: TradeRow = {
      address,
      coin: "BTC",
      side: pnl > 0 ? "short" : "long",
      entry_price: 50000,
      exit_price: pnl > 0 ? 49000 : 51000,
      size: 0.1,
      pnl,
      pnl_percent: pnl / 5000,
      open_time: openTime,
      close_time: openTime + 7200000,
      raw_json: "{}",
    };
    insertTrades(db, [row]);
  }

  it("should aggregate weak-performance address metrics", () => {
    seedAddress("0xdumb000000000000000000000000000000000000");

    const baseTime = new Date("2025-11-01").getTime();
    for (let index = 0; index < 10; index++) {
      seedTrade(
        "0xdumb000000000000000000000000000000000000",
        baseTime + index * 86400000,
        -1000,
      );
    }
    seedTrade(
      "0xdumb000000000000000000000000000000000000",
      baseTime + 10 * 86400000,
      200,
    );
    seedTrade(
      "0xdumb000000000000000000000000000000000000",
      baseTime + 11 * 86400000,
      100,
    );

    const screenStart = new Date("2025-11-01").getTime();
    const screenEnd = new Date("2025-12-31").getTime();

    const stats = computeAddressStats(db, TEST_GROUP, screenStart, screenEnd);
    expect(stats.length).toBe(1);

    const item = stats[0];
    expect(item.totalPnl).toBe(-9700);
    expect(item.winRate).toBeCloseTo(2 / 12);
    expect(item.tradeCount).toBe(12);
    expect(item.profitFactor).toBeCloseTo(0.03);

    expect(item.totalPnl <= -5000).toBe(true);
    expect(item.winRate < 0.4).toBe(true);
    expect(item.tradeCount >= 3).toBe(true);
    expect(item.profitFactor < 0.5).toBe(true);
  });

  it("should keep positive-pnl address outside weak-performance threshold", () => {
    seedAddress("0xgood000000000000000000000000000000000000");

    const baseTime = new Date("2025-11-01").getTime();
    for (let index = 0; index < 5; index++) {
      seedTrade(
        "0xgood000000000000000000000000000000000000",
        baseTime + index * 86400000,
        2000,
      );
    }
    seedTrade(
      "0xgood000000000000000000000000000000000000",
      baseTime + 5 * 86400000,
      -500,
    );

    const stats = computeAddressStats(
      db,
      TEST_GROUP,
      new Date("2025-11-01").getTime(),
      new Date("2025-12-31").getTime(),
    );
    const item = stats[0];

    expect(item.totalPnl).toBe(9500);
    expect(item.totalPnl <= -5000).toBe(false);
  });
});

describe("reverse trade simulation", () => {
  it("should reverse long to short and compute correct PnL", () => {
    const slippage = 0.001;
    const entryPrice = 50000;
    const exitPrice = 48000;
    const size = 0.1;
    const accountBalance = 10000;
    const allocatedCapital = 50000;
    const positionValue = computePositionValueByBalanceRatio(
      entryPrice * size,
      accountBalance,
      allocatedCapital,
      100,
    );

    const myEntry = entryPrice * (1 - slippage);
    const myExit = exitPrice * (1 + slippage);
    const mySize = positionValue / myEntry;
    const pnl = (myEntry - myExit) * mySize;

    expect(pnl).toBeGreaterThan(0);
    expect(pnl).toBeCloseTo(952, 0);
  });

  it("should reverse short to long and compute correct PnL", () => {
    const slippage = 0.001;
    const entryPrice = 3000;
    const exitPrice = 3200;
    const size = 1;
    const accountBalance = 12000;
    const allocatedCapital = 60000;
    const positionValue = computePositionValueByBalanceRatio(
      entryPrice * size,
      accountBalance,
      allocatedCapital,
      100,
    );

    const myEntry = entryPrice * (1 + slippage);
    const myExit = exitPrice * (1 - slippage);
    const mySize = positionValue / myEntry;
    const pnl = (myExit - myEntry) * mySize;

    expect(pnl).toBeGreaterThan(0);
  });
});

describe("account allocation and sizing", () => {
  it("should allocate capital equally among addresses with positive balances", () => {
    const result = buildEqualWeightAllocations(
      ["0xa", "0xb", "0xc"],
      [
        { address: "0xa", account_balance: 1000 },
        { address: "0xb", account_balance: 2000 },
      ],
      90000,
      100,
    );

    expect(result.allocations.size).toBe(2);
    expect(result.skippedAddressCount).toBe(1);
    expect(result.allocations.get("0xa")?.allocatedCapital).toBe(45000);
    expect(result.allocations.get("0xb")?.allocatedCapital).toBe(45000);
    expect(result.allocations.get("0xa")?.accountBalance).toBe(1000);
    expect(result.allocations.get("0xb")?.accountBalance).toBe(2000);
    expect(result.missingBalanceCount).toBe(1);
    expect(result.lowEquityCount).toBe(0);
  });

  it("should scale position by original position / account balance ratio", () => {
    const positionValue = computePositionValueByBalanceRatio(
      800,
      4000,
      50000,
      10,
    );
    expect(positionValue).toBe(10000);
  });

  it("should cap position ratio by max_notional_ratio", () => {
    const positionValue = computePositionValueByBalanceRatio(
      20000,
      100,
      50000,
      5,
    );
    expect(positionValue).toBe(250000);
  });

  it("should report notional ratio clipping details", () => {
    const sizing = computePositionSizingByBalanceRatio(20000, 100, 50000, 5);
    expect(sizing.positionValue).toBe(250000);
    expect(sizing.originalNotionalRatio).toBe(200);
    expect(sizing.safeNotionalRatio).toBe(5);
    expect(sizing.isNotionalRatioClipped).toBe(true);
  });

  it("should filter out low-equity accounts by min_equity", () => {
    const result = buildEqualWeightAllocations(
      ["0xa", "0xb"],
      [
        { address: "0xa", account_balance: 50 },
        { address: "0xb", account_balance: 200 },
      ],
      100000,
      100,
    );
    expect(result.allocations.size).toBe(1);
    expect(result.allocations.get("0xb")?.allocatedCapital).toBe(100000);
    expect(result.skippedAddressCount).toBe(1);
    expect(result.missingBalanceCount).toBe(0);
    expect(result.lowEquityCount).toBe(1);
  });
});

describe("equity at open resolver", () => {
  it("should use api events inside api range and inferred outside", () => {
    const selected = selectCashFlowEventsForEquity([
      {
        event_time: 800,
        amount: 5,
        source: "inferred_equity_delta",
      },
      {
        event_time: 1000,
        amount: 10,
        source: "inferred_equity_delta",
      },
      {
        event_time: 1100,
        amount: -2,
        source: "api_user_non_funding_ledger_updates",
      },
      {
        event_time: 1200,
        amount: 3,
        source: "inferred_equity_delta",
      },
      {
        event_time: 1500,
        amount: -1,
        source: "api_user_non_funding_ledger_updates",
      },
      {
        event_time: 1800,
        amount: 7,
        source: "inferred_equity_delta",
      },
    ] as CashFlowEventRow[]);

    expect(selected).toEqual([
      { event_time: 800, amount: 5, source: "inferred_equity_delta" },
      { event_time: 1000, amount: 10, source: "inferred_equity_delta" },
      { event_time: 1100, amount: -2, source: "api_user_non_funding_ledger_updates" },
      { event_time: 1500, amount: -1, source: "api_user_non_funding_ledger_updates" },
      { event_time: 1800, amount: 7, source: "inferred_equity_delta" },
    ]);
  });

  it("should use all inferred events when no api events exist", () => {
    const events = [
      { event_time: 1000, amount: 10, source: "inferred_equity_delta" },
      { event_time: 2000, amount: -5, source: "inferred_equity_delta" },
    ] as CashFlowEventRow[];

    expect(selectCashFlowEventsForEquity(events)).toEqual(events);
  });

  it("should merge realized pnl and cash flow deltas by event time", () => {
    const deltas = mergeTimedDeltas(
      [
        { event_time: 1000, pnl: 20 },
        { event_time: 1200, pnl: -5 },
      ] as TimedPnlRow[],
      [
        { event_time: 1000, amount: -3, source: "api" },
        { event_time: 1300, amount: 8, source: "api" },
      ] as CashFlowEventRow[],
    );

    expect(deltas).toEqual([
      { eventTime: 1000, delta: 17 },
      { eventTime: 1200, delta: -5 },
      { eventTime: 1300, delta: 8 },
    ]);
  });

  it("should reconstruct equity before and after anchor time without lookahead", () => {
    const resolve = buildEquityAtOpenResolver(200, 3000, [
      { eventTime: 1000, delta: 20 },
      { eventTime: 2000, delta: 30 },
      { eventTime: 2500, delta: -10 },
      { eventTime: 3500, delta: 40 },
    ]);

    expect(resolve(1500)).toBe(180);
    expect(resolve(3000)).toBe(200);
    expect(resolve(3600)).toBe(240);
  });
});

describe("numeric stats", () => {
  it("should return null for empty input", () => {
    expect(computeNumericStats([])).toBeNull();
  });

  it("should compute min/median/p95/max/mean", () => {
    expect(computeNumericStats([1, 2, 3, 4, 5, 100])).toEqual({
      min: 1,
      median: 3,
      p95: 5,
      max: 100,
      mean: 19.166666666666668,
    });
  });
});

describe("real equity guard", () => {
  it("should cap loss by available equity", () => {
    expect(capTradePnlByEquity(-150, 100)).toBe(-100);
    expect(capTradePnlByEquity(-50, 100)).toBe(-50);
    expect(capTradePnlByEquity(30, 100)).toBe(30);
  });
});

describe("trade window resolve", () => {
  it("should default start to earliest discovered_at and end to now", () => {
    const nowMs = Date.parse("2026-03-11T10:20:30.000Z");
    const window = resolveTradeWindow(
      "2026-01-15",
      undefined,
      undefined,
      nowMs,
    );

    expect(window.tradeStartText).toBe("2026-01-15");
    expect(window.tradeStartMs).toBe(Date.parse("2026-01-15T00:00:00.000Z"));
    expect(window.tradeEndText).toBe("2026-03-11T10:20:30.000Z");
    expect(window.tradeEndMs).toBe(nowMs);
  });

  it("should parse provided trade-start and trade-end", () => {
    const nowMs = Date.parse("2026-03-11T10:20:30.000Z");
    const window = resolveTradeWindow(
      "2026-01-15",
      "2026-02-01",
      "2026-02-28",
      nowMs,
    );

    expect(window.tradeStartText).toBe("2026-02-01");
    expect(window.tradeStartMs).toBe(Date.parse("2026-02-01T00:00:00.000Z"));
    expect(window.tradeEndText).toBe("2026-02-28");
    expect(window.tradeEndMs).toBe(Date.parse("2026-02-28T23:59:59.999Z"));
  });

  it("should reject invalid trade-start format", () => {
    expect(() =>
      resolveTradeWindow("2026-01-15", "2026/02/01", undefined, Date.now()),
    ).toThrow("--trade-start 格式无效");
  });

  it("should reject invalid trade window order", () => {
    expect(() =>
      resolveTradeWindow(
        "2026-01-15",
        "2026-03-10",
        "2026-03-01",
        Date.parse("2026-03-11T10:20:30.000Z"),
      ),
    ).toThrow("交易窗口无效");
  });

  it("should compact iso datetime label to date", () => {
    expect(compactDateLabel("2026-03-11T10:20:30.000Z")).toBe("2026-03-11");
    expect(compactDateLabel("2026-03-11")).toBe("2026-03-11");
  });
});
