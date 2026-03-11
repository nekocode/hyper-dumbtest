# 教训

非常识性知识沉淀。重复犯错时务必自记录

- 2026-03-10：分组能力落地时，`crawl_progress` 必须带 `group_name`；否则不同组会共享断点，导致漏爬。
- 2026-03-10：仅记录 `last_close_time` 只能向后补；若要支持“更早发现日回补”，进度必须记录扫描区间两端（first/last scanned）。
- 2026-03-10：API 集成测试想稳定过 429，要“双保险”：客户端识别 `Retry-After` 做限流退避，测试侧再降速串行执行。
- 2026-03-10：`tsx` 脚本不会自动加载 `.env`；CLI 入口需显式 `import \"dotenv/config\"`，否则会误报环境变量缺失。
- 2026-03-11：`YYYY-MM-DD` 作为回测日窗时，需显式转 UTC 日起/日末；否则 `trade-end` 会误截到当天 00:00。
- 2026-03-11：做“账户等权 + 仓位比例映射”时，必须先过滤 `account_balance>0`；否则分配或比例会除零/失真。
- 2026-03-11：账户权益做分母时必须加护栏（`min_equity`、`max_notional_ratio`），否则极小权益地址会把仓位放大到失真。
- 2026-03-11：无稳定转账 API 时，`cash_flows` 可先用 `equity_delta - realized_pnl` 推断，并标注 `source` 区分真值/估值。
- 2026-03-11：回测报告需同时输出“过滤统计 + 裁剪统计”（低权益/缺权益、`max_notional_ratio` clipped 次数），否则结果可解释性不足。
- 2026-03-11：默认 `npm test` 应排除外部 API 集成测试；仅在 API 调用链相关改动时跑 `npm run test:api`，减少非确定性失败。
- 2026-03-11：官方出入金真值应走 `POST /v2/hl/info` + `type=userNonFundingLedgerUpdates`；`ledger-updates/net-flow` 只给汇总，不可替代逐事件明细。
- 2026-03-11：回测仓位分母要用“开仓时权益”，应用 `cash_flows + realized_pnl` 在锚点前后重建，避免用最新地址权益产生前视偏差。
- 2026-03-11：回测输出需显式给“数据覆盖 + 权益重建 + 仓位分布”诊断，否则结果不可解释。
- 2026-03-11：`Final Equity` 要按真实权益口径统计：地址级权益不能小于 0，单笔亏损需按剩余权益封顶并在归零后停止该地址交易。
