import { pathToFileURL } from "node:url";
import { program } from "commander";
import Table from "cli-table3";
import {
  getCashFlowEventsForAddressInRange,
  getAddressDiscoveryStartsByGroup,
  getClosestPositiveSnapshotAnchorsByGroup,
  getLatestPositiveAccountBalancesByGroup,
  getRealizedPnlEventsForAddressInRange,
  getTradesForAddressInRange,
  initDatabase,
} from "./lib/db.js";
import { API_NON_FUNDING_CASH_FLOW_SOURCE } from "./lib/cash_flows.js";
import { log } from "./lib/logger.js";
import type {
  AddressBalanceRow,
  AddressDiscoveryStartRow,
  AddressEquityAnchorRow,
  BacktestTrade,
  CashFlowEventRow,
  TimedPnlRow,
  TradeRow,
} from "./lib/types.js";

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseDateToUtcStartMs(value: string, field: string): number {
  if (!DATE_REGEX.test(value)) {
    throw new Error(`${field} 格式无效（需 YYYY-MM-DD）`);
  }

  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`${field} 值无效（无法解析日期）`);
  }

  return parsed.getTime();
}

function parseDateToUtcEndMs(value: string, field: string): number {
  return parseDateToUtcStartMs(value, field) + DAY_MS - 1;
}

function getEarliestDiscoveredAt(
  rows: AddressDiscoveryStartRow[],
): string | null {
  if (rows.length === 0) {
    return null;
  }

  let earliest = rows[0].earliest_discovered_at;
  for (const row of rows) {
    if (row.earliest_discovered_at < earliest) {
      earliest = row.earliest_discovered_at;
    }
  }
  return earliest;
}

export interface ResolvedTradeWindow {
  tradeStartMs: number;
  tradeEndMs: number;
  tradeStartText: string;
  tradeEndText: string;
}

export interface AddressAllocation {
  accountBalance: number;
  anchorTime: number;
  allocatedCapital: number;
}

export interface TimedDelta {
  eventTime: number;
  delta: number;
}

export interface AddressAllocationResult {
  allocations: Map<string, AddressAllocation>;
  skippedAddressCount: number;
  missingBalanceCount: number;
  lowEquityCount: number;
}

export interface PositionSizingResult {
  positionValue: number;
  originalNotionalRatio: number;
  safeNotionalRatio: number;
  isNotionalRatioClipped: boolean;
}

interface BacktestRunDiagnostics {
  addressesWithTrades: number;
  addressesWithoutTrades: number;
  addressesWithApiCashFlows: number;
  addressesWithInferredCashFlows: number;
  addressesWithNoCashFlows: number;
  addressesWithNoEquityEvents: number;
  totalRealizedPnlEvents: number;
  totalCashFlowEvents: number;
  totalMergedEvents: number;
  liquidatedAddresses: number;
  lossCappedTrades: number;
}

interface AddressCashFlowSummary {
  totalFlow: number;
}

interface BacktestRunResult {
  trades: BacktestTrade[];
  diagnostics: BacktestRunDiagnostics;
  endEquityByAddress: Map<string, number>;
  cashFlowSummaryByAddress: Map<string, AddressCashFlowSummary>;
  targetStartEquityByAddress: Map<string, number>;
  targetEndEquityByAddress: Map<string, number>;
}

interface NumericStats {
  min: number;
  median: number;
  p95: number;
  max: number;
  mean: number;
}

interface BacktestReportContext {
  groupName: string;
  tradeStartText: string;
  tradeEndText: string;
  tradeStartMs: number;
  tradeEndMs: number;
  initialEquityByAddress: Map<string, number>;
  cashFlowSummaryByAddress: Map<string, AddressCashFlowSummary>;
  endEquityByAddress: Map<string, number>;
  totalAddresses: number;
  allocatedAddresses: number;
  filteredAddresses: number;
  filteredMissingBalanceCount: number;
  filteredLowEquityCount: number;
  minEquity: number;
  maxNotionalRatio: number;
  capital: number;
  slippage: number;
  snapshotAnchorCount: number;
  importedAnchorCount: number;
}

export function resolveTradeWindow(
  earliestDiscoveredAt: string,
  tradeStartInput: string | undefined,
  tradeEndInput: string | undefined,
  nowMs: number,
): ResolvedTradeWindow {
  if (!Number.isFinite(nowMs)) {
    throw new Error("当前时间无效");
  }

  const tradeStartText = tradeStartInput ?? earliestDiscoveredAt;
  const tradeEndText = tradeEndInput ?? new Date(nowMs).toISOString();

  const tradeStartMs = parseDateToUtcStartMs(tradeStartText, "--trade-start");
  const tradeEndMs = tradeEndInput
    ? parseDateToUtcEndMs(tradeEndInput, "--trade-end")
    : nowMs;

  if (tradeStartMs >= tradeEndMs) {
    throw new Error(
      "交易窗口无效: --trade-start 必须早于 --trade-end",
    );
  }

  return {
    tradeStartMs,
    tradeEndMs,
    tradeStartText,
    tradeEndText,
  };
}

export function buildEqualWeightAllocations(
  addresses: string[],
  balances: Array<AddressBalanceRow | AddressEquityAnchorRow>,
  capital: number,
  minEquity: number,
): AddressAllocationResult {
  const balanceMap = new Map<string, { balance: number; anchorTime: number }>();
  for (const row of balances) {
    balanceMap.set(row.address, {
      balance: row.account_balance,
      anchorTime:
        "anchor_time" in row && Number.isFinite(row.anchor_time)
          ? row.anchor_time
          : 0,
    });
  }

  const eligibleAddresses: string[] = [];
  let missingBalanceCount = 0;
  let lowEquityCount = 0;
  for (const address of addresses) {
    const item = balanceMap.get(address);
    if (!item || !Number.isFinite(item.balance)) {
      missingBalanceCount++;
      continue;
    }
    if (item.balance < minEquity) {
      lowEquityCount++;
      continue;
    }
    eligibleAddresses.push(address);
  }

  if (eligibleAddresses.length === 0) {
    return {
      allocations: new Map<string, AddressAllocation>(),
      skippedAddressCount: missingBalanceCount + lowEquityCount,
      missingBalanceCount,
      lowEquityCount,
    };
  }

  const allocatedCapital = capital / eligibleAddresses.length;
  const allocations = new Map<string, AddressAllocation>();
  for (const address of eligibleAddresses) {
    const item = balanceMap.get(address);
    if (!item) {
      continue;
    }
    allocations.set(address, {
      accountBalance: item.balance,
      anchorTime: item.anchorTime,
      allocatedCapital,
    });
  }

  return {
    allocations,
    skippedAddressCount: missingBalanceCount + lowEquityCount,
    missingBalanceCount,
    lowEquityCount,
  };
}

export function computePositionSizingByBalanceRatio(
  originalPositionValue: number,
  accountBalance: number,
  allocatedCapital: number,
  maxNotionalRatio: number,
): PositionSizingResult {
  const ratio = originalPositionValue / accountBalance;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return {
      positionValue: 0,
      originalNotionalRatio: 0,
      safeNotionalRatio: 0,
      isNotionalRatioClipped: false,
    };
  }

  const safeRatio = Math.min(ratio, maxNotionalRatio);
  if (!Number.isFinite(safeRatio) || safeRatio <= 0) {
    return {
      positionValue: 0,
      originalNotionalRatio: ratio,
      safeNotionalRatio: 0,
      isNotionalRatioClipped: false,
    };
  }

  return {
    positionValue: allocatedCapital * safeRatio,
    originalNotionalRatio: ratio,
    safeNotionalRatio: safeRatio,
    isNotionalRatioClipped: ratio > maxNotionalRatio,
  };
}

export function computePositionValueByBalanceRatio(
  originalPositionValue: number,
  accountBalance: number,
  allocatedCapital: number,
  maxNotionalRatio: number,
): number {
  return computePositionSizingByBalanceRatio(
    originalPositionValue,
    accountBalance,
    allocatedCapital,
    maxNotionalRatio,
  ).positionValue;
}

export function capTradePnlByEquity(
  tradePnl: number,
  availableEquity: number,
): number {
  if (!Number.isFinite(tradePnl) || !Number.isFinite(availableEquity)) {
    return 0;
  }
  if (availableEquity <= 0) {
    return 0;
  }
  return Math.max(tradePnl, -availableEquity);
}

export function selectCashFlowEventsForEquity(
  events: CashFlowEventRow[],
): CashFlowEventRow[] {
  const apiEvents = events.filter(
    (event) => event.source === API_NON_FUNDING_CASH_FLOW_SOURCE,
  );
  if (apiEvents.length === 0) {
    return events;
  }

  // why: API 真值只覆盖部分区间时，区间外回退推断流避免丢数据
  const minApiTime = Math.min(...apiEvents.map((e) => e.event_time));
  const maxApiTime = Math.max(...apiEvents.map((e) => e.event_time));
  const inferredOutside = events.filter(
    (event) =>
      event.source !== API_NON_FUNDING_CASH_FLOW_SOURCE &&
      (event.event_time < minApiTime || event.event_time > maxApiTime),
  );
  return [...apiEvents, ...inferredOutside].sort(
    (a, b) => a.event_time - b.event_time,
  );
}

export function mergeTimedDeltas(
  realizedPnlEvents: TimedPnlRow[],
  cashFlowEvents: CashFlowEventRow[],
): TimedDelta[] {
  const merged = new Map<number, number>();
  for (const event of realizedPnlEvents) {
    merged.set(event.event_time, (merged.get(event.event_time) ?? 0) + event.pnl);
  }
  for (const event of cashFlowEvents) {
    merged.set(event.event_time, (merged.get(event.event_time) ?? 0) + event.amount);
  }
  return [...merged.entries()]
    .map(([eventTime, delta]) => ({ eventTime, delta }))
    .sort((left, right) => left.eventTime - right.eventTime);
}

function lowerBound(values: number[], target: number): number {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (values[middle] < target) {
      left = middle + 1;
    } else {
      right = middle;
    }
  }
  return left;
}

function upperBound(values: number[], target: number): number {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (values[middle] <= target) {
      left = middle + 1;
    } else {
      right = middle;
    }
  }
  return left;
}

export function buildEquityAtOpenResolver(
  anchorEquity: number,
  anchorTime: number,
  deltas: TimedDelta[],
): (openTime: number) => number {
  const times = deltas.map((delta) => delta.eventTime);
  const prefix = new Array<number>(deltas.length + 1).fill(0);
  for (let index = 0; index < deltas.length; index++) {
    prefix[index + 1] = prefix[index] + deltas[index].delta;
  }

  const sumByIndex = (start: number, end: number): number => {
    if (end <= start) {
      return 0;
    }
    return prefix[end] - prefix[start];
  };

  return (openTime: number): number => {
    if (!Number.isFinite(anchorEquity) || !Number.isFinite(anchorTime)) {
      return 0;
    }

    if (openTime === anchorTime) {
      return anchorEquity;
    }

    if (openTime > anchorTime) {
      const fromIndex = upperBound(times, anchorTime);
      const toIndex = lowerBound(times, openTime);
      return anchorEquity + sumByIndex(fromIndex, toIndex);
    }

    const fromIndex = upperBound(times, openTime);
    const toIndex = upperBound(times, anchorTime);
    return anchorEquity - sumByIndex(fromIndex, toIndex);
  };
}

function simulateReverseTrade(
  trade: TradeRow,
  slippage: number,
  allocatedCapital: number,
  accountEquityAtOpen: number,
  maxNotionalRatio: number,
): BacktestTrade {
  const originalSide = trade.side;
  const reverseSide = originalSide === "long" ? "short" : "long";

  let entryPrice: number;
  let exitPrice: number;

  if (reverseSide === "long") {
    entryPrice = trade.entry_price * (1 + slippage);
    exitPrice = trade.exit_price * (1 - slippage);
  } else {
    entryPrice = trade.entry_price * (1 - slippage);
    exitPrice = trade.exit_price * (1 + slippage);
  }

  const originalPositionValue = trade.entry_price * trade.size;
  const sizing = computePositionSizingByBalanceRatio(
    originalPositionValue,
    accountEquityAtOpen,
    allocatedCapital,
    maxNotionalRatio,
  );
  const mySize = sizing.positionValue > 0 ? sizing.positionValue / entryPrice : 0;

  let pnl: number;
  if (reverseSide === "long") {
    pnl = (exitPrice - entryPrice) * mySize;
  } else {
    pnl = (entryPrice - exitPrice) * mySize;
  }

  return {
    address: trade.address,
    coin: trade.coin,
    originalSide,
    reverseSide,
    entryPrice,
    exitPrice,
    positionValue: sizing.positionValue,
    accountEquityAtOpen,
    originalNotionalRatio: sizing.originalNotionalRatio,
    safeNotionalRatio: sizing.safeNotionalRatio,
    isNotionalRatioClipped: sizing.isNotionalRatioClipped,
    pnl,
    openTime: trade.open_time,
    closeTime: trade.close_time,
  };
}

function runBacktest(
  db: ReturnType<typeof initDatabase>,
  allocations: Map<string, AddressAllocation>,
  startMs: number,
  endMs: number,
  slippage: number,
  maxNotionalRatio: number,
): BacktestRunResult {
  const allTrades: BacktestTrade[] = [];
  const endEquityByAddress = new Map<string, number>();
  const cashFlowSummaryByAddress = new Map<string, AddressCashFlowSummary>();
  const targetStartEquityByAddress = new Map<string, number>();
  const targetEndEquityByAddress = new Map<string, number>();
  const diagnostics: BacktestRunDiagnostics = {
    addressesWithTrades: 0,
    addressesWithoutTrades: 0,
    addressesWithApiCashFlows: 0,
    addressesWithInferredCashFlows: 0,
    addressesWithNoCashFlows: 0,
    addressesWithNoEquityEvents: 0,
    totalRealizedPnlEvents: 0,
    totalCashFlowEvents: 0,
    totalMergedEvents: 0,
    liquidatedAddresses: 0,
    lossCappedTrades: 0,
  };

  for (const [address, allocation] of allocations.entries()) {
    let strategyEquity = allocation.allocatedCapital;
    const trades = getTradesForAddressInRange(db, address, startMs, endMs);
    if (trades.length === 0) {
      diagnostics.addressesWithoutTrades++;
    } else {
      diagnostics.addressesWithTrades++;
    }

    let minOpenTime = startMs;
    let maxOpenTime = endMs;
    if (trades.length > 0) {
      minOpenTime = trades[0].open_time;
      maxOpenTime = trades[0].open_time;
      for (const trade of trades) {
        if (trade.open_time < minOpenTime) {
          minOpenTime = trade.open_time;
        }
        if (trade.open_time > maxOpenTime) {
          maxOpenTime = trade.open_time;
        }
      }
    }

    const eventStart = Math.min(allocation.anchorTime, startMs, endMs, minOpenTime);
    const eventEnd = Math.max(allocation.anchorTime, startMs, endMs, maxOpenTime);
    const realizedPnlEvents = getRealizedPnlEventsForAddressInRange(
      db,
      address,
      eventStart,
      eventEnd,
    );
    diagnostics.totalRealizedPnlEvents += realizedPnlEvents.length;
    const cashFlowEvents = selectCashFlowEventsForEquity(
      getCashFlowEventsForAddressInRange(db, address, eventStart, eventEnd),
    );
    let totalFlow = 0;
    for (const event of cashFlowEvents) {
      if (event.event_time >= startMs && event.event_time <= endMs) {
        totalFlow += event.amount;
      }
    }
    cashFlowSummaryByAddress.set(address, {
      totalFlow,
    });
    diagnostics.totalCashFlowEvents += cashFlowEvents.length;
    if (cashFlowEvents.length === 0) {
      diagnostics.addressesWithNoCashFlows++;
    } else if (
      cashFlowEvents.some(
        (event) => event.source === API_NON_FUNDING_CASH_FLOW_SOURCE,
      )
    ) {
      diagnostics.addressesWithApiCashFlows++;
    } else {
      diagnostics.addressesWithInferredCashFlows++;
    }
    const deltas = mergeTimedDeltas(realizedPnlEvents, cashFlowEvents);
    diagnostics.totalMergedEvents += deltas.length;
    if (deltas.length === 0) {
      diagnostics.addressesWithNoEquityEvents++;
    }
    const resolveEquityAtOpen = buildEquityAtOpenResolver(
      allocation.accountBalance,
      allocation.anchorTime,
      deltas,
    );
    targetStartEquityByAddress.set(address, resolveEquityAtOpen(startMs));
    targetEndEquityByAddress.set(address, resolveEquityAtOpen(endMs));

    if (trades.length === 0) {
      endEquityByAddress.set(address, strategyEquity);
      continue;
    }

    for (const trade of trades) {
      if (strategyEquity <= 0) {
        break;
      }

      const accountEquityAtOpen = resolveEquityAtOpen(trade.open_time);
      const simulated = simulateReverseTrade(
        trade,
        slippage,
        allocation.allocatedCapital,
        accountEquityAtOpen,
        maxNotionalRatio,
      );
      const cappedPnl = capTradePnlByEquity(simulated.pnl, strategyEquity);
      if (cappedPnl !== simulated.pnl) {
        diagnostics.lossCappedTrades++;
      }

      strategyEquity += cappedPnl;
      allTrades.push({
        ...simulated,
        pnl: cappedPnl,
      });

      if (strategyEquity <= 0) {
        strategyEquity = 0;
        diagnostics.liquidatedAddresses++;
        break;
      }
    }

    endEquityByAddress.set(address, strategyEquity);
  }

  allTrades.sort((left, right) => left.openTime - right.openTime);
  return {
    trades: allTrades,
    diagnostics,
    endEquityByAddress,
    cashFlowSummaryByAddress,
    targetStartEquityByAddress,
    targetEndEquityByAddress,
  };
}

function computeMaxDrawdown(dailyEquity: number[]): {
  maxDrawdown: number;
  maxDrawdownPercent: number;
} {
  let peak = dailyEquity[0] ?? 0;
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;

  for (const equity of dailyEquity) {
    if (equity > peak) {
      peak = equity;
    }
    const drawdown = peak - equity;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownPercent = peak > 0 ? drawdown / peak : 0;
    }
  }

  return { maxDrawdown, maxDrawdownPercent };
}

function computeSharpeRatio(dailyReturns: number[]): number {
  if (dailyReturns.length < 2) {
    return 0;
  }

  const mean =
    dailyReturns.reduce((sum, value) => sum + value, 0) / dailyReturns.length;
  const variance =
    dailyReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (dailyReturns.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) {
    return 0;
  }

  return (mean / std) * Math.sqrt(365);
}

// ===== 格式化工具 =====

function formatMoney(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatSignedMoney(value: number): string {
  const sign = value >= 0 ? "+" : "-";
  return `${sign}$${formatMoney(Math.abs(value))}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export function computeNumericStats(values: number[]): NumericStats | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const pick = (ratio: number): number => {
    const index = Math.max(
      0,
      Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio)),
    );
    return sorted[index];
  };
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    min: sorted[0],
    median: pick(0.5),
    p95: pick(0.95),
    max: sorted[sorted.length - 1],
    mean: sum / values.length,
  };
}

export function compactDateLabel(value: string): string {
  if (DATE_REGEX.test(value)) {
    return value;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return value;
  }
  return parsed.toISOString().slice(0, 10);
}

function formatTradeWindowLabel(startText: string, endText: string): string {
  return `${compactDateLabel(startText)} ~ ${compactDateLabel(endText)}`;
}

function formatOptionalMoney(value: number | undefined): string {
  return value !== undefined && Number.isFinite(value)
    ? `$${formatMoney(value)}`
    : "N/A";
}

// ===== 报告输出 =====

// why: 无边框表格，仅用 cli-table3 做 CJK 列对齐
const BORDERLESS: Table.TableConstructorOptions["chars"] = {
  "top": "", "top-mid": "", "top-left": "", "top-right": "",
  "bottom": "", "bottom-mid": "", "bottom-left": "", "bottom-right": "",
  "left": "  ", "left-mid": "", "mid": "", "mid-mid": "",
  "right": "", "right-mid": "", "middle": "  ",
};
const NO_COLOR: Table.TableConstructorOptions["style"] = {
  "padding-left": 0, "padding-right": 0, border: [], head: [],
};

function kvTable(rows: [string, string][]): string {
  const table = new Table({ chars: BORDERLESS, style: NO_COLOR });
  for (const row of rows) {
    table.push(row);
  }
  return table.toString();
}

function generateReport(
  trades: BacktestTrade[],
  context: BacktestReportContext,
  diagnostics: BacktestRunDiagnostics,
): void {
  if (trades.length === 0) {
    log.warn("backtest/report", "无交易可报告");
    return;
  }

  const { capital } = context;

  // 绩效计算
  const winCount = trades.filter((trade) => trade.pnl > 0).length;
  const lossCount = trades.filter((trade) => trade.pnl < 0).length;
  const grossProfit = trades
    .filter((trade) => trade.pnl > 0)
    .reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = trades
    .filter((trade) => trade.pnl < 0)
    .reduce((sum, trade) => sum + Math.abs(trade.pnl), 0);
  const profitFactor =
    grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  const finalEquity = [...context.endEquityByAddress.values()].reduce(
    (sum, value) => sum + value,
    0,
  );
  const totalPnl = finalEquity - capital;
  const totalRoi = totalPnl / capital;
  const winLossTotal = winCount + lossCount;
  const clippedTrades = trades.filter(
    (trade) => trade.isNotionalRatioClipped,
  ).length;
  const totalCashFlow = [...context.cashFlowSummaryByAddress.values()].reduce(
    (sum, item) => sum + item.totalFlow,
    0,
  );

  // 日度收益（Sharpe/Drawdown 用）
  const dailyPnlMap = new Map<string, number>();
  for (const trade of trades) {
    const day = new Date(trade.closeTime).toISOString().split("T")[0];
    dailyPnlMap.set(day, (dailyPnlMap.get(day) ?? 0) + trade.pnl);
  }

  // why: 用完整日历日填充，避免 Sharpe/Drawdown 因跳过无交易日而失真
  const windowStart = new Date(context.tradeStartMs);
  windowStart.setUTCHours(0, 0, 0, 0);
  const windowEnd = new Date(context.tradeEndMs);
  windowEnd.setUTCHours(0, 0, 0, 0);
  const allDays: string[] = [];
  for (
    const cursor = new Date(windowStart);
    cursor <= windowEnd;
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    allDays.push(cursor.toISOString().split("T")[0]);
  }

  const dailyEquity: number[] = [];
  const dailyReturns: number[] = [];
  let equity = capital;

  for (const day of allDays) {
    const dayPnl = dailyPnlMap.get(day) ?? 0;
    const previousEquity = equity;
    equity += dayPnl;
    dailyEquity.push(equity);
    if (previousEquity > 0) {
      dailyReturns.push(dayPnl / previousEquity);
    }
  }

  const { maxDrawdown, maxDrawdownPercent } = computeMaxDrawdown(dailyEquity);
  const sharpeRatio = computeSharpeRatio(dailyReturns);

  // 月度收益
  const monthlyReturns = new Map<string, number>();
  for (const trade of trades) {
    const month = new Date(trade.closeTime).toISOString().slice(0, 7);
    monthlyReturns.set(month, (monthlyReturns.get(month) ?? 0) + trade.pnl);
  }

  // 地址排名
  const addressPnl = new Map<string, { pnl: number; trades: number }>();
  for (const trade of trades) {
    const item = addressPnl.get(trade.address) ?? { pnl: 0, trades: 0 };
    item.pnl += trade.pnl;
    item.trades += 1;
    addressPnl.set(trade.address, item);
  }
  const addressRanking = [...addressPnl.entries()]
    .map(([address, data]) => ({ address, ...data }))
    .sort((left, right) => right.pnl - left.pnl);

  // === 输出 ===
  const W = 64;
  console.log("\n" + "=".repeat(W));
  console.log("  回测报告");
  console.log("=".repeat(W));

  // 概况
  console.log(kvTable([
    ["分组", context.groupName],
    ["交易窗口", formatTradeWindowLabel(context.tradeStartText, context.tradeEndText)],
    [
      "地址",
      `${context.totalAddresses} 总 / ${context.allocatedAddresses} 分配 / ${context.filteredAddresses} 过滤（低权益 ${context.filteredLowEquityCount}, 缺余额 ${context.filteredMissingBalanceCount}）`,
    ],
    ["本金", `$${formatMoney(capital)}`],
    [
      "风控",
      `滑点=${formatPercent(context.slippage)}, 最低权益=${context.minEquity}, 最大杠杆比=${context.maxNotionalRatio}`,
    ],
  ]));

  console.log("-".repeat(W));

  // 绩效
  console.log(kvTable([
    ["最终权益", `$${formatMoney(finalEquity)}`],
    ["PnL / ROI", `$${formatMoney(totalPnl)}  (${formatPercent(totalRoi)})`],
    ["交易数", `${trades.length}    胜率 ${winLossTotal > 0 ? formatPercent(winCount / winLossTotal) : "N/A"}`],
    ["盈亏比", profitFactor === Infinity ? "INF" : profitFactor.toFixed(3)],
    ["最大回撤", `$${formatMoney(maxDrawdown)} (${formatPercent(maxDrawdownPercent)})`],
    ["夏普比率", sharpeRatio.toFixed(3)],
  ]));

  console.log("-".repeat(W));

  // 数据质量
  const dataQualityRows: [string, string][] = [
    ["权益锚点", `快照=${context.snapshotAnchorCount}, 导入=${context.importedAnchorCount}`],
    [
      "现金流",
      `API=${diagnostics.addressesWithApiCashFlows}, 推断=${diagnostics.addressesWithInferredCashFlows}, 无=${diagnostics.addressesWithNoCashFlows}  合计 ${formatSignedMoney(totalCashFlow)}`,
    ],
    ["比率截断", `${clippedTrades}/${trades.length} (${formatPercent(clippedTrades / trades.length)})`],
    ["风控事件", `爆仓 ${diagnostics.liquidatedAddresses} 地址, 封顶 ${diagnostics.lossCappedTrades} 笔`],
  ];
  // why: API 真值现金流不含未实现 PnL 变化，持仓波动大时权益重建会漂移
  if (diagnostics.addressesWithApiCashFlows > 0) {
    dataQualityRows.push([
      "注意",
      `${diagnostics.addressesWithApiCashFlows} 个 API 现金流地址不含未实现 PnL 变化，权益重建精度受持仓波动影响`,
    ]);
  }
  console.log(kvTable(dataQualityRows));

  console.log("-".repeat(W));

  // 月度收益
  const monthTable = new Table({
    chars: BORDERLESS,
    style: NO_COLOR,
    colAligns: ["left", "right", "right"],
  });
  for (const [month, pnl] of [...monthlyReturns.entries()].sort()) {
    const monthRoi = capital > 0 ? pnl / capital : 0;
    monthTable.push([month, formatSignedMoney(pnl), formatPercent(monthRoi)]);
  }
  console.log(monthTable.toString());

  console.log("-".repeat(W));

  // 地址排名（前 5 / 后 5）
  const rankHead = ["地址", "PnL", "笔数", "初始权益"];
  const printRanking = (
    label: string,
    items: typeof addressRanking,
  ): void => {
    console.log(`  ${label}`);
    const table = new Table({
      head: rankHead,
      chars: BORDERLESS,
      style: NO_COLOR,
      colAligns: ["left", "right", "right", "right"],
    });
    for (const item of items) {
      const initEq = context.initialEquityByAddress.get(item.address);
      table.push([
        item.address.slice(0, 10) + "…",
        formatSignedMoney(item.pnl),
        String(item.trades),
        formatOptionalMoney(initEq),
      ]);
    }
    console.log(table.toString());
  };

  printRanking("前 5", addressRanking.slice(0, 5));
  printRanking("后 5", addressRanking.slice(-5).reverse());

  console.log("=".repeat(W));
}

function main() {
  program
    .requiredOption("--group <name>", "地址分组名")
    .option(
      "--trade-start <date>",
      "交易起始日期（YYYY-MM-DD），默认: 分组内最早 discovered_at",
    )
    .option(
      "--trade-end <date>",
      "交易截止日期（YYYY-MM-DD），默认: 当前时间",
    )
    .option("--db <path>", "SQLite 数据库路径", "./data.db")
    .option("--capital <number>", "初始本金（USD）", "100000")
    .option("--slippage <number>", "滑点比率", "0.001")
    .option("--min-equity <number>", "账户纳入最低权益", "100")
    .option(
      "--max-notional-ratio <number>",
      "原始名义/账户权益上限",
      "100",
    )
    .parse();

  const opts = program.opts();
  const groupName = String(opts.group).trim();
  if (!groupName) {
    throw new Error("--group 值无效（不可为空）");
  }

  const capital = parseFloat(opts.capital as string);
  const slippage = parseFloat(opts.slippage as string);
  const minEquity = parseFloat(opts.minEquity as string);
  const maxNotionalRatio = parseFloat(opts.maxNotionalRatio as string);
  if (!Number.isFinite(capital) || capital <= 0) {
    throw new Error("--capital 值无效（需正数）");
  }
  if (!Number.isFinite(slippage) || slippage < 0) {
    throw new Error("--slippage 值无效（需非负数）");
  }
  if (!Number.isFinite(minEquity) || minEquity <= 0) {
    throw new Error("--min-equity 值无效（需正数）");
  }
  if (!Number.isFinite(maxNotionalRatio) || maxNotionalRatio <= 0) {
    throw new Error(
      "--max-notional-ratio 值无效（需正数）",
    );
  }

  const db = initDatabase(opts.db as string);
  try {
    const rows = getAddressDiscoveryStartsByGroup(db, groupName);
    if (rows.length === 0) {
      log.warn(
        "backtest",
        `group=${groupName} 无地址，退出。`,
      );
      return;
    }

    const earliestDiscoveredAt = getEarliestDiscoveredAt(rows);
    if (!earliestDiscoveredAt) {
      log.warn(
        "backtest",
        `group=${groupName} 无发现日期，退出。`,
      );
      return;
    }

    const { tradeStartMs, tradeEndMs, tradeStartText, tradeEndText } =
      resolveTradeWindow(
        earliestDiscoveredAt,
        opts.tradeStart as string | undefined,
        opts.tradeEnd as string | undefined,
        Date.now(),
      );

    const addresses = rows.map((row) => row.address);
    const snapshotAnchors = getClosestPositiveSnapshotAnchorsByGroup(
      db,
      groupName,
      tradeStartMs,
    );
    const importedBalances = getLatestPositiveAccountBalancesByGroup(
      db,
      groupName,
    );
    const snapshotAnchorByAddress = new Map<string, AddressEquityAnchorRow>();
    for (const anchor of snapshotAnchors) {
      snapshotAnchorByAddress.set(anchor.address, anchor);
    }
    // why: 需同时保留 discovered_at 以还原正确的锚点时间
    const importedBalanceByAddress = new Map<
      string,
      { balance: number; discoveredAt: string }
    >();
    for (const row of importedBalances) {
      if (row.discovered_at) {
        importedBalanceByAddress.set(row.address, {
          balance: row.account_balance,
          discoveredAt: row.discovered_at,
        });
      }
    }

    const balanceAnchors: AddressEquityAnchorRow[] = [];
    let importedFallbackCount = 0;
    for (const address of addresses) {
      const snapshotAnchor = snapshotAnchorByAddress.get(address);
      if (snapshotAnchor) {
        balanceAnchors.push(snapshotAnchor);
        continue;
      }

      const imported = importedBalanceByAddress.get(address);
      if (!imported) {
        continue;
      }
      // why: 导入余额的真实观测时间是 discovered_at，非 tradeStartMs
      //       错配会导致权益重建方向/区间全错，仓位比例失真
      const anchorTime = parseDateToUtcStartMs(
        imported.discoveredAt,
        "discovered_at",
      );
      balanceAnchors.push({
        address,
        account_balance: imported.balance,
        anchor_time: anchorTime,
      });
      importedFallbackCount++;
    }

    if (snapshotAnchors.length === 0) {
      log.warn(
        "backtest",
        "无快照锚点，使用导入余额作为交易起点锚点。",
      );
    } else if (importedFallbackCount > 0) {
      log.warn(
        "backtest",
        `${importedFallbackCount} 个地址缺快照锚点，使用导入余额作为交易起点回退锚点。`,
      );
    }

    const {
      allocations,
      skippedAddressCount,
      missingBalanceCount,
      lowEquityCount,
    } = buildEqualWeightAllocations(
      addresses,
      balanceAnchors,
      capital,
      minEquity,
    );
    if (allocations.size === 0) {
      log.warn(
        "backtest",
        `group=${groupName} 无正余额地址，退出。`,
      );
      return;
    }

    log.info(
      "backtest",
      `group=${groupName} 地址=${addresses.length} 分配=${allocations.size} 跳过=${skippedAddressCount}(缺余额=${missingBalanceCount},低权益=${lowEquityCount})`,
    );
    log.info(
      "backtest",
      `窗口=${formatTradeWindowLabel(tradeStartText, tradeEndText)} 本金=$${capital} 滑点=${formatPercent(slippage)}`,
    );
    log.info(
      "backtest",
      `开始回测 ${allocations.size} 个地址...`,
    );

    const {
      trades,
      diagnostics,
      endEquityByAddress,
      cashFlowSummaryByAddress,
      targetStartEquityByAddress,
    } = runBacktest(
        db,
        allocations,
        tradeStartMs,
        tradeEndMs,
        slippage,
        maxNotionalRatio,
      );

    log.info(
      "backtest",
      `完成: ${trades.length} 笔反向交易, 有交易=${diagnostics.addressesWithTrades}, 爆仓=${diagnostics.liquidatedAddresses}`,
    );

    generateReport(trades, {
      groupName,
      tradeStartText,
      tradeEndText,
      tradeStartMs,
      tradeEndMs,
      initialEquityByAddress: targetStartEquityByAddress,
      cashFlowSummaryByAddress,
      endEquityByAddress,
      totalAddresses: addresses.length,
      allocatedAddresses: allocations.size,
      filteredAddresses: skippedAddressCount,
      filteredMissingBalanceCount: missingBalanceCount,
      filteredLowEquityCount: lowEquityCount,
      minEquity,
      maxNotionalRatio,
      capital,
      slippage,
      snapshotAnchorCount: snapshotAnchors.length,
      importedAnchorCount: importedFallbackCount,
    }, diagnostics);
  } finally {
    db.close();
  }
}

export function isMainModule(): boolean {
  const entryPath = process.argv[1];
  if (!entryPath) {
    return false;
  }
  return import.meta.url === pathToFileURL(entryPath).href;
}

if (isMainModule()) {
  main();
}
