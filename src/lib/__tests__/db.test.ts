import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import {
  countAccountSnapshots,
  countCashFlows,
  computeAddressStats,
  countAddresses,
  countTrades,
  getCashFlowEventsForAddressInRange,
  getAddressDiscoveryStartsByGroup,
  getCrawlProgress,
  getCrawlProgressByTask,
  getDistinctAddressesByGroup,
  getLatestAccountSnapshot,
  getLatestPositiveAccountBalancesByGroup,
  getLatestPositiveSnapshotAnchorsByGroup,
  getLatestPositiveSnapshotBalancesByGroup,
  getRealizedPnlEventsForAddressInRange,
  getTradesForAddressInRange,
  getTradesInRange,
  initDatabase,
  insertAccountSnapshots,
  insertAddresses,
  insertCashFlows,
  insertTrades,
  sumRealizedPnlForAddressInRange,
  updateCrawlProgress,
  updateCrawlProgressByTask,
} from "../db.js";
import type {
  AccountSnapshotRow,
  AddressRow,
  CashFlowRow,
  TradeRow,
} from "../types.js";
import type Database from "better-sqlite3";

const TEST_DB = "./test_db.sqlite";

function cleanup() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = TEST_DB + suffix;
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
}

describe("db", () => {
  let db: Database.Database;

  beforeEach(() => {
    cleanup();
    db = initDatabase(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  const makeAddress = (
    address: string,
    groupName: string,
    discoveredAt = "2026-03-07",
  ): AddressRow => ({
    address,
    group_name: groupName,
    discovered_at: discoveredAt,
    account_balance: 5000,
    raw_json: "{}",
  });

  const makeTrade = (
    address: string,
    coin: string,
    openTime: number,
    pnl: number,
  ): TradeRow => ({
    address,
    coin,
    side: pnl > 0 ? "short" : "long",
    entry_price: 100,
    exit_price: pnl > 0 ? 90 : 110,
    size: 1,
    pnl,
    pnl_percent: pnl,
    open_time: openTime,
    close_time: openTime + 3600000,
    raw_json: "{}",
  });

  const makeSnapshot = (
    address: string,
    snapshotTime: number,
    totalValue: number,
  ): AccountSnapshotRow => ({
    address,
    snapshot_time: snapshotTime,
    total_value: totalValue,
    perp_value: null,
    spot_value: totalValue,
    raw_json: "{}",
  });

  const makeCashFlow = (
    address: string,
    eventTime: number,
    amount: number,
  ): CashFlowRow => ({
    address,
    event_time: eventTime,
    amount,
    direction: amount >= 0 ? "in" : "out",
    source: "inferred_equity_delta",
    pnl_component: 0,
    equity_delta: amount,
    raw_json: "{}",
  });

  describe("insertAddresses", () => {
    it("should insert new addresses", () => {
      const rows = [
        makeAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "g1"),
        makeAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "g1"),
      ];
      const inserted = insertAddresses(db, rows);
      expect(inserted).toBe(2);
      expect(countAddresses(db)).toBe(2);
      expect(countAddresses(db, "g1")).toBe(2);
    });

    it("should deduplicate on address+group+date", () => {
      const row = makeAddress(
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "g1",
      );
      insertAddresses(db, [row]);
      const inserted = insertAddresses(db, [row]);
      expect(inserted).toBe(0);
      expect(countAddresses(db, "g1")).toBe(1);
    });

    it("should allow same address in different groups", () => {
      const addr = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      insertAddresses(db, [makeAddress(addr, "g1")]);
      const inserted = insertAddresses(db, [makeAddress(addr, "g2")]);
      expect(inserted).toBe(1);
      expect(countAddresses(db, "g1")).toBe(1);
      expect(countAddresses(db, "g2")).toBe(1);
    });
  });

  describe("getDistinctAddressesByGroup", () => {
    it("should return unique addresses inside group", () => {
      insertAddresses(db, [
        makeAddress(
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "g1",
          "2026-03-01",
        ),
        makeAddress(
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "g1",
          "2026-03-02",
        ),
        makeAddress(
          "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "g1",
          "2026-03-01",
        ),
        makeAddress(
          "0xcccccccccccccccccccccccccccccccccccccccc",
          "g2",
          "2026-03-01",
        ),
      ]);

      const g1 = getDistinctAddressesByGroup(db, "g1").sort();
      const g2 = getDistinctAddressesByGroup(db, "g2").sort();

      expect(g1).toEqual([
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ]);
      expect(g2).toEqual(["0xcccccccccccccccccccccccccccccccccccccccc"]);
    });
  });

  describe("getAddressDiscoveryStartsByGroup", () => {
    it("should return earliest discovered_at per address", () => {
      insertAddresses(db, [
        makeAddress(
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "g1",
          "2026-03-05",
        ),
        makeAddress(
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "g1",
          "2026-02-01",
        ),
        makeAddress(
          "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "g1",
          "2026-03-02",
        ),
      ]);

      const starts = getAddressDiscoveryStartsByGroup(db, "g1").sort((a, b) =>
        a.address.localeCompare(b.address),
      );
      expect(starts).toEqual([
        {
          address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          earliest_discovered_at: "2026-02-01",
        },
        {
          address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          earliest_discovered_at: "2026-03-02",
        },
      ]);
    });
  });

  describe("getLatestPositiveAccountBalancesByGroup", () => {
    it("should return latest positive balance per address", () => {
      insertAddresses(db, [
        {
          ...makeAddress(
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "g1",
            "2026-03-01",
          ),
          account_balance: 1000,
        },
        {
          ...makeAddress(
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "g1",
            "2026-03-02",
          ),
          account_balance: 1200,
        },
        {
          ...makeAddress(
            "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "g1",
            "2026-03-01",
          ),
          account_balance: null,
        },
        {
          ...makeAddress(
            "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "g1",
            "2026-03-03",
          ),
          account_balance: 800,
        },
        {
          ...makeAddress(
            "0xcccccccccccccccccccccccccccccccccccccccc",
            "g1",
            "2026-03-04",
          ),
          account_balance: -10,
        },
        {
          ...makeAddress(
            "0xdddddddddddddddddddddddddddddddddddddddd",
            "g2",
            "2026-03-05",
          ),
          account_balance: 9999,
        },
      ]);

      const rows = getLatestPositiveAccountBalancesByGroup(db, "g1").sort(
        (left, right) => left.address.localeCompare(right.address),
      );
      expect(rows).toEqual([
        {
          address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          account_balance: 1200,
        },
        {
          address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          account_balance: 800,
        },
      ]);
    });
  });

  describe("account snapshots", () => {
    it("should insert snapshots and deduplicate by address+time", () => {
      const snapshot = makeSnapshot(
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        1000,
        123.45,
      );
      expect(insertAccountSnapshots(db, [snapshot])).toBe(1);
      expect(insertAccountSnapshots(db, [snapshot])).toBe(0);
      expect(countAccountSnapshots(db)).toBe(1);
    });

    it("should return latest snapshot per address", () => {
      const address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      insertAccountSnapshots(db, [
        makeSnapshot(address, 1000, 100),
        makeSnapshot(address, 2000, 200),
      ]);

      const latest = getLatestAccountSnapshot(db, address);
      expect(latest?.snapshot_time).toBe(2000);
      expect(latest?.total_value).toBe(200);
    });

    it("should return latest positive snapshot balance for addresses in group", () => {
      const a1 = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const a2 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      insertAddresses(db, [makeAddress(a1, "g1"), makeAddress(a2, "g1")]);
      insertAccountSnapshots(db, [
        makeSnapshot(a1, 1000, 100),
        makeSnapshot(a1, 2000, 120),
        makeSnapshot(a2, 1000, -1),
        makeSnapshot(a2, 2000, 0),
      ]);

      const rows = getLatestPositiveSnapshotBalancesByGroup(db, "g1");
      expect(rows).toEqual([{ address: a1, account_balance: 120 }]);
    });

    it("should return latest positive snapshot anchors with time", () => {
      const address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      insertAddresses(db, [makeAddress(address, "g1")]);
      insertAccountSnapshots(db, [
        makeSnapshot(address, 1000, 80),
        makeSnapshot(address, 2000, 120),
      ]);

      const rows = getLatestPositiveSnapshotAnchorsByGroup(db, "g1");
      expect(rows).toEqual([
        { address, account_balance: 120, anchor_time: 2000 },
      ]);
    });

  });

  describe("cash flows", () => {
    it("should insert cash flows and deduplicate by address+time+source", () => {
      const flow = makeCashFlow(
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        3000,
        50,
      );
      expect(insertCashFlows(db, [flow])).toBe(1);
      expect(insertCashFlows(db, [flow])).toBe(0);
      expect(countCashFlows(db)).toBe(1);
    });

    it("should return cash flow events in range ordered by time", () => {
      const address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      insertCashFlows(db, [
        makeCashFlow(address, 3000, 50),
        makeCashFlow(address, 1000, -10),
        makeCashFlow(address, 2000, 20),
      ]);

      const rows = getCashFlowEventsForAddressInRange(db, address, 1000, 3000);
      expect(rows).toEqual([
        { event_time: 1000, amount: -10, source: "inferred_equity_delta" },
        { event_time: 2000, amount: 20, source: "inferred_equity_delta" },
        { event_time: 3000, amount: 50, source: "inferred_equity_delta" },
      ]);
    });
  });

  describe("insertTrades", () => {
    it("should insert and deduplicate trades", () => {
      const trade = makeTrade(
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "BTC",
        1000000,
        -500,
      );
      expect(insertTrades(db, [trade])).toBe(1);
      expect(insertTrades(db, [trade])).toBe(0);
      expect(countTrades(db)).toBe(1);
    });
  });

  describe("getTradesInRange", () => {
    it("should filter by close_time range", () => {
      insertTrades(db, [
        makeTrade(
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "BTC",
          1000000,
          100,
        ),
        makeTrade(
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "ETH",
          10000000,
          -200,
        ),
        makeTrade(
          "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "BTC",
          20000000,
          50,
        ),
      ]);

      const trades = getTradesInRange(db, 5000000, 15000000);
      expect(trades.length).toBe(1);
      expect(trades[0].coin).toBe("ETH");
    });
  });

  describe("getTradesForAddressInRange", () => {
    it("should filter by address and close_time range", () => {
      insertTrades(db, [
        makeTrade(
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "BTC",
          1000,
          100,
        ),
        makeTrade(
          "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "BTC",
          1000,
          -200,
        ),
      ]);
      const trades = getTradesForAddressInRange(
        db,
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        0,
        99999999,
      );
      expect(trades.length).toBe(1);
      expect(trades[0].address).toBe(
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      );
    });
  });

  describe("sumRealizedPnlForAddressInRange", () => {
    it("should sum pnl in exclusive-inclusive range", () => {
      const address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      insertTrades(db, [
        makeTrade(address, "BTC", 1000, 100),
        makeTrade(address, "ETH", 5000, -30),
        makeTrade(address, "SOL", 9000, 50),
      ]);

      const sum = sumRealizedPnlForAddressInRange(
        db,
        address,
        3601000,
        3605000,
      );
      expect(sum).toBe(-30);
    });

    it("should return realized pnl events in range ordered by close_time", () => {
      const address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      insertTrades(db, [
        makeTrade(address, "BTC", 1000, 100),
        makeTrade(address, "ETH", 5000, -30),
      ]);

      const events = getRealizedPnlEventsForAddressInRange(
        db,
        address,
        0,
        7000000,
      );
      expect(events).toEqual([
        { event_time: 3601000, pnl: 100 },
        { event_time: 3605000, pnl: -30 },
      ]);
    });
  });

  describe("crawl progress", () => {
    it("should return null for unknown address", () => {
      expect(getCrawlProgress(db, "g1", "0xunknown")).toBeNull();
    });

    it("should store and retrieve scan range by group", () => {
      updateCrawlProgress(
        db,
        "g1",
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        123456,
        234567,
      );
      expect(
        getCrawlProgress(
          db,
          "g1",
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ),
      ).toEqual({ firstScannedTime: 123456, lastScannedTime: 234567 });
      expect(
        getCrawlProgress(
          db,
          "g2",
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ),
      ).toBeNull();
    });

    it("should update existing scan range", () => {
      updateCrawlProgress(
        db,
        "g1",
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        100,
        200,
      );
      updateCrawlProgress(
        db,
        "g1",
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        50,
        300,
      );
      expect(
        getCrawlProgress(
          db,
          "g1",
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ),
      ).toEqual({ firstScannedTime: 50, lastScannedTime: 300 });
    });

    it("should isolate progress by task", () => {
      const address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      updateCrawlProgressByTask(db, "g1", address, "trades", 100, 200);
      updateCrawlProgressByTask(
        db,
        "g1",
        address,
        "account_snapshots",
        300,
        300,
      );

      expect(getCrawlProgress(db, "g1", address)).toEqual({
        firstScannedTime: 100,
        lastScannedTime: 200,
      });
      expect(
        getCrawlProgressByTask(db, "g1", address, "account_snapshots"),
      ).toEqual({
        firstScannedTime: 300,
        lastScannedTime: 300,
      });
    });
  });

  describe("computeAddressStats", () => {
    it("should aggregate stats only for addresses in group", () => {
      const g1Addr = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const g2Addr = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

      insertAddresses(db, [
        makeAddress(g1Addr, "g1"),
        makeAddress(g2Addr, "g2"),
      ]);

      insertTrades(db, [
        makeTrade(g1Addr, "BTC", 1000, 500),
        makeTrade(g1Addr, "ETH", 2000, -300),
        makeTrade(g1Addr, "SOL", 3000, -200),
        makeTrade(g2Addr, "BTC", 1000, 9999),
      ]);

      const stats = computeAddressStats(db, "g1", 0, 99999999);
      expect(stats.length).toBe(1);

      const item = stats[0];
      expect(item.address).toBe(g1Addr);
      expect(item.totalPnl).toBe(0);
      expect(item.tradeCount).toBe(3);
      expect(item.winRate).toBeCloseTo(1 / 3);
      expect(item.profitFactor).toBe(1);
    });

    it("should handle address with only losses", () => {
      const address = "0xbad0000000000000000000000000000000000000";
      insertAddresses(db, [makeAddress(address, "g1")]);
      insertTrades(db, [
        makeTrade(address, "BTC", 1000, -100),
        makeTrade(address, "ETH", 2000, -200),
      ]);

      const stats = computeAddressStats(db, "g1", 0, 99999999);
      expect(stats[0].profitFactor).toBe(0);
      expect(stats[0].winRate).toBe(0);
    });
  });
});
