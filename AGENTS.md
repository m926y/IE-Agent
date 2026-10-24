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

## 第17轮（全局搜索 + SM05 规则草案 + SM06 知识管理）

- /api/search?q=：服务端按可信会话过滤。staff=drivers(fleet_scope)/alerts/training_tasks 全量+四类分组计数；driver 仅 binding_verified 后本人 driver_id 范围（他人对象 total=0 且零条目，不泄漏存在性；未绑定→note 提示无个人结果）；知识仅 approved-latest 且 applicable_role 可见；未登录 401；q 清洗（去 ()%,.*^$），注入式 400。route：ev-fleet?driver_id / rm-alerts?alert_id / tr-ledger?task_id(新增 deep-link) / sm-knowledge?article_id；点击后目标页照常二次验权。空/无结果/失败三态。
- SM05：GET/POST /api/admin/rule-drafts + PATCH :id（submit/withdraw/note/archive，状态机+审计），current 直读 evaluation_rules（全等断言）；**无生效端点**；新 AI 工具 rules_read 只读现行冻结权重，草案永不被 AI/页面当参数；红线：erd 流程中 er/sc/ledger 行数 6/500/6267 不变。
- SM06：POST /api/admin/knowledge（新条目=draft，编号自然递增 K5/K6/K7...）、PATCH :id actions=edit(仅draft)/submit/withdraw/approve(pending→approved)/disable(approved→disabled)/new_version(approved|disabled→新draft版本)；同作者 approve 无 confirm_same_actor → 409 self_review_requires_explicit_confirm，确认后审计 detail 留痕。版本规则 official=latest&&approved；knowledge_search 工具重写为正式/草案二列（no_official_knowledge→refs=0）；evidence-check knowledge 支持 ID.version（非 approved 404、版本滞后 stale_version）。
- 现网样本实测：K01-K04 全 pending → AI 正式引用 0（chat refused 语义 + cites=[]）；本轮创建→批准→AI 按版本引用 knowledge:K6.1+证据卡 200→停用→404/refs=0。TR05 三课未审核 409 门禁在位（回归）。
- 根因坑：新 re 路由必须放 CASE_ROUTES（matchCaseRoute 传解好的 id 字符串，非 match 数组）；path 型条目勿误入 CASE 表；API_ROUTES 元素后漏逗号= ASI 静默 undefined 元素（运行时才爆）；principal.user 是 raw snake_case 行（binding_verified/driver_id/fleet_scope）；pkill pattern 误杀自 spawn server→端口预清。
- 电池 scripts/r17-search-sm05-sm06-battery.cjs 28/28；verify-local 断言演化（knowledge 门禁自适应）119/119；V25 发布。

## 第18轮（SM01 账号面板挂载 + 第一轮 R1-01~08 复测）；**本轮未发布**（指令：不发新页、不删原页；线上保持 V25）

- 复用既有后端（A23 创建/停用端点、handleBindingSet、manage.accounts 门禁、USER_PUBLIC_COLS 无口令列），未重建账号体系。新增：PATCH /api/admin/users/:id（display_name/fleet_scope[存在车队校验 unknown_fleet]/driver_id[binding_verified=false→unverified_identity_cannot_bind；active 占用→driver_already_bound_active]/clear_binding），审计 account.edit changed+actor 范围；POST create 加 reveal_password（默认 redacted——**页面不渲染口令**，ui18 DOM 扫描 input[type=password]=0 且无口令文本）；list_resource 对 app_users 按当前管理员 fleet_scope≠* 过滤（本人+本fleet司机绑定账号），现网无 scoped 活跃管理员→该代码路径标未验证。
- 前端 sm18.tsx AccountAdminPanel：表格（用户/角色/状态/driver(核实标注)/fleet/updated）+ 角色/状态/车队筛选 + 编辑抽屉 + 行级停用/恢复 + 创建（角色下拉仅 safety_admin/driver 两类，无第三种管理员登录）；挂载 #/sm-accounts（原 ResourceTable+硬编码 AccountAdmin 移除，BindPanel 保持 SM02）。
- 复测（两会话交错，本地=repo 同码实例，端口级干净）：r18 API 26/26 + r18 UI 7/7 + 主回归 119/119。R1-08 全链（创建→登录→门禁403→未核实拒绑→非法车队拒→fleet 编辑审计→SM02 核实 D0289→唯一性 409→停用旧会话401/重登403→恢复→可检索本人案卷→停自己409→8条审计）；账号头尾清理（stale sm01_retest_* clear+disable 幂等前提）；R1-01 confirm discard 后 calls 查得 decision；R1-02/03/05/06/07 全过（详见 CSV：output/第一轮验收复测记录.csv）。R1-04 补司机跨页旧上下文+owner 隔离 UI 复测；**发布留待用户指令**。

## 第19轮（TR05 课程审核面板 + SM04 审计控制台 + AI 长期摘要 opt-in）；**未发布，线上仍 V25**

- 核对：API_ROUTES=精确 path 或单段 case；matchDynamic 仅两片段；handleAiChat=手动消息路由列表；ops 无 GET 端点——本轮补 GET /api/admin/ops 与 /api/admin/courses、GET+CSV /api/admin/audit(:id)。
- training_courses 无 authored/reviewed_* 列且平台零 RPC/DDL（swagger RPCS=[] 实测）→ 用户允许的"已有内容审核结构"路径：**作者/审核人/审核时间由 audit_logs(entity_type=training_course) 合成**，课程文本零丢失；状态映射 demo_draft_requires_team_review|draft→pending_review→approved→disabled（复用第14轮 handleCourseReview FLOW + course.create/course.edit 新审计动作；停用后禁静默修订 409 only_unapproved_editable）。
- TR05：sm19.tsx CourseBoard 挂 #/tr-courses（筛选/抽屉/window.confirm 明确批准/修订仅未审核/轨迹 audit_id 内链）。三门主课原状态全程保持（C01 approved、C02/C03 待团队审核）——UI 批准动作作用于本轮自建验收课程（多次运行留下 DEMO_UI_R19xxx approved 样本，属真实管理员会话操作；R19C 因行错位 bug 被误批一次，已由管理员会话 disabled 纠正并留审计 aud-96e0…见下——诚实披露）。
- SM04：AuditConsole=服务端 actor/entity_id/action_prefix(like.%)/from/to 筛选+total+分页+CSV 导出（走同一鉴权），详情端点白名单列+detail_meta 正则(redact)+evidence_refs；不返回口令/完整问答。app_users/driver 注入与旧 ResourceTable 保留导入台账。
- AI 长期摘要：operation_config.ai_long_session 行**运行时首开自动建**（ops.config_create 审计）；AiPanel 复选框（默认关/仅 safety_admin），localStorage `claw_ai_long_<uid>`={exp:2h, items:excerpt≤90 脱敏+refs}，重登恢复标 ⌛，一键清除+过期自清+关闭即删；司机不渲染开关不读该键（断言验证）。**绝不存令牌/明文个人数据/业务状态**。
- 根因坑：python str.replace 计数默认=-1 全局——ops 特例块曾被复制进 4 个 load* 函数（key 未定义→review-requests 500），清除后仅在 handleOpsConfigUpdate 注入 1 处；import 行 regex 重写漏 opsList（运行时 ReferenceError 面板白屏）；evaluate 拼接 splice 弄坏脚本文件（重写解决）。
- 电池 r19 API 27/27 + UI 12/12 + 主回归 119/119（TR05 断言演化允许验收课程）。

## 第20轮（真实 scoped 管理员 + 服务端 fleet scope 引擎）；未发布（线上 V25）

- 数据事实：全 DB 仅一个真实车队 DEMO_FLEET（drivers 500/500、queue top1000 全队），**无第二车队/外队对象** → "跨车队对象不可见"保留未验证（不造假）；本轮以真实账号做**机制级验证**（可见集差异、参数扩权拒绝、非本队写拒绝、账号管理接口 scope 一致性）。
- 18 轮遗留缺陷曝光并修复：app_users 过滤 `or=(user_id.in.())` 嵌套括号从未被真实触发（无 scoped 样本）→ 首触发 400/503；改**内存过滤 keep 集合**（self+本队司机绑定账号+标本队 scope 的账号），杜绝超长 in-list。
- 新 scope 引擎（list_resource 统一入口，AI aiQ 同路生效）：FLEET_GPS_TABLES(gpsno)/FLEET_DRV_TABLES(driver_id+interventions 修正——该表无 gpsno 列曾致 overview 400→null)；空集合 `in.()`=零行零计数不回落；overview count **按 120 gps/批求和**（414 URI_TOO_LONG 边界实测）；写路径 assertInScope（alert/task/gps/driver）失败并入 **404 不泄漏存在性** + scope_refused.write 审计；证据卡 staff guard 同样 404+审计。
- SM01 接口 scope 一致性：assertAccountScope（scoped 编辑/停用他管理员 → 403 + account.scope_refused 审计；编辑自己/管理本队司机账号放行）；scoped 铸造新 safety_admin → 403 cannot_grant_admin_in_scope；显式 fleet_id=他队 → 403 out_of_fleet_scope。
- readBody 为**同步签名**且被多处 await——peek 缓存包装（WeakMap）+ readBody→peekBody，保证 guard 先读体不炸二次读（peekBody undefined 500 修复）。
- r20 API 21/21、UI（SM01 创建+授权+受限列表差异+EV01 渲染）5/5、主回归 119/119。测试账号终态全部 disabled，UI 全程无口令渲染。

## 第21轮（EV04 匿名车队聚合）；未发布（线上 V25）

- `GET /api/driver/fleet-summary`：无参数（fleet 范围只从可信会话 driver_id+fleet_id 关联推导，不读 URL/body）；司机角色限定；未绑定/binding_verified=false → 403 unverified_binding_no_stats（不区分"无车队"避免探测）。
- 聚合口径：本人最新 as_of_date（回退全库最新）→ 该车队全部司机的当日 score_snapshots（内存过滤 gpsno∈车队）；有效=score_status∈{usable,usable_with_review,manual_review}；返回 valid_count/average(1位小数)/distribution(A-D)/as_of_date/source_version/note；**不返回姓名、driver_id、gpsno、个人分、排名、record_id 列表**（响应零个人字段断言）。
- 隐私保护：不足 10 人 → data_status=insufficient_sample（null，不写 0）；分布可反推（类别=1 人、单一等级、某类≥total−1）→ distribution=null + note 保留人数均值；query_failed/no_data/error 三态分离。EV04 前端独立蓝色面板"匿名车队统计"与 score-hero 分区。
- 实测（真库对账）：as_of=2026-07-31、snapshot_ffbc02143fcb、valid=500、avg=74.4、分布 A100/B200/C150/D50 与 DB 直查一致；篡改 fleet_id/driver_id 与不带参完全一致；未绑定/未核实/管理员 三种 403；保护分支以等价纯函数验证 + **现网无小车队 → 真实小样本"未验证"**（未伪造数据，min 类别=50）。r21 测试账号全部 disabled；UI21 1/1，主回归 119/119。
- 坑：低层 dbRequest 不过 listResource 但 select 忘列 gpsno 致过滤全空（no_data 假象）；托管库 max-rows≈2000（limit:3000 → 400/503）；DBG select 漏列 latest undefined。

## 第22轮（RM01「7 天下滑」分组）；未发布（线上 V25）

- 事实基线：score_history 2026-07-24…07-31 共 8 日 × 500 行=4000（count 精确核对，limit 截断曾致"无日期对"假阴性——改为**最新日+eq/lt 探测循环**找相隔恰好 7 自然日的真实双日）；drop_threshold=10（config_version=ops_v1）；RM01 分组=review_queue 字段五组，drop7 作第六组。
- `GET /api/rm/drop7`（无参数可注入；staff 限；scope 用 fleetScopeSets 内存过滤防 414 长 URL）：Δ=早分−晚分 ≥ 阈值命中；缺日/来源版本不一致/score_status 不可比 → not_comparable（**不记为未下滑、不编造日期**）；行含两 score_id、两日分、Δ、阈值版本、可信度、责任人（alerts owner 或 未指派）、下一步（低可信→"先设备/数据核验"）、原队列标签**保留**；route=EV03 深链。**不生成任何 alerts/tasks/扣分**。
- 对账：api 命中=32=冻结 CSV 同阈值基准（集合完全一致，diff 空）；抽查 95201298(21.7887)/95201323(21.1987)/95200904(17.0244) 全字段一致；未命中 95302803(Δ8.16)/95305079(Δ8.74) 正确不在列且不误判不可比；现网无 low 可信命中（提示词分支 N/A）、不补日期分支无真实样本（无缺日数据）→ 标未验证。
- 权限：driver 403；scoped(DEMO_FLEET 新建真实账号) 结果同车队=32 且带 scope_note、参数注入无效；伪造 gpsno 直查 0 行；alerts/trainings 行数前后 (2,5)→(2,5) 零写入。r22 API 15/15、UI22 4/4（截图67/68）、主回归 119/119。
- UI：RM01 数量卡「7天下滑 32」+ tab；表行含两日期/score_id/Δ/阈值版本/confidence/基础标签/责任人/下一步 + EV03 跳转实测。

## 第23轮（SM02 时段冲突校验）；未发布（线上 V25）

- 核对：handleBindingSet 旧语义=立即生效+无界+close-all（会误关 SSO 平台行）；user_bindings 有 effective_start/end 列（seed sso 行两枚 b-sso-*：修复期间被误 close 已恢复 active，并在 close 查询永久加 platform_user_id=is.null 隔离）；drivers.mapping_* 为冻结数据事实，本轮零触碰。
- 新引擎（复用 manage.bindings/cap/审计）：GET /api/admin/bindings(as_of 当日有效过滤·当前/历史双区)、GET /api/admin/binding-conflicts(预览不落库)、POST binding-reschedule(编辑排除自身)、POST binding-delete(快照+审计留痕)；带 window=追加时段制不 close 旧行，legacy 无窗保持 close(仅本地行)；verified=false 不再向 app_users 写 driver_id（my.* 403 binding_not_verified；完全未绑定仍 409——vl 断言语义分层）。
- 边界规则：**闭区间含首尾日**；相邻=次日开始合法；空 end=持续有效(+∞)；overlap=max(.starts)<=min(ends)。拒绝码 invalid_window_end_before_start / binding_window_conflict:driver_slot_taken|user_multi_driver，全部先验后写+account.binding_conflict_refused 审计。
- 并发：进程内互斥（bindingMutex 串行化写段）+写后回读自检，检出重叠自动 inactive 回滚+审计；多副本部署下降级（平台无事务/唯一约束，如实标注限制）。
- 幂等：同 user+driver+窗口重复提交 → idempotent_replay 同 binding_id。
- 测试全部走 DEMO_D046x/D0470 未来窗口，跑完 binding-delete 清行 + 账号 disabled：**终态零残留**（R23 note 0 行、D046x/D0470 active 0 行、sso 双行 active、demo bd-d2b59f113a444910 在位）。r23 API 17/17 + UI 5/5、r20 回归（含 SSO 平台行保护）、r21/r22 复跑全绿、主回归 121/121（三条旧断言按新语义更新：demo 已绑不再重绑破坏 close、my.score 正/负双例、conflict 前缀匹配）。
- 教训固化：清理脚本必须 platform_user_id is null 白名单；行内注释吞 `});`、sed 破坏反引号、`replace` 无 count=1 的三处复发——均已在本轮内修正并入 vl 断言。

## 第24轮（TR06 AI 辅助摘要）；未发布（线上 V25）

- 核对：handleTaskReview 四决定（approved/returned/observe/interview→reviewed/returned/observation/interview）已存在且校验旧状态 eq.submitted + 必填理由 + replay；ReviewBench 原两栏、队列 submitted——四栏+AI 升级复用原端点。
- 新 `POST /api/ai/task-summary`（cap review.training_feedback + assertInScope driverId + 仅 submitted/returned 409 summary_requires_submitted）：受控事实包（司机原文 slice、课程 v+当前状态含停用注记、alert/评分记录）→ aiUpstreamOnce(150s, enable_thinking false——60/95s abort 与 max_tokens 900 截断两坑已修，取 j.choices[0].message.content)→ 强制 JSON、items 逐条 ref 白名单验证（越界标 BAD 不生效）；limitations 固定声明不判定/不宣称改善；10 分钟进程内缓存（重复点击 cached=true 不重复调模型）；审计 ai.task_summary（refs/refs_ok/refs_bad 计数，**不存完整原文**）。零写 training_tasks。
- TR06 UI 四栏：①原文+提交时间（可定位 id）②课程分配版本 v+完成条件+目标+当前状态（停用时保留历史指向）③关联证据或「未取得：未关联案卷——不臆造」④摘要卡（每条判断→ref 按钮 evidence-check 复验，task: ref 滚回①原文）。人工确认仍原按钮+理由必填；司机端 my.trainings 无摘要草稿字段。
- 真实链（本会话）：assign(task-80bc51798d71a009/task-0ea61e6fbae5459a 等，含 alert-1e7ec 关联）→driver start+submit 真文→摘要 available（items 全 ref_ok，states 覆盖/未见/无法判断；audit aud-667fb66111d44c3d 型）→observe 人工确认（aud-c71bd4a428bf2150 型）→重放 replay；无 alert 任务 ③「未取得」；停用课程任务（R19_422）②标当前 disabled 保留历史要求；**AI 无凭据（第二进程剥 key）→ available:false reason provider_not_configured 页面「AI 摘要暂不可用」前3部照常**；driver 403、不存在 404、非法状态 409、点击复验 course ref→200 route #/tr-courses。r24 API 19/19、UI 4/4、主回归 121/121。
- 限制：公网 Page env 的模型密钥为会话级（属主正式配置后需线上复测——本地已验证）；team_leader 越权样本无口令不可测（未验证）。

## 第25轮（EV03 四标签完善）；未发布（线上 V25）

- 核对：EvDriver 四 tabs 骨架 15 轮已有（六维对账/SixBars/deep-link 参数），但 **q 深链从未驱动 driver 加载**（断链，本轮修复：deep-link effect getData limit1 order as_of_date.desc→无记录/失败/加载 三态）；admin.alerts/trainings/risk 按 gpsno/driver_id 现取（facts effect，含 drivers identity_status 页首持续标注）。
- tab①六维「合计=100−安全分」+保守下界+top3 沿用冻结快照值（零重算；D0149 71.857424 对账通过）；tab② risk_snapshots 空→「该时点不可用（未取得）」（现网 500 车全有 0731 预测 → 空分支真实载体=未验证）；tab③ 台账维度行可展开（as_of/ledger_id/口径声明沿用）、tab④ 管理动作：队列原因+告警(status)+任务列表+四入口——EV05 链接、RM03?alert_id 深链（D0177 无告警→按钮 disabled）、TR02 claw_fill 上下文（goal 预填修复 R18 take 漏赋 goal 的缺陷）、AI04 预演经新「claw:ai-preset」事件→App 开面板+AiPanel sendRef 定时派发真模型（截图75 预演完成）。D0289 页首低可信 Banner+④「先完成设备/数据覆盖核验；不自动惩罚性培训」。
- 权限矩阵实测：司机直查 admin.score_snapshots(本人 gpsno)/alerts/trainings/deduction_ledger 全 403；admin 不存在 gpsno total=0；D0149/D0289/D0177 页首全字段与 DB 一致（28.142576/D/high/0.347875505971/rank/版本、88.105364/B/low、82.969886/B）。RM03 入口实测 hash=rm-alerts?alert_id=alert-1e7… 抽屉打开（进草稿非发送）。
- r25 电池 15/15（UI 内嵌断言含 AI04 真实模型），主回归 121/121。截图 72-75。

## 第26轮（AI04 管理动作并排预演独立页）；未发布（线上 V25）

- `GET /api/ai/preplan?driver_id|gpsno[&as_of_date]`（role=safety_admin 限定，driver 403；参数仅查询条件、车队范围 assertInScope 双维；无该行→not_found 同语义；指定日无→no_data_for_date 不补造）。**只读组装**三卡（A 核验/B 沟通/C 已审核课程），每卡 basis[]=真实 record_id（score/queue/ledger/alert/course/task）+ 拟处理对象/责任人+确认操作者/预计待办/所缺/限制；页首与卡内固定「操作预演，未写入」。不新建模型链：AI 建议文字复用对话 action_preplan（claw:ai-preset 通道第25轮已建）。
- 卡门禁实测：D0149 B disabled（唯一案卷 closed→不凭空 RM3 草稿）·C actionable（3 approved 课+行为证据）；D0289 A 高亮(低可信)+B 进入 RM03 可编辑草稿（9f4b confirmed，抽屉「草稿，未发送」）+ **C 禁用：低可信先核验（不自动惩罚性培训）**；D0177 B 禁（无告警）+ C draft_entry→TR02 预填「AI04 预演携入」+「草稿状态，未分配」。basis 回源按钮 evidence-check 200→EV03。旧对象证据切换即清空（noOld 断言）。
- 路由 #/ai-preplan（RM 组菜单 AI04）；EV03「打开并排预演页」互跳；**tab=3 URL 记忆**实现「返回 EV03 保留对象+标签」（EvDriver tab 初值解析）。司机窄屏直达该 hash 不渲染数据、无卡片泄漏。
- 零写入证明：alerts 2 · interventions 2 · training_tasks 9 · notification_events 110 前后一致 + 案卷状态序列化一致；ai.chat 审计沿用既有（组装页本身不产 ai.chat，仅回源校验记 ai.evidence_check）。r26 电池 12/12、主回归 121/121。截图 76/77。UI 脚本沉淀：窄屏登出按钮在小 viewport 折叠→上下文内改用 API logout+clearCookies（既有确认框需 dialog handler）。

## 第27轮（SM06 通知模板：方案+代码准备）；**未执行 DDL、未发布、未发送通知**

- 实测核对：库 22 表=原15+扩展4+平台运行3；notification_events 12 列零外键方案；DDL 通道无（RPCs 空）→待属主。migration 005 up/down 备妥（scripts/contract/migrations/），app_tables.json 扩至 5 张扩展表（新表入 tables 契约）；占位符白名单 event_date/evidence_type/review_note/driver_id/alert_id。
- 代码就绪（probe 降级）：/api/admin/templates GET/POST/PATCH(含 submit/approve[same-actor confirm]/withdraw/disable/edit[new_version 不覆盖 approved])/template-preview（scope 验权+缺事实「待核」+无绑定不显已送达）；SM06 第三标签 + RM03 TemplateInsertRow（选择/预览零写、正文进既有可编辑草稿、发送仍人工幂等确认）。零外键 → 回退=删表，audit 保留。
- 现状验收 7/7 PASS（pending 降级面）+ BLOCKED 清单（B1-B8 待迁移执行后复跑 scripts/notification-template-acceptance）。r27 电池入库；主回归 121/121 待跑后附。截图78。方案文档 output/通知模板实施方案.md。

## 第29轮（V26 发布，属主指令）

- 门禁：staging=HEAD 2ae1f34 构建（publish 目录 670KB；prepare+build 同步）；能力串扫描 17 项全命中（SM01/SM02/SM04/SM05/SM06+模板/TR05/TR06/EV03/EV04/RM01 drop7/RM03/AI01-04）；DB 23 表、notification_templates key_version/pkey/status_enum 约束实存、NT=7 行、alerts2/iv2/tasks9；同包本地全矩阵复跑（登录双角色、403 矩阵、fleet-summary=500、AI chat 200 含真值 call=aud-8017c9da7eeaecd5、停自己409）+ 主回归 121/121。
- 发布：2026-10-24T07:39:30Z，PUT env 刷新 QW_AI_*（属主令牌管道），publish.py → Page app-5d12ecfd-4ed153f9 / ls7d7ste.qwenwork.host **V26 deployed**（同页、同库、未新建/删除、未 down.sql、未重导快照）。
- 公网 SSO 浏览器实操无法由代理代会话（平台登录墙）；功能等价证据=同一构建产物+同一库的本地全矩阵；属主实操清单：EV03 四标签/EV04 聚合/RM01 7天下滑/SM02 绑定双区/TR06 摘要/AI04 预演零写/SM06 模板+RM03 选择预览。RM03 真实发送：无 confirmed-未发送案卷 → 标未验证（不造告警）。

## 第30轮（发送链模板接入收口 + GitHub 同步）；V26 已在线上，本轮改动待下一次发布指令（V27）

- task_assigned（TR02 分配通知）与 review_answer（EV05 答复通知）接入模板：body.template_ref 可选 → resolveTemplateForSend 仅 approved+scene 匹配（否则 409 template_not_approved_or_disabled，不静默回退）；渲染缺事实=「待核」；不选=内置文案原样（T8 回退零破坏）；通知尾部自动附（模板 key:vN 溯源+站内演示声明）；training.assign 审计 detail.template_ref 溯源。
- UI：TR02/EV05 各挂 TemplateScenePicker（approved 下拉+预览只读；选择/预览零写）；sm27.tsx 组件共享。
- 真实闭环验收（本地同码+真库）：r30 T1–T10 全绿（含司机 notification body 渲染真值 alert-1e7ec/待核 event_date）、r30b B1–B5 全绿（真实 rr-129b5b5830f462dc answered→driver 站内通知含模板渲染+response_note 真值+审计 aud-17964959f072af2c）；主回归 121/121。
- 修 bug 两处：rr facts 误读 body.answer_note→正确 response_note；driverIdForPicker 类型。断言校准三处（幂等重放路径、动作实名 review_request.answered、reason 枚举真实值）——均为测试自身而非功能问题。
