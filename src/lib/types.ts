// ===== Hyperbot API 通用 =====

export interface ApiResponse<T> {
  code: string;
  msg: string;
  data: T;
}

export interface PaginatedData<T> {
  list: T[];
  total: number;
  pageNum?: number;
  pageSize?: number;
}

// ===== traders/discover =====

export interface DiscoverFilter {
  field: string;
  op: ">" | "<" | "=" | "!=" | "exist";
  val: unknown;
  val2?: unknown;
  period?: number;
}

export interface DiscoverSort {
  field: string;
  dir: "asc" | "desc";
}

export interface DiscoverParams {
  pageNum?: number;
  pageSize?: number;
  period?: number;
  sort?: DiscoverSort;
  filters?: DiscoverFilter[];
  selects?: string[];
  loadPnls?: boolean;
  loadTags?: boolean;
  countOnly?: boolean;
  lang?: string;
  tags?: string[];
  coins?: string[];
  anyCoins?: string[];
  noCoins?: string[];
  addrs?: string[];
}

// discover 接口返回的交易员数据（字段名来自实际 API 响应）
export interface DiscoveredTrader {
  address: string;
  totalPnl?: string;
  winRate?: number;
  avgLeverage?: string;
  avgDurationMin?: number;
  positionCount?: number;
  longPnl?: string;
  shortPnl?: string;
  longRatio?: number;
  oaLastOrderAt?: string;
  snapEffLeverage?: string | null;
  snapMarginUsageRate?: string | null;
  snapPerpValue?: string;
  snapPositionCount?: number;
  snapSpotValue?: string;
  snapTotalMarginUsed?: string;
  snapTotalValue?: string;
  [key: string]: unknown;
}

// ===== traders/accounts =====

export interface TraderAccount {
  address: string;
  totalValue?: string;
  currentPosition?: number;
  leverage?: string;
  effLeverage?: string;
  lastOperationAt?: number;
  marginUsage?: string;
  marginUsageRate?: string;
  perpValue?: string;
  spotValue?: string;
  [key: string]: unknown;
}

export interface LedgerUpdatesNetFlow {
  netPerpIn?: string;
  netSpotIn?: string;
  [key: string]: unknown;
}

export interface UserNonFundingLedgerUpdatesRequest {
  type: "userNonFundingLedgerUpdates";
  user: string;
  startTime: number;
  endTime?: number;
}

export interface NonFundingLedgerDelta {
  type?: string;
  usdc?: string;
  [key: string]: unknown;
}

export interface NonFundingLedgerUpdate {
  delta?: NonFundingLedgerDelta;
  hash?: string;
  time?: number;
  [key: string]: unknown;
}

// ===== completed-trades =====

export interface CompletedTradesByTimeParams {
  pageNum?: number;
  pageSize?: number;
  Coin?: string;
  endTimeFrom?: number;
  endTimeTo?: number;
}

// completed-trades/by-time 接口实际返回的是裸数组，字段名来自实际 API 响应
export interface CompletedTrade {
  coin: string;
  direction: string;
  entryPrice: string;
  closePrice: string;
  size: string;
  pnl: string;
  totalFee: string;
  marginMode: string;
  startTime: string;
  endTime: string;
}

// ===== DB 行类型 =====

export interface AddressRow {
  address: string;
  group_name: string;
  discovered_at: string;
  account_balance: number | null;
  raw_json: string;
}

export interface TradeRow {
  address: string;
  coin: string;
  side: string;
  entry_price: number;
  exit_price: number;
  size: number;
  pnl: number;
  pnl_percent: number;
  open_time: number;
  close_time: number;
  raw_json: string;
}

export interface CrawlProgressRow {
  group_name: string;
  address: string;
  task: string;
  first_scanned_time: number | null;
  last_scanned_time: number | null;
  updated_at: string;
}

export interface AddressDiscoveryStartRow {
  address: string;
  earliest_discovered_at: string;
}

export interface AddressBalanceRow {
  address: string;
  account_balance: number;
  // why: fallback 锚点需还原真实观测时间，快照来源无此字段故 optional
  discovered_at?: string;
}

export interface AddressEquityAnchorRow {
  address: string;
  account_balance: number;
  anchor_time: number;
}

export interface AccountSnapshotRow {
  address: string;
  snapshot_time: number;
  total_value: number | null;
  perp_value: number | null;
  spot_value: number | null;
  raw_json: string;
}

export interface CashFlowRow {
  address: string;
  event_time: number;
  amount: number;
  direction: "in" | "out";
  source: string;
  pnl_component: number;
  equity_delta: number;
  raw_json: string;
}

export interface TimedPnlRow {
  event_time: number;
  pnl: number;
}

export interface CashFlowEventRow {
  event_time: number;
  amount: number;
  source: string;
}

// ===== 回测 =====

export interface BacktestTrade {
  address: string;
  coin: string;
  originalSide: string;
  reverseSide: string;
  entryPrice: number;
  exitPrice: number;
  positionValue: number;
  accountEquityAtOpen: number;
  originalNotionalRatio: number;
  safeNotionalRatio: number;
  isNotionalRatioClipped: boolean;
  pnl: number;
  openTime: number;
  closeTime: number;
}

export interface BacktestReport {
  capital: number;
  finalEquity: number;
  totalRoi: number;
  totalTrades: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  avgPnl: number;
  totalPnl: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  profitFactor: number;
  sharpeRatio: number;
  monthlyReturns: Map<string, number>;
  topAddresses: { address: string; pnl: number; trades: number }[];
  bottomAddresses: { address: string; pnl: number; trades: number }[];
}
