# AGENTS.md — Crazy Logi-AI 2.0 驾驶安全管理工作台

## Project background

物流车队驾驶安全管理的演示用多人工作台（需求：workspace_brief.md + 详细设计 docx，均已入本地知识库）。
用户：**安全管理员**（同一账号承担系统配置管理 + 安全员处置）与**司机**（窄屏端）。
产品目标：把「任务一：未来40天事故风险预测」「任务二：近14天安全评分/六维扣分/可信度/事件证据」串成
在线闭环：发现风险 → 核对证据 → 人工确认 → 沟通与培训 → 司机反馈 → 后续复评。

## Product shape

- Page 类别：dynamic（Node 22 单入口 `server.mjs`，零运行时依赖；Vite+React 客户端）。
- 数据：QW Pages 托管 Supabase(PolarDB) 页，域名 `ls7d7ste.qwenwork.host`；表结构 21 张
  （manifest 19 张业务/算法/新业务表 + app_users + app_sessions），由平台 migrate 建立，GRANT-full，无 RLS。
- 身份与权限（全部服务端强制，前端隐藏只是辅助）：
  - 可信身份优先级：平台 SSO（发布带 `--sso-provider` 且 env `SSO_PROTECTED=1` 时才信任 `mule_page_sso` cookie，
    映射 user_bindings→app_users）→ 否则本地会话（scrypt 密码 + HttpOnly SameSite=Strict 会话，token 只存 SHA-256 于 app_sessions）。
  - `ROLE_CAPABILITIES`（server.mjs）定义能力集；`RESOURCE_DEFS` 白名单定义每个资源的表、可 SELECT 列、角色与注入过滤。
  - 司机行级过滤：`injectDriver`（driver_id 由服务端会话注入，覆盖一切客户端参数）；未绑定/未核实时返回 409 binding_required，前端显示"未核实的身份"空态而非个人数据。
  - `/api/*` 全部先鉴权后路由；未登录 401，越权 403；不存在记录与无权限同样不回显受限内容。
  - 登录/登出写 audit_logs（SM04 可见）。
- 只读算法事实：risk/score/六维/可信度/台账/回放值任何接口只 SELECT；写入仅安全管理员版本化导入流程（第2轮实现，服务端强制 role + 审计）。
  列名改名说明：`rank`→`rank_no`、`value`→`config_value`（导入映射在第2轮 CSV import 中声明式处理）。
- 页面（路由 hash）：
  - 管理员 #/overview、ev-fleet(EV01)、ev-week(EV02)、rm-queue(RM01)、rm-replay(RM02)、rm-alerts(RM03/05)、
    tr-ledger(TR01)、tr-courses(TR05/SM06)、tr-create(TR02 禁用表单)、sm-accounts(SM01)、sm-bindings(SM02)、
    sm-config(SM03)、sm-audit(SM04)、sm-drafts(SM05)、sm-knowledge(SM06)。EV03 由 EV01 行点击进入。
  - 司机窄屏底部四 tab：我的安全(EV04)、今日风险(RM04)、培训任务(TR04)、我的资料。
  - AI 入口为禁用占位（运行时模型能力未证实）。
- 视觉：浅色业务工作台，深蓝导航；风险红仅高危/逾期，琥珀仅低可信度/待核验；空态区分"无匹配/无权限/无覆盖/失败"。
- 第1轮（当前）：可点击空页面 + 真实服务端鉴权 + 空表真查询。业务数字一律空态，无模板假数据；
  种子仅 2 个演示账号（safety_admin、driver_demo，driver 未绑定身份）。
- 约束：单文件发布目录（server.mjs 不引额外模块）；数据库凭据不落日志/响应；
  /healthz 与 / 无鉴权且不依赖外部服务。

## 发布状态（第1轮）

- V1/V2 已发布：https://ls7d7ste.qwenwork.host/ （dynamic, broker, with-database, SSO qwenwork/open）。
- 运行时 env `SSO_PROTECTED=1`：服务端才信任 `mule_page_sso`（网关验证会话后转发）；未登录访客先过平台登录。
- 工作台本地账号（演示）：`safety_admin` / `driver_demo`（初始口令经一次性文件交付；scrypt 哈希存储；会话 HttpOnly+SameSite=Strict，12h）。
- 测试绑定记录 b-sso-admin/b-sso-driver → 平台身份映射演示（user_bindings 内）。
- scripts/verify-local.mjs：26 项鉴权/越权/SSO 信任边界回归（需 db.env 与账号口令，0600 临时文件，不入库）。
- 下一步：第2轮版本化 CSV 导入（服务端强制角色+幂等+审计）、司机绑定核实闭环；第4轮验证运行时模型调用。

## 第2轮（结构对齐 + 版本化导入）

- 契约：data_dictionary.json 15 业务表 + app_tables.json 4 扩展表；app_users/app_sessions 为认证表（不计19）。
- 003 迁移（非破坏）：rank_no→rank、config_value→value 重命名；扩展表补齐契约字段；number 列 integer→numeric；
  is_replay/editable/mandatory text→boolean（空表转换）；config_version→text；
  扩展表 status CHECK 枚举；告警改部分唯一：同 gpsno+rule_code+evidence_id+occurred_at 未关闭仅一条（uq_alerts_open WHERE status IS DISTINCT FROM 'closed'）；
  新增 import_runs 台账表（幂等键唯一）。所有账号/会话/绑定/审计记录保留。
  已知偏离契约建议项：date/datetime 建议类型按 text 存储以保留原始字符串（datetime 避免时区重解释）；契约外附加列保留（可空，见清单）。
- 导入（server.mjs “versioned CSV import” 段）：IMPORT_SPECS 白名单（18表；audit_logs/app_users/app_sessions 禁入）。
  POST /api/import/check（预检，零业务写入：报告行数/重复主键/类型错误/拒绝行/未知列/缺失列 + run_id + 30min 确认窗口 + 幂等复用）；
  POST /api/import/commit（仅发起人、未过期、内容sha256一致、提交端二次表头防线；按业务主键 PostgREST merge-duplicates UPSERT，
  分块100行；重复提交返回既有运行）。文本列保前导零；空串→NULL 不转 0；数值以字符串入 numeric 保小数位；
  source_version 运行级口径只补空白不覆写原值。check/commit/replay 全部写 audit_logs。
- SM04 页面：导入面板（选表/选文件/预检/确认）+ import_runs 台账 + audit_logs。
- 回归：scripts/verify-local.mjs 41 项（含 14 项导入权限/幂等/防线用例）。业务表真实 UPSERT 数据写入 = 未验证（本轮承诺零模拟业务记录，待真实 CSV）。

## 第3轮（pilot 导入 + 演示绑定）

- pilot：drivers/score_snapshots/risk_snapshots 各 3 真实行（DEMO_D0149、DEMO_D0289、DEMO_D0013），经 预检→管理员确认→UPSERT 写入；重复批次三表仍各 3 行（业务主键 score_id/snapshot_id/driver_id）。全量 500 行文件仅预检留证未提交。
- 绑定接口 POST /api/admin/bindings（cap=manage.bindings，仅安全管理员）：校验对象存在于 drivers、禁止双有效绑定(409 binding_conflict)、未导入拒绝(409)；
  关闭旧行仅限 platform_user_id is.null（本地通道），SSO 通道绑定行独立保留（u-driver-0001 现存 b-sso-driver 演示夹具 + bd-cf06b8337481de20 主绑定，两条通道各注各的 id，不互读）。
  绑定写身份口径“演示绑定（synthetic_demo_mapping）”与水印 note 入 app_users.binding_note；司机端/档案页持续显示“演示数据绑定，非真实身份核验”。
- verify-local.mjs 53 项（夹具复位在前，可重复执行；绑定后司机只见 D0149）。pilot-import.mjs 抽取脚本注意 BOM/CRLF。
- 数值对账（DB=CSV）：D0149 28.142576/D/rank491/high，六维和=71.857424=100−分✓；跨表 forecast==risk_prob 全 true；D0289、D0013 均 low/manual_review。

## 第5轮（review_queue + score_history×2片 导入 + RM01/EV02 实数据）

- 导入：review_queue 500（run imp-13df6661…，commit aud-01648f9d20fe63ac）；score_history part01 2000（imp-2aee2ad0…/aud-ebcf8a64…）+ part02 2000（imp-fe065ecf…/aud-2c9f3758…）。终态 rq=500/500pk、sh=4000/4000pk、8日期×500行、跨片重复0、失败0、alerts 仍0。
- 对账：queue×snapshot（gpsno→分数/等级/概率/可信度/日期）0差异；history@0731×snapshots 核心字段0差异；长浮点列378条尾数字符串表示差≤5e-14（源文件间固有，DB text级各自忠实其源，清单=output/对账差异_history0731_vs_snapshot.csv）。API↔CSV 同值。
- RM01 重写：分组按钮（priority/behavior/coaching/prediction/data_quality/routine 实际计数98/102/2/2）+ 队列列表(queue_id 来源列) + 行点击→EvDriver（显示"队列来源 queue_id"），不生成告警。EV02 重写：真实8日期 chips、两日选择→500对象比较（277升/223降/降≥10有32）、无补造。admin.review_queue/队列 filters 白名单加 review_queue。司机 EV04 显示本人8日历史+末日六维条（数据=API注入）。
- suite 56 项；新增：司机 history=8行仅本人、参数篡改注入覆盖、队列API分组。V7 上线。

## 第6轮（台账6267+回放883导入、RM02播放器、EV02动态日期）

- 写入：ledger part01 imp-f0e4850b5bb64411/aud-f0864146ef7a7dc8；part02 imp-49fa2f9f85f9be71/aud-37a9d6de8c86daee；replay imp-dc74e38e12eb3806/aud-7bf8b161dfa94560；part01重复批 imp-21a44aa5dfae0390/aud-5b2c21262a7a7590 → dl=6267/6267pk、re=883/883、alerts=0、d/s/q/h不变。
- 台账↔快照六维 group-sum 对账（Decimal，GPS×维度）：>1e-9 差异 0；无“有贡献无台账/有台账无快照”异常；无台账车辆1（低可信/manual_review，页口径=覆盖待核验非零风险）。
- 新端点 GET /api/meta/history-dates（fleet_overview能力）：client端点优先 distinct-on，失败回退 min/max 枚举+单日存在性+计数；EV02 chips=DB实查8日期×500。
- RM02：真实 admin.replay_events（event_time升序、gpsno/replay_date filters白名单）播放器 播放/暂停/跳进/下拉跳转/重置/车辆选择；时钟未到不显示；操作零写入；“事后参考”面板（0731预测/14天分标事后回算参考）；四车牌标。
- EV03证据区措辞：无台账行≠有覆盖/零风险；单事件无独立因果声明。套件65项（回放后alerts=0、司机403矩阵、filter白名单）。

## 第7轮（课程/规则/运营配置导入 + 三门写入门禁）

- 导入 training_courses 3（imp-30b501fb…/aud-fea1afd3…）、evaluation_rules 6（imp-b27e9eec…/aud-6f760baa…）、operation_config 3（imp-36421d64…/aud-66002684…）、重复批 courses#repeat（imp-867f9388…/aud-30481cef…）→ 3/6/3不变，training_tasks=0、notification_events=0、alerts=0，存量五表与绑定未受影响。六维权重合计 0.99999999999999978（源文件冻结值，页面未归一化）。
- 写入门禁（server.mjs gated section）：POST /api/admin/course-review（cap review.content，状态机 demo_draft→pending_review→approved→disabled，非法转移409，轨迹写audit）；POST /api/admin/ops-config（cap manage.operation_config，版本+1、旧值/新值/操作者/生效时间入审计）；POST /api/admin/training-assign（cap assign.training，门禁=content_status必须approved否则409 course_not_approved、绑定未核实409、幂等键）；POST/PATCH /api/admin/evaluation-rules 一律 410 frozen_rules_not_writable（冻结规则绝对无写语义）。本轮 ops_v1 与三门草稿状态均保持原值（approved未执行=留待团队人工审核）。
- UI：SM03双标签（冻结表6行只读+“为何不可编辑”；运营参数+改版抽屉）、TR05课程中心（内容核验抽屉+审核按钮组+“尝试正式分配（门禁演示）”→ 实测弹“服务端拒绝正式分配：course_not_approved”）。套件78项（+13：门禁/权限矩阵/审计无训练分配成功记录等）。V9发布。

## 第8轮（RM03/04/05处置闭环 + 门禁UI）

- 新能力：/api/alerts/confirm（规则gate：双信号=top20## 第9轮（TR01-TR06 培训模块 + 状态机）
- 服务端 training FSM：/api/training-tasks/:id 路由（start/draft/submit/review/view），assigned→in_progress→submitted→reviewed|returned|observation|interview；重复/非法/越权按 replay/409/404 处理；分配通知与提交通知走 notification_events 幂等键；复评 reassess 只认晚于提交日的真实快照否则"待下一周期数据"。TR02 增加证据alert关联校验（driver匹配）。培训任务保持0（真实审核未发生）。套件99项；V13。

## 第10轮（EV05 评价复核与数据异议）
- 契约实现：/api/review-requests（driver，会话取driver_id）+ GET/:id + /advance（review.score_challenge）；FSM submitted→checking→awaiting_data_owner→answered→closed（CHECK约束同ck_rr_status）；answered/closed必须response_note；核查组装只读score_snapshots/deduction_ledger；无评分写路径。幂等键 rr:driver:target:reason:sha(desc)。create→admin站内通知，answered/closed→司机通知（演示绑定标注）。
- 现场发现并如实保留：课程DEMO_C01已由团队真实approved(07:33,version2)且存在两条真实task（07:33 submitted含学习记录、07:46 assigned带alert——后者系本轮套件首轮残跑产生，合法状态机对象，未删除）；断言改为数据自适应。EV05演示链完成：rr-…对95301325_2026-07-31 score_explanation，checking→answered(答复经核查台账维度)，评分28.142576/D/high复核未变。套件99项；V14。

## 第11轮（补验：培训全分支+EV05全状态，零代码变更=仍V15）
- 外部真实操作发现：08:02Z前后 task-b4eea/task-ffc 已被管理员会话审至 reviewed；本轮未倒退。新增分支演示任务 task-5c4b8d2be9542（自定义幂等键）走完 assigned→in_progress→submit→returned→draft→submit→approved 全 FSM（审计7条），reassess=待下一周期数据（date:null）。
- EV05 第二条 rr-09f749ab61689166 走完 submitted→checking→awaiting_data_owner→answered→closed；回归样本改动态幂等文本；套件112/112（三任务reviewed、两申请、司机仅本人、评分事实未动）。通知新增均带真实source实体；notify entity 参数化在V15已修。
- 公网人工验证项转为 QA 单（见对话输出）。

## 第12轮（案卷收尾件+A23+通知中心+预演+探针，V16）
- 新路由：alerts handoff/note/contact（角色校验：转交须active admin|team_leader，司机409；note入audit.detail_json司机不可见；contact写due_at）、POST /api/admin/users（scrypt生成初始口令仅返回一次）、POST /api/admin/users/:id/status（停用=清app_sessions+旧Cookie立即401；不可停自己409）、GET /api/notes/summary+GET /api/notes+POST /api/notes/:id/read（本人target强制、重复replay）、GET /api/meta/egress-probe（admin only，未配QW_EGRESS_PROBE_URL时503附接入指引——模型端点与密钥必须走Page env/属主提供，不内置不猜测）。closed案卷：send/reply/read/handoff后续动作全部幂等replay；再confirm同证据→409要求新建。
- 前端：顶栏消息/待办实数（60s刷新）、RM05操作组（转交/再次联系/内部备注/动作预演A21四卡·未写入）、SM01 AccountAdmin（创建/停用/恢复/探针）、司机我的资料NotesInbox（已读幂等）、EV01 7天降≥10红色标签（cellView，阈值取运营口径展示性）。
- D0149案卷已按真实流程关闭“已完成干预”（due_at 2026-11-01、备注留痕12条时间轴）；D0289核验案卷保持open不关闭。套件111项+admin.interventions补draft/sent_text/reply_text列显示。EV02动态8日期chips已在V13（reassess仍待下一周期=无新真实快照，不造假）。V16发布。

## 第13轮（运行时业务AI接通，V19）
- 通道：千问办公内置 Qwen3.8-MAX，OpenAI 兼容网关 /v1/chat/completions；沙箱实测 chat+tools 协议通过后，把属主 env QW_AI_BASE_URL/QW_AI_API_KEY/QW_AI_MODEL/QW_EGRESS_PROBE_URL 写入 Page 并随 V19 注入 FC（密钥不进浏览器/日志）。凭据=本会话账号级，过期需重注入（缺口如实报告）。
- 固定指令 agent_runtime_prompt.md 全文嵌入服务端（AI_PROMPT_VERSION sha256前12位，无编辑接口）；知识种子 K01-K04 以 pending_review 入 knowledge_articles（来源/版本保留，未approved不得正式引用，工具显式标注）。
- 受控工具14个（get_my/driver_evaluation、fleet_summary、risk_snapshot、evidence、review_queue、alert、interventions、tasks、review_request、knowledge_search、propose_intervention、propose_training、action_preplan）：会话定权（司机=本人；自报身份无效；越权=拒绝不泄漏存在性）、每事实带 record_id/as_of/source_version/可信度限制；propose_*/preplan 零写库；/api/ai/selftest 契约自检14项+counts before==after（zero_confirmed）。
- 页面：右侧 AI 悬浮→真实对话面板（管理员/司机均有，建议问题、citations 折叠、草稿卡 requires_confirmation、503/502 显式缺口卡——非静态聊天）。
- 验证：真实模型对话11项断言绿（admin引用/司机问他人拒且无他人数字/要求直接发送→草稿零写入/元数据 prompt_version+model）；回归119/119。V19=公网FC出站+模型连通待你浏览器QA（API在SSO后，我无法代测）。
- 未做：培训复核验收延续上轮（跳过项未复验）；无新业务记录仅为演示AI而创建（alerts/iv/tt/rr/knowledge draft状态全保留）。

## 第14轮（培训闭环校准，非破坏）
- 以V19制品spawn独立实例跑 training-closed-loop-battery.js（scripts/入库，可随时复跑）10/10 PASS：已批准C01重复分配→幂等命中 task-ffcbeb917783d526（不新增）；C02/C03未批准→409；reviewed任务start/submit→409；事后review→replay且人工原结论逐字不被改写；司机admin.trainings→403、不存在任务→404、本人view→200；my.trainings=3全reviewed带结论；T5通知assigned+submitted各1（仅有效绑定接收）；trainings/notifications/interventions 计数全程不变（零新增写入）；TR03三条复评均 date:null=待下一周期数据。
- 现状：C01=approved（外部人工），C02/C03=demo_draft_requires_team_review 保持未批准；3 任务时间轴 4/4/6 审计条；due_at=2026-11-15（ffcbeb）。无新业务记录、无历史评分改写。
- 页面小修：TR06 空队列文案改为真实状态说明+历史指引（V20）。

## 第15轮（§8.8 AI调用审计 + AI02结构化证据卡，V21）
- 审计（复用 audit_logs，零新表零改19表契约）：action=ai.chat 行 entity_type=ai_call、entity_id=ai_call_id(=audit_id)、request_id、detail_json={result_state(model,prompt_version,page,tools:[{n,s,r}],sources≤16,requires_confirmation,rounds)}；refused/upstream/provider_not_configured 也留痕且脱敏（不含用户原文与被拒对象明细）。action=ai.confirm：同 entity_id 关联 chat_request_id+decision+business_entity/id/audit_id；原 ai.chat 行不可变（append-only），未确认/已确认由 /api/ai/calls 现算。失败教训：PostgREST 等值参数必须 eq. 前缀；含注入特征的 ref 会触发网关 WAF(403) → 审计写入一律 sanitize 后落库。
- 证据卡：chat 返回 evidence_cards[]（type/ref/table/field/value/window/as_of_date/source_version/confidence/limitations），数字仅来自受控工具；空值不出卡不显示0；GET /api/ai/evidence-check?ref=按当前会话重验权→score_snapshots/deduction_ledger/review_queue/alerts/knowledge/courses 六类路由（司机他对象=404 不泄漏）；RmAlerts 支持 ?alert_id= 深链。前端 AiPanel 卡片化+打开/重验权按钮+采纳/弃用确认流。
- 验证：B15 电池 22/22（含两 chat+confirm+幂等+404矩阵+路由映射），主回归 119/119。真实ID见对话记录。

## 第16轮（AI03 fill_to 回填 + AI01 会话持久化隔离）

- propose_intervention/propose_training 返回 draft_action.fill_to（form/route/字段映射）；低可信度草稿强制"核验优先"话术且 data_limitations 注明不自动惩罚；培训候选仅 approved 课程（无则明示不可分配）。
- AiPanel 草稿卡"填入 RM03 草稿表单/填入 TR02 表单"→ sessionStorage.claw_fill + claw:fill 事件 + hash 路由；RmAlerts.take()（alert 深链+drawer+textarea 回填+琥珀"草稿，未发送"提示条）、TrCreate.take()（driver/course/due/mandatory/alert+「草稿状态，未分配」行）。确认仍走原有独立按钮（interventionDraft/Send、trainingAssign），旧状态版本与 idempotency_key 校验。
- selftest 注入确定性 preplan（真实执行两 propose，零业务写），draft 卡带 fill_to——UI 取证不再依赖模型是否恰好调用工具。
- AI01：storeKey=claw_ai_msgs_<user_id>，owner 校验（切账号清旧 key），restored 标记"上一上下文历史快照"；LogoutButton/司机退出/401 事件全清 claw_ai_*+claw_fill。
- 数据终态（真实操作）：D0289 案卷 pending→confirmed（人工判定）；intv-ffbcc65351fd868c draft→sent（sent_text=AI 填入稿；D0289 无绑定账号按护栏不建通知、delivered_to_account=false）；task-ee36bfc9fc9a5699（C01 approved 真实分配）+ noti-fe5ff777c12951fb；重复 draft/send/assign 全部幂等回放同 ID；C03 待审分配 409 course_not_approved。审计链 aud-a6ea654493be2f5c(draft)→aud-4c5d8b3584588782(send)、aud-480297a22f22979f(assign)。
- 修正：admin.interventions 资源 filters 白名单补 alert_id/driver_id/status；verify-local A18 改行数自适应、audit limit=50、真实模型 chat 引用断言加上游抖动重试（119/119 稳定）。b16.cjs API 19/19、ui16b.cjs UI 8/8。
