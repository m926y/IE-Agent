# 行安平台开发约定

当前仓库为v0.3.0完整合并版，首次运行以README.md和docs/DEPLOYMENT.md为准。

- 本地完整模式需要Node.js 24+，使用server.mjs及server/模块，不再是早期单文件云端演示。
- src/为React界面；server/local-database.mjs通过私有回环网关访问SQLite业务库，并只读挂载完整历史索引。
- 三种主要角色为safety_admin、safety_officer、driver。实际权限在服务端验证，司机范围从当前登录身份取值，不能相信客户端自报driver_id或角色。
- 管理员可通过版本化配置修改权重、因子、严重度、参考口径并重算；安全员没有该能力。历史原始索引保持只读。
- 原始车辆编号用于内部关联，界面统一通过vehicle_labels展示“车辆1”等编号。
- 事件来自2026年6—7月历史数据。回放不等于真实车端实时数据；报告日、查询截止日和实际数据日要分别说明。
- 培训仅分配给符合门禁的C/D级对象，课程必须已审核。保留题目、反思、行动计划、人工验收、退回补学、课程快照和版本冲突保护。
- AI通过受控工具读取数据，创建账号、批量培训等写操作先准备清单并等待用户确认。不得绕过权限、课程审核或直接执行模型生成的SQL。
- 保持聊天、通知、案卷、培训、简报、交接单的来源关联与幂等，阅读通知不自动完成待办。
- .env.local、var/、账号初始密码、会话、个人资料、聊天和本机依赖不得提交Git。发行数据通过Release附件及校验清单提供。
- 初始账号由setup-local.mjs在安装者本机随机生成，不在源码或发布数据库中预置密码。
- 公开数据打包只能操作备份副本，不能清理本机正在使用的业务数据库。

修改后执行typecheck与build，按影响范围运行相关测试。路径与发行改动运行tests/distribution.test.mjs；模型改动运行tests/model-duty.test.mjs。数据/集成测试使用临时库，不修改开发者业务状态。不为无关文案反复运行完整数据重算。

## 托管双模说明（2026-11-02 起）
- `APP_DATA_MODE` 未设（平台托管）时，司机投影与每日简报/学习报告/行动中心走 **Supabase 宿主实现**（DUAL 分发）；`=full`（本地完整数据工作台）走集成分机。修改 `server/daily-report/`、`server/driver-actions.mjs` 时两模式同时生效，回归至少覆盖云端矩阵（BASE=r34/r37/r40 电池）。
- 迁移 SQL 不要包含 RENAME COLUMN / DO $$ 语句：平台 WAF 会静默返回 punish 页（http 200 但无效果）。列命名与 UI 契约不同时，在宿主输出层映射（如 handover_reports.trigger_kind → report.trigger）。
