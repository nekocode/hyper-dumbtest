# hyper-dumbtest

Hyperliquid 反向跟单（"笨蛋钱"）回测工具。

当前流水线：**手工分组导入地址 -> 按组增量同步历史 -> 按组回测**。

## 快速开始

```bash
npm install
cp .env.example .env   # 填 HYPERBOT_KEY / HYPERBOT_SECRET
```

## 流水线

```text
import_addresses(group, discovered_at) -> SQLite -> crawl(group) -> SQLite -> backtest(group)
```

## 1) 手工导入地址（必填分组+发现日）

```bash
npm run import:addresses -- \
  --addresses "0xabc...,0xdef..." \
  --group "alpha" \
  --discovered-at 2026-03-10
```

行为：

- 校验地址格式并去重
- 调用 `POST /v2/hl/traders/accounts` 批量补全账户快照
- 写入 `addresses`：`address/group_name/discovered_at/account_balance/raw_json`

## 2) 增量同步历史（必填分组）

```bash
npm run crawl -- \
  --group "alpha"
```

行为：

- 仅读取该 `group` 地址集合
- 同步 `trades` / `account_snapshots` / `cash_flows`
- `trades`：每地址起点=最早 `discovered_at`，双向增量补齐（回补 + 尾部）
- `account_snapshots`：每次抓当前账户快照，按 `(address,snapshot_time)` 增量入库
- `cash_flows`：
  - 真值：`POST /v2/hl/info` (`type=userNonFundingLedgerUpdates`) 拉充值/提现/转账事件，按地址双向增量补齐
  - 兜底：按 `equity_delta - realized_pnl` 推断净出入金（`source=inferred_equity_delta`）

## 3) 回测（必填分组）

```bash
npm run backtest -- \
  --group "alpha" \
  --trade-start 2026-01-01 \
  --trade-end 2026-01-31
```

行为：

- 仅基于该组地址执行回测
- `trade-start` 选填，默认=该组最早 `discovered_at`
- `trade-end` 选填，默认=执行时刻 `now`
- 资金按账户等权：`capital / 可用账户数`（优先用 snapshots 权益）
- 单笔仓位按目标仓位占目标权益比例开：`(entry*size/account_equity_at_open) * 分配资金`（`account_equity_at_open` 由出入金+已实现盈亏重建）
- 风控默认启用：`min_equity`、`max_notional_ratio`
- 交易期执行反向跟单模拟
- 输出 ROI / 胜率 / 回撤 / Sharpe / 月度收益 / 地址排名 + 数据覆盖/权益重建/仓位诊断
- `Final Equity` 采用真实口径：地址级权益最低为 `0`（单笔亏损按剩余权益封顶，归零后停止该地址后续交易）

## 测试

```bash
npm test
```

说明：

- `npm test`：默认单测集（排除真实 API 集成测试）
- `npm run test:api`：仅运行 `hyperbot.api` 集成测试（外部接口、耗时、受限流影响）
- `npm run test:all`：运行全部测试（含 API 集成）

## 环境变量

| 变量              | 说明                  |
| ----------------- | --------------------- |
| `HYPERBOT_KEY`    | Hyperbot AccessKeyId  |
| `HYPERBOT_SECRET` | Hyperbot AccessSecret |
