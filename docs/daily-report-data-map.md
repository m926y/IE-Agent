# 每日安全简报：阶段 0 数据映射与接入点

核对日期：2026-10-30。范围是当前本地工作台及项目同级 `IE亮剑/outputs/agent_starter/import/` 来源清单。本文件记录阶段 0 来源现状和读取约束；当前实现见[每日安全简报说明](daily-report.md)。来源 CSV、`.local/` 运行库均未修改。

## 运行与存储现状

| 对象 | 已核对的实现 | 后续接入位置 |
| --- | --- | --- |
| 启动 | `npm.cmd start` → `scripts/local-workbench.mjs` → `openLocalStore()`、本地 broker、子进程 `server.mjs`；默认监听 `127.0.0.1:3100` | 日报后台任务应随本地服务生命周期启动，不依赖页面打开；测试用新的 `LOCAL_STATE_DIR` |
| 构建与验证 | `npm.cmd run typecheck`；`npm.cmd test` 已包含 `npm run build` 和 Node 测试；另有 `test:driver`、`test:ui` | 阶段 1 加入独立的确定性统计与事实校验测试 |
| SQLite | Node.js 24 `DatabaseSync`，数据库为状态目录内 `workbench.sqlite`；来源业务行位于 `objects(table_name,record_id,payload)`，非指南示例中的同名物理表 | 新日报表要在 `scripts/local-data-store.mjs` 使用增量 DDL；复用 `transaction()`，不能把指南 SQL 直接用于来源对象表 |
| 来源 | `manifest.json` 和 `data_dictionary.json` 约束导入，逐 CSV 核对行数并记录 SHA-256；空字符串转 `null`，数字转有限值 | 只读适配层从 `store.rows()` / 受保护查询读取；保留 `sourceHash`、行级 `source_version` 与所用记录 ID |
| 本地 broker | `scripts/local-broker.mjs` 只接受本机密钥，`objects` 主键与幂等索引由 SQLite 保证；算法事实表禁止 HTTP 写入 | 日报若使用独立表，应由受控服务端事务写入，并复用审计和持久 outbox 设计 |
| HTTP 与会话 | `server.mjs` 的 `ROUTES` 表分发；`authenticate()` 从 Cookie 会话读取 `app_sessions`、`app_users`；`requireVerifiedDriver()` 校验角色、已核实绑定与司机 ID | 司机接口在路由处理器内从会话取 `driver_id`，逐报告/通知验证归属；管理员入口按能力及车队范围限制 |
| 前端 | `src/App.tsx` 按角色进入 `DriverShell`；`src/driver.tsx` 的 `TABS` 包含“我的安全 / 历史风险与沟通 / 培训任务 / 我的资料”；请求封装在 `src/api.ts` | 阶段 2 在 `DriverShell` 增加入口，复用 `DriverNavigationProvider` 和现有数据时间、历史回放提示 |

`server.mjs` 中的托管兼容逻辑不是本地模式的数据来源。`scripts/local-workbench.mjs` 设置 `IE_LOCAL_SOURCE_ONLY=1` 并关闭外部 AI、远端业务数据和外部导入。日报阶段 1 可先用本地确定性模板组织文本，不需要模型 API。

## 业务字段字典

下表字段名均取自来源 `data_dictionary.json` 与 CSV 表头。主键是来源 ID，不是日报新表的主键。除特别注明外，空白表示未知，不能按零处理。

| 来源与行数 | 身份 / 时间 / 数值字段 | 日报用途及边界 |
| --- | --- | --- |
| `drivers`，500 | `driver_id` 主键；`gpsno`、`fleet_id`、`identity_status`、`mapping_start`、`mapping_end` | `driver_id` ↔ `gpsno` ↔ `fleet_id` 的授权关联。来源身份状态均为 `synthetic_demo_mapping`，技术账号的 `binding_verified` 只表示本地演示绑定，不构成真实身份核验。读取时检查映射有效期及唯一性。 |
| `score_history`，4000 | `score_id` 主键；`driver_id`、`gpsno`、`as_of_date`、`window_start`、`safety_score`、`score_method`、`score_status`、`confidence_level`、`source_version`；另有六维 `*_contribution` | 8 个日终历史评分截点。用于寻找截止日前最新评分及候选前期评分；须保留窗口、方法、版本与可信度。`rank`、`risk_level`、`confidence_score`、`confidence_adjusted_floor` 可作原始事实展示，不另造评分。 |
| `score_snapshots`，500 | `score_id` 主键；同上核心字段，另有 `reference_version`、`score_change_7d`、`primary_risk_dimension`、`top_reason_1..3`、`recommended_action`、六维事件计数与贡献 | 仅 2026-07-31 截止的最新来源快照。`score_change_7d` 是来源既有字段，不等于日报自行证明的可比两期差值；建议及风险文本只能按来源事实和证据使用。 |
| `deduction_ledger`，6267 | `ledger_id` 主键；`gpsno`、`event_type`、`dimension`、`event_count`、`decayed_severity`、`dimension_points`、`allocated_points`、`allocation_rule`、`as_of_date`、`source_version` | 2026-07-31 的扣分分摊台账，按 `gpsno` 与评分截止日关联。是聚合分摊，不是单次事件日志；`event_count` 不可当作日报近 7 日独立事件数，`allocated_points` 不可当作事故因果效应。 |
| `replay_events`，883 | `event_id` 主键；`driver_id`、`gpsno`、`event_time`、`replay_date`、`event_type`、`event_name`、`dimension`、`speed_kmh`、`is_replay`、`source_version` | 可按 `driver_id`、`event_id` 去重并引用的历史回放证据。仅 2026-07-29 一天，全部 `is_replay=true`；没有完整的近 7 / 30 日连续事件覆盖。没有里程、时长或趟次分母，风险率须为 `null`。 |
| `risk_snapshots`，500 | `snapshot_id` 主键；`gpsno`、`risk_prob`、`risk_rank`、`as_of_date`、`horizon_days`、`source_version` | 2026-07-31 的 40 日预测快照，仅可标成历史预测，不是已发生事件，也不是日报新风险评分。 |
| `training_courses`，3 | `course_id` 主键；`title`、`dimension`、`content`、`completion_requirement`、`content_status`；导入时附加 `version_no=0` 与文件哈希 `source_version` | 三门来源课程均为 `demo_draft_requires_team_review`，没有可正式推荐或分配的 `approved` 课程。后续只能读取真实人工审批后的状态，不复制测试审批。 |
| `evaluation_rules`，6 | `dimension` 主键；`dimension_name`、`weight`、`window_days`、`score_method`、`editable`、`source_version` | 来源评分口径参考，当前窗口 `window_days=14`。日报风险排序若另设规则，必须与来源安全分及其权重区分。 |
| `alerts`，0 | `alert_id`、`driver_id`、`gpsno`、`evidence_id`、`occurred_at`、`is_replay` 等 | 来源当前无告警行；不能将空表解释为零风险。运行时人工工作流记录与回放事件应分开。 |

来源样本（仅选取真实行的必要字段）：

```json
{
  "driver": {"driver_id":"DEMO_D0001","gpsno":"95200275","fleet_id":"DEMO_FLEET","mapping_start":"2026-06-01","mapping_end":"2026-07-31"},
  "score_history": {"score_id":"95304343_2026-07-24","driver_id":"DEMO_D0460","as_of_date":"2026-07-24","window_start":"2026-07-11","safety_score":100.0,"confidence_level":"low","score_method":"fixed_exposure_event_increment_v2","source_version":"snapshot_ffbc02143fcb"},
  "deduction_ledger": {"ledger_id":"95200275_30000_2026-07-31","gpsno":"95200275","event_type":"30000","event_count":13,"allocated_points":0.3864929016495546,"as_of_date":"2026-07-31"},
  "replay_event": {"event_id":"REPLAY_2026-07-29_0000001","driver_id":"DEMO_D0149","event_time":"2026-07-29 00:01:08","event_type":"30002","event_name":"左车道偏移","is_replay":true},
  "course": {"course_id":"DEMO_C01","title":"跟车与车道保持复盘","content_status":"demo_draft_requires_team_review"}
}
```

样本跨不同来源行，用来证明字段形态，不表示这些行属于同一司机或同一日报。

## 日期覆盖与可比口径

- 500 名司机属于来源唯一车队 `DEMO_FLEET`，映射有效期为 2026-06-01 至 2026-07-31。`score_history` 覆盖 2026-07-24 至 2026-07-31 共 8 个截点、500 名司机；`score_snapshots` 和扣分台账只在 2026-07-31 有截点。
- 回放 `event_time` 覆盖 2026-07-29 00:01:08 至 23:59:08，`replay_date` 只有该日。来源未提供逐事件 `ingested_at`、驾驶里程、行驶时长或趟次，因此无法可靠计算近 7 / 30 日完整事件率或新增导入时间。发布日期在覆盖期之后时必须显示“历史数据分析”和实际覆盖范围。
- 既有 `server/driver-actions.mjs` 中 `scoreComparison()` 要求本人两个不同截止日、相同 `source_version` 与 `score_method`、两期分数有限且可信度为 `medium/high`，否则差值为 `null`；窗口缺失、重叠时还要说明不能据此判断独立周期或改善效果。日报应复用这一初筛，再明确是否允许显示仅供核对的数值差，不能把滚动 14 日窗口当作独立周评分。
- 既有 `fleetStatistics()` 取同车队、同截止日，`score_status` 属于 `usable / usable_with_review / manual_review`、分数有限、每司机恰好一行、来源版本与评分方法一致的样本。少于 10 人时隐藏人数、均值与分布；混口径时不算均值；细分分组可能反推个人时隐藏分布。日报的车队均值也须核对与个人分数同口径，不能仅取最近可用的另一日期均值。
- 风险事件计数仅在确证窗口覆盖时可称“近 7 日”；当前单日回放只能称“2026-07-29 已记录事件”。`deduction_ledger.event_count` 是评分分摊统计，不可和 `replay_events` 相加。无新记录不等于新一天零风险，低可信评分应提示先核验数据。

## 可复用的服务与页面接入位置

1. 只读数据适配：`scripts/local-data-store.mjs` 的 `rows/get` 及来源哈希，或 `server.mjs` 已有的受保护数据查询；新增读取函数须按会话司机、车队、日期与来源版本过滤，并在大表读取时显式处理分页和读取失败。
2. 身份与证据：`server.mjs` 的 `requireVerifiedDriver()`、`listResource()`、`handleDriverEvidence()` 和 `server/driver-actions.mjs` 的 `scoreComparison()`、`fleetStatistics()`。日报证据可复用现有 `GET /api/driver/evidence?kind=...&id=...` 的逐条重新验权语义。
3. 后续 HTTP：在 `server.mjs` 的 `ROUTES` 增加日报、历史、通知和管理员任务入口；现有 `notification_events` 有 `target_user_id`、`idempotency_key`、`read_at`，可评估复用，不能照抄指南中另一套通知表而产生重复消息。
4. 后续存储与调度：在 `scripts/local-data-store.mjs` 增量建表和事务实现版本化报告、持久任务与通知原子写入；在 `scripts/local-workbench.mjs` 的后台工作生命周期接入每日检查与重启补偿。现有 `drainOutbox()` 只处理培训/复核提醒，不是日报调度器。
5. 后续司机页面：`src/driver.tsx` 的 `TABS` / `DriverShellContent`、`src/api.ts` 的请求封装和现有 `DriverNavigationProvider`。目前没有“今日安全简报”或“安全动态”页面，也没有日报 API。

## 阶段 0 验证

在本地 Node.js 24 环境执行：`npm.cmd run typecheck` 通过；`npm.cmd test` 通过，含构建，32/32 测试通过。页面流程未修改，因此本阶段未运行 UI battery。构建产物位于忽略目录；按仓库约定另运行清单脚本更新代码及来源哈希。
