# ARCHITECTURE.md — hyper-dumbtest

## 设计意图

目标：围绕“用户自定义分组”做全链路。

- 地址来源：纯手工导入
- 历史采集：按组执行
- 回测执行：按组执行

流水线：

```text
import_addresses(group, discovered_at)
  -> SQLite(addresses)
  -> crawl_history(group)
  -> SQLite(trades, account_snapshots, cash_flows, crawl_progress)
  -> backtest(group)
  -> report(stdout)
```

---

## 目录结构

- src/
  - import_addresses.ts — 手工导入地址；API 补全账户快照；写 `addresses`
  - crawl_history.ts — 按组同步 trades/snapshots/cash_flows（全增量）
  - backtest.ts — 按组执行反向跟单回测
  - lib/
    - hyperbot.ts — API 客户端（签名、重试、限速）
    - cash_flows.ts — 现金流映射（真实账本事件 + 推断净流）
    - db.ts — schema + 数据访问
    - logger.ts — 结构化日志（who/what/when/result）
    - types.ts — 类型定义

---

## 数据模型（SQLite）

### addresses

仅保留地址基础快照。

```sql
CREATE TABLE addresses (
  address         TEXT NOT NULL,
  group_name      TEXT NOT NULL,
  discovered_at   TEXT NOT NULL,
  account_balance REAL,
  raw_json        TEXT NOT NULL,
  PRIMARY KEY (address, group_name, discovered_at)
);

CREATE INDEX idx_addresses_group_name ON addresses (group_name);
CREATE INDEX idx_addresses_address ON addresses (address);
```

说明：

- `group_name`：用户业务分组，后续 crawl/backtest 都以此过滤
- `account_balance`：导入时由 `traders/accounts.totalValue` 映射
- `raw_json`：导入时账户快照原文，防字段丢失

### trades

交易明细全局去重，按地址复用（不冗余 group 维度）。

```sql
CREATE TABLE trades (
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

CREATE INDEX idx_trades_close_time ON trades (close_time);
CREATE INDEX idx_trades_address ON trades (address);
```

### account_snapshots

账户权益快照，按地址时间去重。

```sql
CREATE TABLE account_snapshots (
  address       TEXT NOT NULL,
  snapshot_time INTEGER NOT NULL,
  total_value   REAL,
  perp_value    REAL,
  spot_value    REAL,
  raw_json      TEXT NOT NULL,
  PRIMARY KEY (address, snapshot_time)
);

CREATE INDEX idx_account_snapshots_time ON account_snapshots (snapshot_time);
CREATE INDEX idx_account_snapshots_address ON account_snapshots (address);
```

### cash_flows

净出入金事件（真值优先 + 推断兜底）。

```sql
CREATE TABLE cash_flows (
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

CREATE INDEX idx_cash_flows_time ON cash_flows (event_time);
CREATE INDEX idx_cash_flows_address ON cash_flows (address);
```

### crawl_progress

增量断点按组隔离，防跨组串进度。

```sql
CREATE TABLE crawl_progress (
  group_name      TEXT NOT NULL,
  address         TEXT NOT NULL,
  task            TEXT NOT NULL,
  first_scanned_time INTEGER,
  last_scanned_time  INTEGER,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (group_name, address, task)
);
```

---

## 模块设计

### 1) `import_addresses.ts`

输入：

- `--addresses`（逗号分隔）
- `--group`（必填）
- `--discovered-at`（必填，`YYYY-MM-DD`）

流程：

1. 地址格式校验并去重
2. 调 `POST /v2/hl/traders/accounts`（50/批）补全账户快照
3. 写入 `addresses`

失败策略：

- 批量账户 API 失败：直接失败退出（不吞异常）
- 单地址缺快照：`account_balance = null`，`raw_json = {}` 并告警

### 2) `crawl_history.ts`

输入：

- `--group`（必填）
- `--concurrency`

流程：

1. `trades`：按地址最早 `discovered_at` + 扫描边界做双向增量
2. `account_snapshots`：按批拉 `traders/accounts`，按 `(address,time)` 增量入库
3. `cash_flows`：
   - 真值：`hl/info(type=userNonFundingLedgerUpdates)` 拉非资金费账本更新（充值/提现/转账），双向增量入库
   - 兜底：基于相邻快照推断 `equity_delta - realized_pnl` 入库
4. 三类任务都使用 `(group,address,task)` 断点隔离（含 `cash_flows_api`）

### 3) `backtest.ts`

输入：

- `--group`（必填）
- `--trade-start`（选填，默认组内最早 `discovered_at`）
- `--trade-end`（选填，默认 `now`）
- `--min-equity`（选填，默认 `100`）
- `--max-notional-ratio`（选填，默认 `100`）
- 资金/滑点

流程：

1. 读取该组地址全集
2. 计算交易窗：`trade-start/trade-end`（含默认）
3. 构建权益锚点：优先 `account_snapshots` 最新正值（含时间），缺失回退 `addresses.account_balance@trade_start`
4. 资金分配：按账户等权（过滤低权益）
5. 单笔仓位：按“目标仓位/交易开仓时权益”比例映射，且比例上限裁剪
6. 反向跟单回测并输出报告

详细执行逻辑（与代码一致）：

1. 地址集与时间窗
   - 地址集：`getAddressDiscoveryStartsByGroup(group)`
   - `trade_start`：优先 CLI；未传则取组内最早 `discovered_at`
   - `trade_end`：优先 CLI（当天 `23:59:59.999Z`）；未传则 `now`
   - 约束：`trade_start < trade_end`

2. 权益源与账户筛选
   - 权益源优先级：
     1) `getLatestPositiveSnapshotAnchorsByGroup(group)`（`balance+anchor_time`）
     2) fallback `getLatestPositiveAccountBalancesByGroup(group)`（锚点时间设为 `trade_start`）
   - 过滤：仅保留 `balance >= min_equity` 且有限数值账户

3. 资金分配（账户等权）
   - 设可用账户数 `N`
   - 每账户资金：`allocated_capital = total_capital / N`
   - 该步只做账户层分配，不直接决定单笔杠杆

4. 单笔仓位映射（按交易开仓时权益强度，无前视）
   - 开仓权益重建：
     - 事件源：`cash_flows.amount` + `trades.pnl(close_time)`，按时间合并
     - 现金流去重策略：API 覆盖区间（按 min/max 事件时间界定）内用真值，区间外回退推断流；无 API 事件时全用推断流
     - 若锚点在未来：`equity_at_open = anchor_equity - Σ(delta in (open_time, anchor_time])`
     - 若锚点在过去：`equity_at_open = anchor_equity + Σ(delta in (anchor_time, open_time))`
   - 原单名义：`original_notional = entry_price * size`
   - 原单强度：`ratio = original_notional / equity_at_open`
   - 风险裁剪：`safe_ratio = min(ratio, max_notional_ratio)`
   - 我方名义：`my_notional = allocated_capital * safe_ratio`
   - 我方数量：`my_size = my_notional / my_entry_price`
   - 注：若 `safe_ratio <= 0` 或非有限值，则该笔视为 `0` 仓位

5. 反向方向与滑点
   - 方向反转：`long -> short`，`short -> long`
   - 滑点模型（`slippage = s`）：
     - 若我方 `long`：`entry=orig_entry*(1+s)`，`exit=orig_exit*(1-s)`
     - 若我方 `short`：`entry=orig_entry*(1-s)`，`exit=orig_exit*(1+s)`
   - 含义：开仓吃差价、平仓再吃一次差价，统一偏保守

6. 单笔 PnL
   - 我方 `long`：`pnl = (exit - entry) * my_size`
   - 我方 `short`：`pnl = (entry - exit) * my_size`
   - 真实权益护栏：`effective_pnl = max(pnl, -address_strategy_equity)`，地址权益触及 `0` 后停止后续交易
   - 逐地址抓交易：`getTradesForAddressInRange(address, start, end)`
   - 聚合后按 `open_time` 升序输出交易序列

7. 组合统计与报表
   - `total_pnl = Σ effective_trade.pnl`
   - `final_equity = Σ address_end_equity`（地址级权益下限 `0`）
   - `roi = total_pnl / capital`
   - 报表上下文：`group`、`trade window`、地址总数/分配数/过滤数、锚点来源与时间分布
   - 数据覆盖诊断：有交易地址数、现金流来源覆盖（api/inferred/none）、权益重建事件计数
   - 风控诊断：`max_notional_ratio` 裁剪次数（trades/addresses）、零名义仓位、名义与权益分布统计
   - 胜率/ProfitFactor：基于单笔 `pnl` 正负统计
   - 日收益序列：按 `close_day` 聚合日 PnL，计算
     - Max Drawdown（基于日净值路径）
     - Sharpe（`sqrt(365)` 年化，日收益样本标准差）
   - 月度收益：按 `close_month` 聚合
   - 地址排行：按地址累计 `pnl` 排序，输出 Top/Bottom

8. 当前模型边界
   - 单账户资金在回测期内不做动态复利再分配（账户等权固定）
   - 不模拟保证金占用冲突/同一时刻多仓竞争
   - 不引入资金费率、手续费分层、撮合深度冲击（仅统一滑点）

---

## 关键决策

1. 地址分组放在 `addresses`，交易不重复存组。
2. 进度表必须含 `group_name`，避免组间断点污染。
3. 断点主键保留 `(group,address,task)`，三类爬取统一增量语义。
4. 回测分组过滤在 SQL 层完成（`EXISTS addresses(group_name,address)`）。
5. `cash_flows` 采用双源并存：真值事件与推断事件共存，靠 `source` 区分。

---

## 限制与后续

- `userNonFundingLedgerUpdates` 仅覆盖“非资金费账本更新”，资金费本身不在该流
- API 集成测试可能受 429 影响（外部限流）
- 若未来要求“同地址跨组独立交易样本”，再考虑给 `trades` 加 `group_name`
