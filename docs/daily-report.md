# 每日安全简报：现行实现与验收

## 目标与来源

`npm.cmd start` 启动本地工作台后，后台每天上海时间 07:00 起读取项目同级 `IE亮剑/outputs/agent_starter/import/` 的已校验来源，为来源司机生成并归档历史安全简报。司机无需保持页面在线；已核实绑定且账号有效时可收到站内通知并查看本人报告。当前 Agent 是“只读事实 → 确定性分析 → 报告组织 → 事实校验 → 发布”的自动执行链，暂不调用模型 API、远端数据库或外部业务数据。

来源字段、日期范围、评分口径和三个待审核课程见[来源数据映射](daily-report-data-map.md)。当前回放只覆盖 2026-07-29，评分有八个历史截点。缺少完整近 7/30 日覆盖与里程、时长、趟次分母，因此不计算近 7 日风险数或事件发生率；评分窗口重叠时不报告可比差值。没有本人回放证据不等于零风险。没有真实人工审批，课程不会进入正式推荐或分配。

## 代码与报告契约

| 位置 | 职责 |
| --- | --- |
| `scripts/daily-report/data-reader.mjs` | 按来源司机映射与统计截点读取本人评分、回放、同车队评分及截至截点已审批课程；输出来源指纹 |
| `safety-analyzer.mjs` | 复用现有评分与匿名车队规则，按本人已观察事件数排序；缺失和不可比值保持 `null` |
| `report-agent.mjs`、`report-schema.json`、`report-validator.mjs` | 确定性组织 JSON，校验全部数值、证据、课程及历史数据措辞；现行 Schema 为 v2，旧版报告快照仍可读取 |
| `report-service.mjs` | `generateDailySafetyReport(store,driverId,reportDate)`；统计截至前一日 `23:59:59+08:00`，并读取上一期目标上下文 |
| `report-store.mjs` | SQLite 报告版本、目标关联、站内通知及审计的事务发布；手动修订保留旧版 |
| `report-scheduler.mjs` | 每日任务、原子认领、租约、失败重试与跨日重启补偿 |
| `server.mjs`、`src/daily-report.tsx` | 服务端身份与车队过滤、管理员任务入口、司机端报告与证据页面 |

报告的风险排序依据为本人可核验的同类历史回放计数，`priorityScore=null`，不声称事故预测。卡片、目标和课程引用必须与冻结快照完全一致；校验失败不发布。行动建议优先取与主风险维度一致的来源评分快照原始建议，否则只建议核对历史证据。司机端“为什么推荐”展开区显示排序依据、来源覆盖和本人证据入口。

课程只有在 `content_status=approved`、审批更新时间不晚于报告截点、课程维度与主风险一致时才成为学习提示；提示不等于正式分配。真实来源的三门课程目前均待审核，因此日常运行的 `approvedCourseRefs` 为空。

## 跨日报目标

每份有本人风险证据的报告保存一项目标，并用 `previous_goal_id` 关联上一期目标。新报告冻结上一期状态、司机反馈及是否出现新的本人评分或回放证据。当前目标是“核对历史证据”；现有来源没有足够的可比暴露量，也不能证明核对已完成，因此评估保持 `pending_evidence`。已读、计划核对、需要协助和暂不跟进只记录实际意向，不自动变成“已改善”。新证据出现时仍明确说明不能直接判断行为改善。

## 发布、通知和权限

SQLite 增量表为 `daily_safety_reports`、`driver_safety_goals`、`daily_report_jobs`；通知复用现有 `notification_events`。同一司机、日期和版本唯一，来源指纹相同的重试不增加报告或通知。自动任务分批认领，租约过期后可由新工作者接管，旧令牌不能提交；失败最多重试三次。报告、目标、通知、审计与任务成功在同一事务提交。重启先恢复跨日已创建任务，上海时间 07:00 前不提前创建当日任务。

管理员可手动发布或明确允许来源变化后的新版本，并在任务页查询状态、失败次数和错误。司机端仅从已核实会话绑定取得司机 ID，可查看今日报告、历史版本、通知和目标反馈；跨司机访问被拒绝。管理员任务列表按车队范围过滤。司机页面每 60 秒刷新报告与未读数，不从前端触发生成。没有绑定账号的来源司机仍可生成报告，但不会虚构账号或通知接收人。

主要接口：`POST /api/admin/daily-reports/run`、`GET /api/admin/daily-reports/jobs`、`GET /api/driver/reports/today`、`GET /api/driver/reports/history`、`GET /api/driver/reports/:id`、`GET /api/driver/notifications`、`GET /api/driver/safety-goals`、`POST /api/driver/safety-goals/:id/feedback`。通知已读复用 `POST /api/notes/:id/read`。

## 运行与验证

```powershell
npm.cmd start
npm.cmd run typecheck
npm.cmd test
node scripts/source-ui-battery.mjs
node scripts/daily-report/ui-smoke.mjs
node scripts/build-local-manifest.mjs
```

浏览器脚本需使用项目既有隔离 Playwright 环境。所有自动化测试在 `.source-tests/` 建独立 SQLite 库，不读写用户 `.local/`。专项测试覆盖不同司机、缺失与低可信评分、审批截点、跨日报目标、事实篡改拒绝、身份和车队范围、事务回滚、幂等、重启恢复以及 500 名真实来源司机的批量任务。测试时钟只通过隔离测试的 `startLocalWorkbench` 参数注入，不覆盖生产业务时间或原始 CSV；不预置虚构业务数据。当前验收不代表 PostgreSQL 迁移或公网部署。
