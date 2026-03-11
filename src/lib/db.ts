import Database from "better-sqlite3";
import { log } from "./logger.js";
import type {
  AccountSnapshotRow,
  AddressBalanceRow,
  AddressDiscoveryStartRow,
  AddressEquityAnchorRow,
  AddressRow,
  CashFlowEventRow,
  CashFlowRow,
  CrawlProgressRow,
  TimedPnlRow,
  TradeRow,
} from "./types.js";

const BATCH_SIZE = 500;

const ADDRESSES_SCHEMA = `
CREATE TABLE IF NOT EXISTS addresses (
  address         TEXT NOT NULL,
  group_name      TEXT NOT NULL,
  discovered_at   TEXT NOT NULL,
  account_balance REAL,
  raw_json        TEXT NOT NULL,
  PRIMARY KEY (address, group_name, discovered_at)
);

CREATE INDEX IF NOT EXISTS idx_addresses_group_name ON addresses (group_name);
CREATE INDEX IF NOT EXISTS idx_addresses_address ON addresses (address);
`;

const TRADES_SCHEMA = `
CREATE TABLE IF NOT EXISTS trades (
  address     TEXT NOT NULL,
  coin        TEXT NOT NULL,
  side        TEXT NOT NULL,
  entry_price REAL NOT NULL,
  exit_price  REAL NOT NULL,
  size        REAL NOT NULL,
  pnl         REAL NOT NULL,
  pnl_percent REAL NOT NULL,
  open_time   INTEGER NOT NULL,
  close_time  INTEGER NOT NULL,
  raw_json    TEXT NOT NULL,
  PRIMARY KEY (address, coin, open_time, side)
);

CREATE INDEX IF NOT EXISTS idx_trades_close_time ON trades (close_time);
CREATE INDEX IF NOT EXISTS idx_trades_address ON trades (address);
`;

const ACCOUNT_SNAPSHOTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS account_snapshots (
  address       TEXT NOT NULL,
  snapshot_time INTEGER NOT NULL,
  total_value   REAL,
  perp_value    REAL,
  spot_value    REAL,
  raw_json      TEXT NOT NULL,
  PRIMARY KEY (address, snapshot_time)
);

CREATE INDEX IF NOT EXISTS idx_account_snapshots_time ON account_snapshots (snapshot_time);
CREATE INDEX IF NOT EXISTS idx_account_snapshots_address ON account_snapshots (address);
`;

const CASH_FLOWS_SCHEMA = `
CREATE TABLE IF NOT EXISTS cash_flows (
  address       TEXT NOT NULL,
  event_time    INTEGER NOT NULL,
  amount        REAL NOT NULL,
  direction     TEXT NOT NULL,
  source        TEXT NOT NULL,
  pnl_component REAL NOT NULL,
  equity_delta  REAL NOT NULL,
  raw_json      TEXT NOT NULL,
  PRIMARY KEY (address, event_time, source)
);

CREATE INDEX IF NOT EXISTS idx_cash_flows_time ON cash_flows (event_time);
CREATE INDEX IF NOT EXISTS idx_cash_flows_address ON cash_flows (address);
`;

const CRAWL_PROGRESS_SCHEMA = `
CREATE TABLE IF NOT EXISTS crawl_progress (
  group_name      TEXT NOT NULL,
  address         TEXT NOT NULL,
  task            TEXT NOT NULL,
  first_scanned_time INTEGER,
  last_scanned_time  INTEGER,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (group_name, address, task)
);
`;

export function initDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  db.exec(ADDRESSES_SCHEMA);
  db.exec(TRADES_SCHEMA);
  db.exec(ACCOUNT_SNAPSHOTS_SCHEMA);
  db.exec(CASH_FLOWS_SCHEMA);
  db.exec(CRAWL_PROGRESS_SCHEMA);

  log.info("db", `数据库已初始化: ${dbPath}`);
  return db;
}

function batchInsert(
  db: Database.Database,
  sql: string,
  rows: Record<string, unknown>[],
): number {
  const stmt = db.prepare(sql);
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const tx = db.transaction((items: Record<string, unknown>[]) => {
      let count = 0;
      for (const row of items) {
        count += stmt.run(row).changes;
      }
      return count;
    });
    inserted += tx(batch);
  }
  return inserted;
}

// ===== Addresses =====

export function insertAddresses(
  db: Database.Database,
  rows: AddressRow[],
): number {
  return batchInsert(
    db,
    `INSERT OR IGNORE INTO addresses
     (address, group_name, discovered_at, account_balance, raw_json)
     VALUES
     (@address, @group_name, @discovered_at, @account_balance, @raw_json)`,
    rows,
  );
}

export function getDistinctAddressesByGroup(
  db: Database.Database,
  groupName: string,
): string[] {
  const rows = db
    .prepare("SELECT DISTINCT address FROM addresses WHERE group_name = ?")
    .all(groupName) as { address: string }[];
  return rows.map((row) => row.address);
}

export function getAddressDiscoveryStartsByGroup(
  db: Database.Database,
  groupName: string,
): AddressDiscoveryStartRow[] {
  return db
    .prepare(
      `SELECT address, MIN(discovered_at) AS earliest_discovered_at
       FROM addresses
       WHERE group_name = ?
       GROUP BY address`,
    )
    .all(groupName) as AddressDiscoveryStartRow[];
}

export function getLatestPositiveAccountBalancesByGroup(
  db: Database.Database,
  groupName: string,
): AddressBalanceRow[] {
  return db
    .prepare(
      `SELECT a.address, a.account_balance
       FROM addresses a
       WHERE a.group_name = ?
         AND a.account_balance IS NOT NULL
         AND a.account_balance > 0
         AND a.discovered_at = (
           SELECT MAX(a2.discovered_at)
           FROM addresses a2
           WHERE a2.group_name = a.group_name
             AND a2.address = a.address
             AND a2.account_balance IS NOT NULL
             AND a2.account_balance > 0
         )`,
    )
    .all(groupName) as AddressBalanceRow[];
}

export function countAddresses(
  db: Database.Database,
  groupName?: string,
): number {
  if (groupName) {
    const row = db
      .prepare(
        "SELECT COUNT(DISTINCT address) AS cnt FROM addresses WHERE group_name = ?",
      )
      .get(groupName) as { cnt: number };
    return row.cnt;
  }

  const row = db
    .prepare("SELECT COUNT(DISTINCT address) AS cnt FROM addresses")
    .get() as { cnt: number };
  return row.cnt;
}

// ===== Trades =====

export function insertTrades(db: Database.Database, rows: TradeRow[]): number {
  return batchInsert(
    db,
    `INSERT OR IGNORE INTO trades
     (address, coin, side, entry_price, exit_price, size, pnl, pnl_percent,
      open_time, close_time, raw_json)
     VALUES
     (@address, @coin, @side, @entry_price, @exit_price, @size, @pnl, @pnl_percent,
      @open_time, @close_time, @raw_json)`,
    rows,
  );
}

export function getTradesInRange(
  db: Database.Database,
  startMs: number,
  endMs: number,
): TradeRow[] {
  return db
    .prepare(
      "SELECT * FROM trades WHERE close_time >= ? AND close_time <= ? ORDER BY open_time ASC",
    )
    .all(startMs, endMs) as TradeRow[];
}

export function getTradesForAddressInRange(
  db: Database.Database,
  address: string,
  startMs: number,
  endMs: number,
): TradeRow[] {
  return db
    .prepare(
      "SELECT * FROM trades WHERE address = ? AND close_time >= ? AND close_time <= ? ORDER BY open_time ASC",
    )
    .all(address, startMs, endMs) as TradeRow[];
}

export function getRealizedPnlEventsForAddressInRange(
  db: Database.Database,
  address: string,
  startMs: number,
  endMs: number,
): TimedPnlRow[] {
  return db
    .prepare(
      `SELECT close_time AS event_time, pnl
       FROM trades
       WHERE address = ?
         AND close_time >= ?
         AND close_time <= ?
       ORDER BY close_time ASC`,
    )
    .all(address, startMs, endMs) as TimedPnlRow[];
}

export function countTrades(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM trades").get() as {
    cnt: number;
  };
  return row.cnt;
}

export function sumRealizedPnlForAddressInRange(
  db: Database.Database,
  address: string,
  startExclusiveMs: number,
  endInclusiveMs: number,
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(pnl), 0) AS total
       FROM trades
       WHERE address = ?
         AND close_time > ?
         AND close_time <= ?`,
    )
    .get(address, startExclusiveMs, endInclusiveMs) as { total: number };
  return row.total;
}

// ===== Account Snapshots =====

export function insertAccountSnapshots(
  db: Database.Database,
  rows: AccountSnapshotRow[],
): number {
  return batchInsert(
    db,
    `INSERT OR IGNORE INTO account_snapshots
     (address, snapshot_time, total_value, perp_value, spot_value, raw_json)
     VALUES
     (@address, @snapshot_time, @total_value, @perp_value, @spot_value, @raw_json)`,
    rows,
  );
}

export function countAccountSnapshots(db: Database.Database): number {
  const row = db
    .prepare("SELECT COUNT(*) AS cnt FROM account_snapshots")
    .get() as { cnt: number };
  return row.cnt;
}

export function getLatestAccountSnapshot(
  db: Database.Database,
  address: string,
): AccountSnapshotRow | null {
  const row = db
    .prepare(
      `SELECT address, snapshot_time, total_value, perp_value, spot_value, raw_json
       FROM account_snapshots
       WHERE address = ?
       ORDER BY snapshot_time DESC
       LIMIT 1`,
    )
    .get(address) as AccountSnapshotRow | undefined;
  return row ?? null;
}

export function getLatestPositiveSnapshotBalancesByGroup(
  db: Database.Database,
  groupName: string,
): AddressBalanceRow[] {
  return db
    .prepare(
      `SELECT s.address, s.total_value AS account_balance
       FROM account_snapshots s
       WHERE s.total_value IS NOT NULL
         AND s.total_value > 0
         AND EXISTS (
           SELECT 1
           FROM addresses a
           WHERE a.group_name = ?
             AND a.address = s.address
         )
         AND s.snapshot_time = (
           SELECT MAX(s2.snapshot_time)
           FROM account_snapshots s2
           WHERE s2.address = s.address
             AND s2.total_value IS NOT NULL
             AND s2.total_value > 0
         )`,
    )
    .all(groupName) as AddressBalanceRow[];
}

export function getLatestPositiveSnapshotAnchorsByGroup(
  db: Database.Database,
  groupName: string,
): AddressEquityAnchorRow[] {
  return db
    .prepare(
      `SELECT s.address, s.total_value AS account_balance, s.snapshot_time AS anchor_time
       FROM account_snapshots s
       WHERE s.total_value IS NOT NULL
         AND s.total_value > 0
         AND EXISTS (
           SELECT 1
           FROM addresses a
           WHERE a.group_name = ?
             AND a.address = s.address
         )
         AND s.snapshot_time = (
           SELECT MAX(s2.snapshot_time)
           FROM account_snapshots s2
           WHERE s2.address = s.address
             AND s2.total_value IS NOT NULL
             AND s2.total_value > 0
         )`,
    )
    .all(groupName) as AddressEquityAnchorRow[];
}

// ===== Cash Flows =====

export function insertCashFlows(
  db: Database.Database,
  rows: CashFlowRow[],
): number {
  return batchInsert(
    db,
    `INSERT OR IGNORE INTO cash_flows
     (address, event_time, amount, direction, source, pnl_component, equity_delta, raw_json)
     VALUES
     (@address, @event_time, @amount, @direction, @source, @pnl_component, @equity_delta, @raw_json)`,
    rows,
  );
}

export function countCashFlows(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM cash_flows").get() as {
    cnt: number;
  };
  return row.cnt;
}

export function getCashFlowEventsForAddressInRange(
  db: Database.Database,
  address: string,
  startMs: number,
  endMs: number,
): CashFlowEventRow[] {
  return db
    .prepare(
      `SELECT event_time, amount, source
       FROM cash_flows
       WHERE address = ?
         AND event_time >= ?
         AND event_time <= ?
       ORDER BY event_time ASC`,
    )
    .all(address, startMs, endMs) as CashFlowEventRow[];
}

// ===== Crawl Progress =====

export interface CrawlProgressRange {
  firstScannedTime: number | null;
  lastScannedTime: number | null;
}

export function getCrawlProgressByTask(
  db: Database.Database,
  groupName: string,
  address: string,
  task: string,
): CrawlProgressRange | null {
  const row = db
    .prepare(
      `SELECT first_scanned_time, last_scanned_time
       FROM crawl_progress
       WHERE group_name = ? AND address = ? AND task = ?`,
    )
    .get(groupName, address, task) as CrawlProgressRow | undefined;
  if (!row) {
    return null;
  }
  return {
    firstScannedTime: row.first_scanned_time ?? null,
    lastScannedTime: row.last_scanned_time ?? null,
  };
}

export function getCrawlProgress(
  db: Database.Database,
  groupName: string,
  address: string,
): CrawlProgressRange | null {
  return getCrawlProgressByTask(db, groupName, address, "trades");
}

export function updateCrawlProgressByTask(
  db: Database.Database,
  groupName: string,
  address: string,
  task: string,
  firstScannedTime: number | null,
  lastScannedTime: number | null,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO crawl_progress (
      group_name, address, task, first_scanned_time, last_scanned_time, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    groupName,
    address,
    task,
    firstScannedTime,
    lastScannedTime,
    new Date().toISOString(),
  );
}

export function updateCrawlProgress(
  db: Database.Database,
  groupName: string,
  address: string,
  firstScannedTime: number | null,
  lastScannedTime: number | null,
): void {
  updateCrawlProgressByTask(
    db,
    groupName,
    address,
    "trades",
    firstScannedTime,
    lastScannedTime,
  );
}

// ===== 统计查询（回测用） =====

export interface AddressStats {
  address: string;
  totalPnl: number;
  winRate: number;
  tradeCount: number;
  profitFactor: number;
  avgHolding: number;
}

export function computeAddressStats(
  db: Database.Database,
  groupName: string,
  startMs: number,
  endMs: number,
): AddressStats[] {
  const rows = db
    .prepare(
      `
    SELECT
      t.address AS address,
      SUM(t.pnl) AS total_pnl,
      COUNT(*) AS trade_count,
      SUM(CASE WHEN t.pnl > 0 THEN 1 ELSE 0 END) AS win_count,
      SUM(CASE WHEN t.pnl > 0 THEN t.pnl ELSE 0 END) AS gross_profit,
      SUM(CASE WHEN t.pnl < 0 THEN ABS(t.pnl) ELSE 0 END) AS gross_loss,
      AVG((t.close_time - t.open_time) / 3600000.0) AS avg_holding_hours
    FROM trades t
    WHERE t.close_time >= ?
      AND t.close_time <= ?
      AND EXISTS (
        SELECT 1
        FROM addresses a
        WHERE a.group_name = ?
          AND a.address = t.address
      )
    GROUP BY t.address
  `,
    )
    .all(startMs, endMs, groupName) as {
    address: string;
    total_pnl: number;
    trade_count: number;
    win_count: number;
    gross_profit: number;
    gross_loss: number;
    avg_holding_hours: number;
  }[];

  return rows.map((row) => ({
    address: row.address,
    totalPnl: row.total_pnl,
    winRate: row.trade_count > 0 ? row.win_count / row.trade_count : 0,
    tradeCount: row.trade_count,
    profitFactor:
      row.gross_loss > 0
        ? row.gross_profit / row.gross_loss
        : row.gross_profit > 0
          ? Infinity
          : 0,
    avgHolding: row.avg_holding_hours,
  }));
}
