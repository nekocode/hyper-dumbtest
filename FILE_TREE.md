# 源码树

每文件一句话职责，无序列表缩进

- package.json — 依赖声明与 npm scripts
- eslint.config.js — ESLint v9 flat config（TS + Node globals）
- tsconfig.json — TypeScript 编译配置
- vitest.config.ts — Vitest 测试框架配置
- src/
  - import_addresses.ts — 主程序：手工导入地址到指定分组/发现日，API 补全账户快照
  - crawl_history.ts — 主程序：按分组增量同步 trades/snapshots/cash_flows
  - backtest.ts — 主程序：按分组反向跟单回测，含等权分配、开仓时权益重建、风控阈值、cli-table3 报告输出
  - lib/
    - hyperbot.ts — Hyperbot API 客户端（签名/请求/限速/重试）
    - cash_flows.ts — 出入金映射（真实账本事件 + 推断净流）
    - db.ts — SQLite schema（group 维度）与读写
    - logger.ts — 结构化日志（who/what/when/result）
    - types.ts — 全局类型定义
    - utils.ts — 共享工具函数（normalizeAddress/parseFiniteNumber）
    - **tests**/
      - hyperbot.test.ts — 签名与客户端请求映射单测
      - hyperbot.api.test.ts — Hyperbot API 集成测试（真实请求）
      - cash_flows.test.ts — 出入金映射单测（真值/推断）
      - db.test.ts — DB 层单测（增删改查/去重/聚合/快照/现金流）
  - **tests**/
    - backtest.test.ts — 回测窗口解析、等权分配、风控阈值、地址统计、反向交易 PnL 计算测试
    - import_addresses.test.ts — 地址导入校验与 DB 写入测试
