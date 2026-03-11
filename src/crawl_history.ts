import "dotenv/config";
import { program } from "commander";
import { HyperbotClient } from "./lib/hyperbot.js";
import {
  countAccountSnapshots,
  countCashFlows,
  countTrades,
  getAddressDiscoveryStartsByGroup,
  getCrawlProgressByTask,
  getLatestAccountSnapshot,
  initDatabase,
  insertAccountSnapshots,
  insertCashFlows,
  insertTrades,
  sumRealizedPnlForAddressInRange,
  updateCrawlProgressByTask,
} from "./lib/db.js";
import {
  toApiNonFundingCashFlowRow,
  toInferredCashFlowRow,
} from "./lib/cash_flows.js";
import { log } from "./lib/logger.js";
import { normalizeAddress, parseFiniteNumber } from "./lib/utils.js";
import type {
  AccountSnapshotRow,
  CashFlowRow,
  CompletedTrade,
  NonFundingLedgerUpdate,
  TradeRow,
  TraderAccount,
} from "./lib/types.js";

const MAX_PAGE = 50;
const PAGE_SIZE = 2000;
const ACCOUNT_BATCH_SIZE = 50;

interface CrawlRangeResult {
  inserted: number;
  fetched: number;
  completed: boolean;
}

interface SyncSnapshotFlowResult {
  snapshotInserted: number;
  inferredCashFlowInserted: number;
  apiCashFlowInserted: number;
}

function toTradeRow(address: string, trade: CompletedTrade): TradeRow {
  const entryPrice = parseFloat(trade.entryPrice);
  const closePrice = parseFloat(trade.closePrice);
  const size = parseFloat(trade.size);
  const pnl = parseFloat(trade.pnl);
  const positionValue = entryPrice * size;

  return {
    address,
    coin: trade.coin,
    side: trade.direction,
    entry_price: entryPrice,
    exit_price: closePrice,
    size,
    pnl,
    pnl_percent: positionValue > 0 ? (pnl / positionValue) * 100 : 0,
    open_time: new Date(trade.startTime).getTime(),
    close_time: new Date(trade.endTime).getTime(),
    raw_json: JSON.stringify(trade),
  };
}

function toAccountSnapshotRow(
  address: string,
  snapshotTime: number,
  account: TraderAccount | null,
): AccountSnapshotRow {
  return {
    address,
    snapshot_time: snapshotTime,
    total_value: parseFiniteNumber(account?.totalValue),
    perp_value: parseFiniteNumber(account?.perpValue),
    spot_value: parseFiniteNumber(account?.spotValue),
    raw_json: JSON.stringify(account ?? {}),
  };
}

function parseDiscoveredAtStartMs(
  discoveredAt: string,
  address: string,
): number {
  const ms = new Date(`${discoveredAt}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`${address} 的 discovered_at 无效: ${discoveredAt}`);
  }
  return ms;
}

function updateTaskProgress(
  db: ReturnType<typeof initDatabase>,
  groupName: string,
  address: string,
  task: string,
  timestamp: number,
): void {
  const previous = getCrawlProgressByTask(db, groupName, address, task);
  const firstScannedTime = previous?.firstScannedTime ?? timestamp;
  updateCrawlProgressByTask(
    db,
    groupName,
    address,
    task,
    firstScannedTime,
    timestamp,
  );
}

async function crawlTradesInRange(
  client: HyperbotClient,
  db: ReturnType<typeof initDatabase>,
  groupName: string,
  address: string,
  rangeStartMs: number,
  rangeEndMs: number,
  tag: "backfill" | "forward" | "full",
): Promise<CrawlRangeResult> {
  let insertedTotal = 0;
  let fetchedTotal = 0;

  for (let page = 1; page <= MAX_PAGE; page++) {
    try {
      const trades = await client.getCompletedTradesByTime(address, {
        pageNum: page,
        pageSize: PAGE_SIZE,
        endTimeFrom: rangeStartMs,
        endTimeTo: rangeEndMs,
      });

      if (!trades || trades.length === 0) {
        return {
          inserted: insertedTotal,
          fetched: fetchedTotal,
          completed: true,
        };
      }

      const rows = trades.map((item) => toTradeRow(address, item));
      const inserted = insertTrades(db, rows);
      insertedTotal += inserted;
      fetchedTotal += trades.length;

      log.info(
        "crawl_history",
        `group=${groupName} ${address} 交易/${tag} 页=${page} 拉取=${trades.length} 入库=${inserted}`,
      );

      if (page === MAX_PAGE) {
        log.warn(
          "crawl_history",
          `group=${groupName} ${address} 交易/${tag} 已达最大可访问页=${MAX_PAGE}`,
        );
      }

      if (trades.length < PAGE_SIZE) {
        return {
          inserted: insertedTotal,
          fetched: fetchedTotal,
          completed: true,
        };
      }
    } catch (error) {
      log.error(
        "crawl_history",
        `group=${groupName} ${address} 交易/${tag} 区间 ${rangeStartMs}~${rangeEndMs} 失败`,
        { error },
      );
      return {
        inserted: insertedTotal,
        fetched: fetchedTotal,
        completed: false,
      };
    }
  }

  return { inserted: insertedTotal, fetched: fetchedTotal, completed: true };
}

// why: trades 和 cash_flows_api 共用同一增量扫描状态机，抽取避免双写漂移
async function incrementalCrawl(
  db: ReturnType<typeof initDatabase>,
  groupName: string,
  address: string,
  task: string,
  discoveredStartMs: number,
  nowMs: number,
  crawlRange: (
    start: number,
    end: number,
    tag: "backfill" | "forward" | "full",
  ) => Promise<CrawlRangeResult>,
): Promise<number> {
  const progress = getCrawlProgressByTask(db, groupName, address, task);
  const firstScanned =
    progress?.firstScannedTime ?? progress?.lastScannedTime ?? null;
  const lastScanned = progress?.lastScannedTime ?? null;

  let totalInserted = 0;
  let nextFirstScanned = firstScanned;
  let nextLastScanned = lastScanned;

  if (firstScanned === null || lastScanned === null) {
    const fullResult = await crawlRange(discoveredStartMs, nowMs, "full");
    totalInserted += fullResult.inserted;
    if (fullResult.completed) {
      nextFirstScanned = discoveredStartMs;
      nextLastScanned = nowMs;
    }
  } else {
    if (discoveredStartMs < firstScanned) {
      const backfillResult = await crawlRange(
        discoveredStartMs,
        firstScanned - 1,
        "backfill",
      );
      totalInserted += backfillResult.inserted;
      if (backfillResult.completed) {
        nextFirstScanned = discoveredStartMs;
      }
    }

    if (lastScanned < nowMs) {
      const forwardResult = await crawlRange(
        lastScanned + 1,
        nowMs,
        "forward",
      );
      totalInserted += forwardResult.inserted;
      if (forwardResult.completed) {
        nextLastScanned = nowMs;
      }
    }
  }

  if (
    nextFirstScanned !== null &&
    nextLastScanned !== null &&
    (nextFirstScanned !== firstScanned || nextLastScanned !== lastScanned)
  ) {
    updateCrawlProgressByTask(
      db,
      groupName,
      address,
      task,
      nextFirstScanned,
      nextLastScanned,
    );
  }

  return totalInserted;
}

async function crawlTradesForAddress(
  client: HyperbotClient,
  db: ReturnType<typeof initDatabase>,
  groupName: string,
  address: string,
  discoveredAt: string,
  nowMs: number,
): Promise<number> {
  const discoveredStartMs = parseDiscoveredAtStartMs(discoveredAt, address);
  if (discoveredStartMs > nowMs) {
    log.warn(
      "crawl_history",
      `group=${groupName} ${address} discovered_at=${discoveredAt} 为未来日期，跳过交易`,
    );
    return 0;
  }

  return incrementalCrawl(
    db,
    groupName,
    address,
    "trades",
    discoveredStartMs,
    nowMs,
    (start, end, tag) =>
      crawlTradesInRange(client, db, groupName, address, start, end, tag),
  );
}

function toApiCashFlowRows(
  address: string,
  events: NonFundingLedgerUpdate[],
): CashFlowRow[] {
  const rows: CashFlowRow[] = [];
  for (const event of events) {
    const row = toApiNonFundingCashFlowRow(address, event);
    if (!row) {
      continue;
    }
    rows.push(row);
  }
  return rows;
}

async function crawlApiCashFlowsInRange(
  client: HyperbotClient,
  db: ReturnType<typeof initDatabase>,
  groupName: string,
  address: string,
  rangeStartMs: number,
  rangeEndMs: number,
  tag: "backfill" | "forward" | "full",
): Promise<CrawlRangeResult> {
  if (rangeStartMs > rangeEndMs) {
    return { inserted: 0, fetched: 0, completed: true };
  }

  try {
    const events = await client.getUserNonFundingLedgerUpdates(
      address,
      rangeStartMs,
      rangeEndMs,
    );
    const rows = toApiCashFlowRows(address, events);
    const inserted = rows.length > 0 ? insertCashFlows(db, rows) : 0;

    log.info(
      "crawl_history",
      `group=${groupName} ${address} 现金流API/${tag} 拉取=${events.length} 有效=${rows.length} 入库=${inserted}`,
    );

    return {
      inserted,
      fetched: events.length,
      completed: true,
    };
  } catch (error) {
    log.error(
      "crawl_history",
      `group=${groupName} ${address} 现金流API/${tag} 区间 ${rangeStartMs}~${rangeEndMs} 失败`,
      { error },
    );
    return { inserted: 0, fetched: 0, completed: false };
  }
}

async function syncApiCashFlowsForAddress(
  client: HyperbotClient,
  db: ReturnType<typeof initDatabase>,
  groupName: string,
  address: string,
  discoveredAt: string,
  nowMs: number,
): Promise<number> {
  const discoveredStartMs = parseDiscoveredAtStartMs(discoveredAt, address);
  if (discoveredStartMs > nowMs) {
    log.warn(
      "crawl_history",
      `group=${groupName} ${address} discovered_at=${discoveredAt} 为未来日期，跳过现金流API`,
    );
    return 0;
  }

  return incrementalCrawl(
    db,
    groupName,
    address,
    "cash_flows_api",
    discoveredStartMs,
    nowMs,
    (start, end, tag) =>
      crawlApiCashFlowsInRange(client, db, groupName, address, start, end, tag),
  );
}

function syncSnapshotAndFlowForAddress(
  db: ReturnType<typeof initDatabase>,
  groupName: string,
  address: string,
  snapshotTime: number,
  account: TraderAccount | null,
): SyncSnapshotFlowResult {
  const previousSnapshot = getLatestAccountSnapshot(db, address);
  const snapshotRow = toAccountSnapshotRow(address, snapshotTime, account);
  const snapshotInserted = insertAccountSnapshots(db, [snapshotRow]);
  if (snapshotInserted === 0) {
    return {
      snapshotInserted: 0,
      inferredCashFlowInserted: 0,
      apiCashFlowInserted: 0,
    };
  }

  updateTaskProgress(db, groupName, address, "account_snapshots", snapshotTime);

  const previousTotal = previousSnapshot?.total_value;
  const currentTotal = snapshotRow.total_value;
  if (
    !previousSnapshot ||
    previousTotal === null ||
    previousTotal === undefined ||
    currentTotal === null
  ) {
    return {
      snapshotInserted,
      inferredCashFlowInserted: 0,
      apiCashFlowInserted: 0,
    };
  }

  const realizedPnl = sumRealizedPnlForAddressInRange(
    db,
    address,
    previousSnapshot.snapshot_time,
    snapshotTime,
  );
  const flowRow = toInferredCashFlowRow(
    address,
    snapshotTime,
    previousTotal,
    currentTotal,
    realizedPnl,
  );
  if (!flowRow) {
    return {
      snapshotInserted,
      inferredCashFlowInserted: 0,
      apiCashFlowInserted: 0,
    };
  }

  const inferredCashFlowInserted = insertCashFlows(db, [flowRow]);
  if (inferredCashFlowInserted > 0) {
    updateTaskProgress(db, groupName, address, "cash_flows", snapshotTime);
  }
  return {
    snapshotInserted,
    inferredCashFlowInserted,
    apiCashFlowInserted: 0,
  };
}

async function syncSnapshotsAndCashFlows(
  client: HyperbotClient,
  db: ReturnType<typeof initDatabase>,
  groupName: string,
  addresses: string[],
  nowMs: number,
): Promise<SyncSnapshotFlowResult> {
  let snapshotInsertedTotal = 0;
  let inferredCashFlowInsertedTotal = 0;

  for (let i = 0; i < addresses.length; i += ACCOUNT_BATCH_SIZE) {
    const batch = addresses.slice(i, i + ACCOUNT_BATCH_SIZE);
    const accounts = await client.getTraderAccounts(batch);
    const accountMap = new Map<string, TraderAccount>();
    for (const account of accounts) {
      if (!account.address) {
        continue;
      }
      accountMap.set(normalizeAddress(account.address), account);
    }

    for (const address of batch) {
      const account = accountMap.get(normalizeAddress(address)) ?? null;
      const { snapshotInserted, inferredCashFlowInserted } =
        syncSnapshotAndFlowForAddress(db, groupName, address, nowMs, account);
      snapshotInsertedTotal += snapshotInserted;
      inferredCashFlowInsertedTotal += inferredCashFlowInserted;
    }

    const batchId = Math.floor(i / ACCOUNT_BATCH_SIZE) + 1;
    log.info(
      "crawl_history",
      `group=${groupName} 快照批次=${batchId} 数量=${batch.length} API返回=${accounts.length} 快照入库=${snapshotInsertedTotal} 推断现金流入库=${inferredCashFlowInsertedTotal}`,
    );
  }

  return {
    snapshotInserted: snapshotInsertedTotal,
    inferredCashFlowInserted: inferredCashFlowInsertedTotal,
    apiCashFlowInserted: 0,
  };
}

class Semaphore {
  private queue: (() => void)[] = [];
  private running = 0;

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }

    return new Promise((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }
}

async function main() {
  program
    .requiredOption("--group <name>", "地址分组名")
    .option("--db <path>", "SQLite 数据库路径", "./data.db")
    .option("--concurrency <number>", "地址并发爬取数", "3")
    .option("--qps <number>", "每秒 API 请求数", "5")
    .parse();

  const opts = program.opts();
  const key = process.env.HYPERBOT_KEY;
  const secret = process.env.HYPERBOT_SECRET;
  if (!key || !secret) {
    throw new Error(
      "缺少环境变量: 需设置 HYPERBOT_KEY 和 HYPERBOT_SECRET",
    );
  }

  const groupName = String(opts.group).trim();
  if (!groupName) {
    throw new Error("--group 值无效（不可为空）");
  }

  const concurrency = parseInt(opts.concurrency as string, 10);
  const qps = parseInt(opts.qps as string, 10);

  if (!Number.isFinite(concurrency) || concurrency <= 0) {
    throw new Error("--concurrency 值无效（需正整数）");
  }
  if (!Number.isFinite(qps) || qps <= 0) {
    throw new Error("--qps 值无效（需正整数）");
  }

  const db = initDatabase(opts.db as string);
  const client = new HyperbotClient(key, secret, qps);
  const nowMs = Date.now();

  const discoveryRows = getAddressDiscoveryStartsByGroup(db, groupName);
  log.info(
    "crawl_history",
    `开始历史爬取 group=${groupName}，地址数=${discoveryRows.length}，当前时间=${new Date(nowMs).toISOString()}`,
  );

  if (discoveryRows.length === 0) {
    log.warn("crawl_history", `group=${groupName} 无地址`);
    db.close();
    return;
  }

  const semaphore = new Semaphore(concurrency);
  let completed = 0;
  let failed = 0;
  let tradeInsertedTotal = 0;
  let apiCashFlowInsertedTotal = 0;

  const tasks = discoveryRows.map(
    async ({ address, earliest_discovered_at }) => {
      await semaphore.acquire();
      try {
        const inserted = await crawlTradesForAddress(
          client,
          db,
          groupName,
          address,
          earliest_discovered_at,
          nowMs,
        );
        const apiCashFlowInserted = await syncApiCashFlowsForAddress(
          client,
          db,
          groupName,
          address,
          earliest_discovered_at,
          nowMs,
        );
        tradeInsertedTotal += inserted;
        apiCashFlowInsertedTotal += apiCashFlowInserted;
        completed++;

        if (completed % 50 === 0) {
          log.info(
            "crawl_history",
            `进度 group=${groupName}: 已爬取 ${completed}/${discoveryRows.length} 地址，交易入库=${tradeInsertedTotal}，现金流API入库=${apiCashFlowInsertedTotal}`,
          );
        }
      } catch (error) {
        failed++;
        log.error(
          "crawl_history",
          `group=${groupName} ${address}: 交易爬取异常`,
          { error },
        );
      } finally {
        semaphore.release();
      }
    },
  );
  await Promise.all(tasks);

  const addresses = discoveryRows.map((item) => item.address);
  const { snapshotInserted, inferredCashFlowInserted } =
    await syncSnapshotsAndCashFlows(client, db, groupName, addresses, nowMs);
  const insertedCashFlowTotal =
    apiCashFlowInsertedTotal + inferredCashFlowInserted;

  const totalTrades = countTrades(db);
  const totalSnapshots = countAccountSnapshots(db);
  const totalCashFlows = countCashFlows(db);
  log.info(
    "crawl_history",
    `完成 group=${groupName}。地址=${completed}/${discoveryRows.length}，失败=${failed}，交易入库=${tradeInsertedTotal}，快照入库=${snapshotInserted}，现金流API入库=${apiCashFlowInsertedTotal}，推断现金流入库=${inferredCashFlowInserted}，现金流总入库=${insertedCashFlowTotal}，交易总数=${totalTrades}，快照总数=${totalSnapshots}，现金流总数=${totalCashFlows}`,
  );

  db.close();
}

main().catch((error) => {
  log.error("crawl_history", "致命错误", { error });
  process.exit(1);
});
