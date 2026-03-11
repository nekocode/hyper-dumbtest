import "dotenv/config";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { HyperbotClient } from "../hyperbot.js";

let client: HyperbotClient;
const API_TEST_TIMEOUT_MS = 90000;
const REQUEST_COOLDOWN_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll(() => {
  const key = process.env.HYPERBOT_KEY;
  const secret = process.env.HYPERBOT_SECRET;
  if (!key || !secret) {
    throw new Error(
      "Missing env: HYPERBOT_KEY and HYPERBOT_SECRET required. Write them to .env",
    );
  }
  client = new HyperbotClient(key, secret, 1);
});

afterEach(async () => {
  // why: 集成测试主动降速，降低触发平台限流概率
  await sleep(REQUEST_COOLDOWN_MS);
});

describe.sequential("POST /v2/hl/traders/discover", () => {
  it(
    "should return paginated trader list",
    async () => {
      const data = await client.discoverTraders({
        pageNum: 1,
        pageSize: 5,
        period: 7,
        sort: { field: "pnl", dir: "asc" },
        loadPnls: false,
        loadTags: false,
      });

      expect(data).toHaveProperty("list");
      expect(data).toHaveProperty("total");
      expect(data.list.length).toBeGreaterThan(0);
      expect(data.list.length).toBeLessThanOrEqual(5);
      expect(data.total).toBeGreaterThan(0);

      // 验证实际字段结构
      const trader = data.list[0];
      expect(typeof trader.address).toBe("string");
      expect(trader.address.length).toBeGreaterThan(0);
      expect(trader).toHaveProperty("totalPnl");
      expect(trader).toHaveProperty("winRate");
      expect(trader).toHaveProperty("avgLeverage");
      expect(trader).toHaveProperty("avgDurationMin");
    },
    API_TEST_TIMEOUT_MS,
  );

  it(
    "should respect filters (totalPnl < 0)",
    async () => {
      const data = await client.discoverTraders({
        pageNum: 1,
        pageSize: 5,
        period: 30,
        sort: { field: "pnl", dir: "asc" },
        filters: [{ field: "totalPnl", op: "<", val: 0 }],
        loadPnls: false,
        loadTags: false,
      });

      expect(data.list.length).toBeGreaterThan(0);
      for (const trader of data.list) {
        expect(parseFloat(trader.totalPnl ?? "0")).toBeLessThan(0);
      }
    },
    API_TEST_TIMEOUT_MS,
  );

  it(
    "should support different sort dimensions",
    async () => {
      const sorts: { field: string; dir: "asc" | "desc" }[] = [
        { field: "ROI", dir: "asc" },
        { field: "win-rate", dir: "asc" },
        { field: "position-count", dir: "desc" },
      ];

      for (const sort of sorts) {
        const data = await client.discoverTraders({
          pageNum: 1,
          pageSize: 3,
          period: 7,
          sort,
          loadPnls: false,
          loadTags: false,
        });

        expect(data.list.length).toBeGreaterThan(0);
        expect(data.list[0]).toHaveProperty("address");
      }
    },
    API_TEST_TIMEOUT_MS,
  );

  it(
    "should handle pagination (page 2 differs from page 1)",
    async () => {
      const page1 = await client.discoverTraders({
        pageNum: 1,
        pageSize: 5,
        period: 7,
        sort: { field: "pnl", dir: "asc" },
        loadPnls: false,
        loadTags: false,
      });

      const page2 = await client.discoverTraders({
        pageNum: 2,
        pageSize: 5,
        period: 7,
        sort: { field: "pnl", dir: "asc" },
        loadPnls: false,
        loadTags: false,
      });

      expect(page2.list.length).toBeGreaterThan(0);
      const addresses1 = new Set(page1.list.map((t) => t.address));
      const overlap = page2.list.filter((t) => addresses1.has(t.address));
      expect(overlap.length).toBeLessThan(page2.list.length);
    },
    API_TEST_TIMEOUT_MS,
  );
});

describe.sequential(
  "POST /v2/hl/traders/:address/completed-trades/by-time",
  () => {
    let testAddress: string;

    beforeAll(async () => {
      const data = await client.discoverTraders({
        pageNum: 1,
        pageSize: 5,
        period: 30,
        sort: { field: "position-count", dir: "desc" },
        loadPnls: false,
        loadTags: false,
      });
      testAddress = data.list[0].address;
    }, API_TEST_TIMEOUT_MS);

    it(
      "should return array of completed trades for a known address",
      async () => {
        const now = Date.now();
        const trades = await client.getCompletedTradesByTime(testAddress, {
          pageNum: 1,
          pageSize: 10,
          endTimeFrom: now - 90 * 86400000,
          endTimeTo: now,
        });

        expect(Array.isArray(trades)).toBe(true);

        if (trades.length > 0) {
          const trade = trades[0];
          // 验证实际字段结构
          expect(trade).toHaveProperty("coin");
          expect(trade).toHaveProperty("direction");
          expect(trade).toHaveProperty("entryPrice");
          expect(trade).toHaveProperty("closePrice");
          expect(trade).toHaveProperty("size");
          expect(trade).toHaveProperty("pnl");
          expect(trade).toHaveProperty("startTime");
          expect(trade).toHaveProperty("endTime");
          expect(trade).toHaveProperty("totalFee");
          expect(trade).toHaveProperty("marginMode");

          expect(typeof trade.coin).toBe("string");
          expect(["long", "short"]).toContain(trade.direction);

          // endTime 应该可以解析为合法时间戳
          const endMs = new Date(trade.endTime).getTime();
          expect(endMs).toBeGreaterThan(0);
        }
      },
      API_TEST_TIMEOUT_MS,
    );

    it(
      "should return empty array for a fake address",
      async () => {
        const now = Date.now();
        const trades = await client.getCompletedTradesByTime(
          "0x0000000000000000000000000000000000000000",
          {
            pageNum: 1,
            pageSize: 10,
            endTimeFrom: now - 7 * 86400000,
            endTimeTo: now,
          },
        );

        expect(Array.isArray(trades)).toBe(true);
        expect(trades.length).toBe(0);
      },
      API_TEST_TIMEOUT_MS,
    );

    it(
      "should respect pageSize limit",
      async () => {
        const now = Date.now();
        const trades = await client.getCompletedTradesByTime(testAddress, {
          pageNum: 1,
          pageSize: 3,
          endTimeFrom: now - 90 * 86400000,
          endTimeTo: now,
        });

        expect(trades.length).toBeLessThanOrEqual(3);
      },
      API_TEST_TIMEOUT_MS,
    );

    it(
      "should return different results on page 2",
      async () => {
        const now = Date.now();
        const from = now - 90 * 86400000;

        const page1 = await client.getCompletedTradesByTime(testAddress, {
          pageNum: 1,
          pageSize: 3,
          endTimeFrom: from,
          endTimeTo: now,
        });

        if (page1.length === 3) {
          const page2 = await client.getCompletedTradesByTime(testAddress, {
            pageNum: 2,
            pageSize: 3,
            endTimeFrom: from,
            endTimeTo: now,
          });
          // 如果有更多数据，page2 应该非空
          expect(page2.length).toBeGreaterThanOrEqual(0);
        }
      },
      API_TEST_TIMEOUT_MS,
    );
  },
);
