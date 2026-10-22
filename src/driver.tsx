import { useEffect, useState } from "react";
import type { MeUser } from "./api";
import { ApiError, getData, interventionRead, interventionReply, logout, myNotes, noteRead, rrCreate, taskSaveDraft, taskStart, taskSubmit } from "./api";
import { Banner, EmptyState, ResourceTable, Tag } from "./ui";

function TabBtn({ active, ico, label, onClick }: { active: boolean; ico: string; label: string; onClick: () => void }) {
  return <button className={active ? "active" : ""} onClick={onClick}><span className="ico" aria-hidden="true">{ico}</span>{label}</button>;
}



function MyHistory() {
  const [rows, setRows] = useState<Record<string, unknown>[] | null | "error">(null);
  useEffect(() => { getData<Record<string, unknown>>("my.score_history", { limit: 20 }).then((r) => setRows(r.rows)).catch(() => setRows("error")); }, []);
  const DIMS = [["history_contribution", "历史"], ["fatigue_distraction_contribution", "疲劳分心"], ["driving_stability_contribution", "驾驶稳定性"], ["road_rule_contribution", "道路规则"], ["management_contribution", "管理配合"], ["imu_evidence_contribution", "IMU证据"]];
  const COLORS = ["#2f6fed", "#7a5af8", "#0e9f8a", "#d97706", "#d6407f", "#64748b"];
  if (rows === "error") return <div className="panel"><EmptyState kind="error" /></div>;
  if (!rows) return <div className="panel"><EmptyState kind="loading" /></div>;
  const last = rows[rows.length - 1] || {};
  const maxd = Math.max(...DIMS.map(([k]) => Number(last[k] ?? 0) || 0), 1e-9);
  return <div className="panel"><h3>我的评分历史与六维（{rows.length} 个已有日期 · 只读事实）</h3>
    <div className="table-wrap" style={{ marginBottom: 10 }}><table><thead><tr><th>截止日</th><th>安全分</th><th>等级</th><th>可信度</th></tr></thead><tbody>
      {rows.map((r) => <tr key={String(r.score_id)}><td>{String(r.as_of_date)}</td><td>{String(r.safety_score)}</td><td>{String(r.risk_level)}</td><td>{String(r.confidence_level)}</td></tr>)}
    </tbody></table></div>
    {DIMS.map(([k, label], i) => <div key={k} className="row" style={{ marginBottom: 4 }}>
      <span style={{ width: 90, fontSize: 12.5, color: "var(--ink-2)" }}>{label}</span>
      <span style={{ height: 12, width: `${(Number(last[k] ?? 0) / maxd) * 40}%`, minWidth: 2, background: COLORS[i], borderRadius: 3, display: "inline-block" }} />
      <span className="mono">{String(last[k] ?? "—")}</span>
    </div>)}
    <p className="login-note">六维为最后一日（{String(last.as_of_date ?? "—")}）快照值；台账/事件证据（deduction_ledger）仍显示待导入空态，不补造。</p>
  </div>;
}


const RR_REASONS: [string, string][] = [
  ["identity_association", "身份关联疑问"], ["event_record", "事件记录疑问"],
  ["device_or_data_missing", "设备或数据缺失"], ["score_explanation", "评分解释疑问"],
];
function RRRequestPanel({ unbound }: { unbound: boolean }) {
  const [reason, setReason] = useState("score_explanation");
  const [desc, setDesc] = useState("");
  const [scoreId, setScoreId] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [mine, setMine] = useState<Record<string, unknown>[] | null>(null);
  const load = () => getData<Record<string, unknown>>("my.review_requests", { limit: 20 }).then((r) => setMine(r.rows)).catch(() => setMine([]));
  useEffect(() => { if (!unbound) { load(); getData<Record<string, unknown>>("my.score", { limit: 1 }).then((r) => setScoreId(String(r.rows[0]?.score_id || ""))).catch(() => {}); } }, [unbound, msg]);
  function submit() {
    setMsg(null);
    rrCreate({ score_id: scoreId || undefined, reason_code: reason, description: desc }).then((r: { request_id: string; status: string; idempotent_replay?: boolean }) => setMsg(r.idempotent_replay ? `幂等：已有同一申请 ${r.request_id}（状态 ${r.status}）` : `已提交 request_id=${r.request_id}（submitted），安全员处理后此处可见答复`)).catch((e) => setMsg(`拒绝：${e instanceof ApiError ? e.code : "network"}`));
  }
  if (unbound) return <><h3>对评分有疑问？</h3><p className="page-desc">当前无核实绑定：不展示对象明细，也无法针对本人评分提交复核。</p></>;
  return <>
    <h3>对评分有疑问？（复核申请 EV05）</h3>
    <p className="page-desc">仅可针对<b>本人真实存在</b>的评分/证据记录提交（系统按登录会话取 driver_id，不信任页面参数）。司机端不能修改任何评分；如源数据确有问题，由安全员转数据负责人走正式版本化流程。</p>
    <div className="field"><label>针对的评分记录</label><input value={scoreId || "（未取到本人快照）"} readOnly aria-label="针对评分记录" style={{ background: "var(--bg)" }} /></div>
    <div className="field"><label>原因</label>
      <select className="btn" style={{ background: "#fff", textAlign: "left" }} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="复核原因">{RR_REASONS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
    <div className="field"><label>说明（必填）</label><textarea style={{ width: "100%", minHeight: 60, borderRadius: 8, border: "1px solid var(--line)", padding: 8, font: "inherit" }} value={desc} onChange={(e) => setDesc(e.target.value)} aria-label="复核说明" /></div>
    <button className="btn primary" onClick={submit} disabled={!desc.trim() || !scoreId}>提交复核申请</button>
    {msg && <div className="alert info">{msg}</div>}
    <h4 style={{ fontSize: 13, marginTop: 10 }}>我的申请与处理记录</h4>
    {mine === null && <EmptyState kind="loading" />}
    {mine && mine.length === 0 && <p className="login-note">暂无申请。</p>}
    {(mine || []).map((x) => <div key={String(x.request_id)} className="task-card"><div className="t"><span className="mono">{String(x.request_id)}</span> · <Tag tone={String(x.status) === "closed" ? "gray" : String(x.status) === "answered" ? "green" : "blue"}>{String(x.status)}</Tag></div>
      <div className="meta">{RR_REASONS.find((k) => k[0] === x.reason_code)?.[1] || String(x.reason_code)} · 针对 {String(x.score_id || x.evidence_id)}</div>
      <div className="meta">我的原文：{String(x.description)}</div>
      {x.review_note ? <div className="meta">安全员答复（{String(x.reviewer_id)} @ {String(x.updated_at)}）：{String(x.review_note)}</div> : null}
    </div>)}
  </>;
}

function OwnScoreDetail() {
  const [row, setRow] = useState<Record<string, unknown> | null | "loading" | "error">("loading");
  useEffect(() => { getData<Record<string, unknown>>("my.score", { limit: 1 }).then((r) => setRow(r.rows[0] || null)).catch(() => setRow("error")); }, []);
  if (row === "loading") return <EmptyState kind="loading" />;
  if (row === "error") return <EmptyState kind="error" />;
  if (!row) return <EmptyState kind="nocov" hint="绑定身份有效，但该对象暂无近14天评分记录（等待数据导入，不补造）。" />;
  const low = row.confidence_level === "low";
  return <div className="stack">
    <div className="panel score-hero">
      <div className="n" style={{ color: "var(--ink)" }}>{String(row.safety_score)}</div>
      <div className="l">近14天安全评分 · {String(row.as_of_date)} · <Tag tone={low ? "amber" : "green"}>{String(row.confidence_level)}{low ? " · 建议先核验设备/数据" : ""}</Tag></div>
      <div className="l">等级 {String(row.risk_level)}（车队内复核优先级）· 7天变化 {String(row.score_change_7d)}</div>
    </div>
    {low && <Banner tone="warn">可信度低：说明数据覆盖或设备状态待核实，先做数据/设备核验，不会被当作“安全”或自动奖惩。</Banner>}
    <div className="panel"><h3>下一步建议（只读口径）</h3><div className="kv">
      <span className="kk">主风险维度</span><b>{String(row.primary_risk_dimension ?? "—")}</b>
      <span className="kk">建议动作</span><b>{String(row.recommended_action ?? "—")}</b>
      <span className="kk">首要扣分原因</span><b>{String(row.top_reason_1 ?? "—")}</b>
      <span className="kk">未来40天预测</span><b>{String(row.forecast_40d_risk_prob ?? "—")}（概率≠事故已发生）</b>
    </div></div>
    <MyHistory />
  </div>;
}


function NotesInbox() {
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => myNotes().then((r) => setRows(r.rows)).catch(() => setRows([]));
  useEffect(() => { load(); }, []);
  function read(id: string) { noteRead(id).then((r: { idempotent_replay?: boolean }) => { setMsg(r.idempotent_replay ? "此前已读（幂等）" : "已标记已读"); load(); }).catch((e: unknown) => setMsg(`拒绝：${e instanceof ApiError ? e.code : "net"}`)); }
  if (!rows) return <EmptyState kind="loading" />;
  return <div className="panel"><h3>我的站内消息（演示通知 ≠ 外部渠道送达）</h3>
    {rows.length === 0 && <p className="login-note">暂无消息。</p>}
    {rows.map((r) => <div key={String(r.notification_id)} className="task-card"><div className="t">{String(r.title || r.type)} · <span className="mono">{String(r.source_entity_id)}</span></div>
      <div className="meta">{String(r.content).slice(0, 120)} · {String(r.created_at)} · {r.read_at ? <>已读 {String(r.read_at)}</> : <button className="btn" style={{ padding: "3px 10px" }} onClick={() => read(String(r.notification_id))}>标记已读</button>}</div></div>)}
    {msg && <div className="alert info">{msg}</div>}
  </div>;
}

function MySafety({ user }: { user: MeUser }) {
  const unbound = !user.driverId;
  return <div className="stack">
    {unbound
      ? <Banner tone="warn">当前账号未完成“已核实司机绑定”。按事实口径，未核实时不展示个人明细——这是设计约束，不是数据丢失。安全管理员在 SM01/SM02 核实绑定后刷新即可见。</Banner>
      : <Banner tone="warn"><span>演示数据绑定：{user.driverId}（{user.bindingNote || "synthetic_demo_mapping"}）。非真实司机身份核验，仅用于工作台演示。</span></Banner>}
    {!unbound ? <OwnScoreDetail /> : <div className="panel score-hero"><div className="n">—</div><div className="l">近14天安全评分（绑定核实后显示 · 只读算法事实）</div></div>}
    <div className="panel">
      <h3>我的六维主要扣分</h3>
      <EmptyState kind="nomatch" hint={unbound ? "绑定核实后显示本人六维（历史/疲劳分心/驾驶稳定性/路规/管理/IMU证据）。" : "扣分数据待第2轮导入；六维合计与总分对账后展示。"} />
    </div>
    <div className="panel">
      <h3>车队匿名汇总（不可反查个人）</h3>
      <div className="row"><Tag tone="gray">均分 —</Tag><Tag tone="gray">样本数 —</Tag><Tag tone="gray">A/B/C/D —</Tag></div>
      <p className="page-desc" style={{ margin: "6px 0 0" }}>仅匿名聚合；不含他人姓名、车号、排名明细或事件。</p>
    </div>
    <div className="panel">
      <h3>对评分有疑问？</h3>
      <p className="page-desc" style={{ margin: 0 }}>可提交“申请复核”（EV05）：身份关联有误 / 事件记录疑问 / 设备或数据缺失 / 评分解释不清。司机端不能自行改分；源数据错误由版本化重建处理。</p>
      <div style={{ height: 8 }} />
      <button className="btn lg" disabled={unbound}>提交复核申请（第3轮启用表单）</button>
    </div>
    <p className="login-note">分数如何产生：观察窗口=近14天日终快照；等级为车队内复核优先级；“无事件”与“无覆盖”会分开标示。</p>
  </div>;
}

function MyRisk({ user }: { user: MeUser }) {
  const [rows, setRows] = useState<Record<string, unknown>[] | null | "blocked" | "error">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [rep, setRep] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!user.driverId) { setRows("blocked"); return; }
    getData<Record<string, unknown>>("my.interventions", { limit: 50 }).then((r) => setRows(r.rows)).catch(() => setRows("error"));
  }, [user.driverId]);
  async function read(id: string) { setMsg(null); try { const r = await interventionRead(id); setMsg(r.idempotent_replay ? `幂等：已存在已读记录 ${r.read_at}` : `已标记已读 ${r.read_at}`); refresh(); } catch (e) { setMsg(`拒绝：${e instanceof ApiError ? e.code : "network"}`); } }
  async function reply(id: string) { setMsg(null); try { const r = await interventionReply(id, rep[id] || ""); setMsg(r.idempotent_replay ? `幂等：已有回复（${r.replied_at}），未重复写入` : `回复已发送 ${r.replied_at}`); refresh(); } catch (e) { setMsg(`拒绝：${e instanceof ApiError ? e.code : "network"}`); } }
  function refresh() { if (user.driverId) getData<Record<string, unknown>>("my.interventions", { limit: 50 }).then((r) => setRows(r.rows)).catch(() => {}); }
  if (rows === "blocked") return <EmptyState kind="nocov" hint="当前账号无核实有效绑定：不展示个人风险明细，且消息不会向其送达。" />;
  if (rows === "error" || rows === null) return <EmptyState kind={rows === "error" ? "error" : "loading"} />;
  const mine = rows.filter((r) => ["sent", "read", "replied"].includes(String(r.status)));
  return <div className="stack">
    <h3 style={{ fontSize: 15 }}>今日风险与人工沟通</h3>
    <Banner tone="warn"><span>演示绑定账号（非真实司机身份核验）；站内消息 ≠ 外部渠道送达。“数据待核验”类别后续导入。</span></Banner>
    {rows.length === 0 && <EmptyState kind="nomatch" hint="暂无与安全管理员沟通的记录。列表由服务端注入本人 driver_id，不读取他人数据。" />}
    {rows.length > 0 && mine.length === 0 && <EmptyState kind="nomatch" hint="有记录但均未发送给你（当前均处草稿/内部状态）。" />}
    {mine.map((r) => <div className="task-card" key={String(r.intervention_id)}>
      <div className="t">{String(r.sent_text || "")}</div>
      <div className="meta">发送 {String(r.sent_at || "—")} · 状态 <Tag tone={String(r.status) === "replied" ? "green" : "blue"}>{String(r.status)}</Tag>{r.read_at ? <> · 已读 {String(r.read_at)}</> : null}{r.replied_at ? <> · 已回复 {String(r.replied_at)}</> : null}</div>
      <div className="row" style={{ marginTop: 8 }}>
        {!r.read_at ? <button className="btn" onClick={() => read(String(r.intervention_id))}>标记已读</button> : null}
        {!r.replied_at ? <>
          <input style={{ flex: 1, padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 8 }} placeholder="回复内容（仅本人可见给安全员）" value={rep[String(r.intervention_id)] || ""} onChange={(e) => setRep((s) => ({ ...s, [String(r.intervention_id)]: e.target.value }))} />
          <button className="btn primary" style={{ width: "auto" }} onClick={() => reply(String(r.intervention_id))}>提交回复</button>
        </> : null}
        {r.replied_at ? <div className="meta">回复原文：{String(r.reply_text)}</div> : null}
      </div>
    </div>)}
    {msg && <div className="alert info">{msg}</div>}
  </div>;
}

function MyTraining() {
  const [rows, setRows] = useState<Record<string, unknown>[] | null | "blocked">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [fbs, setFbs] = useState<Record<string, string>>({});
  const load = () => { getData<Record<string, unknown>>("my.trainings", { limit: 50 }).then((r) => setRows(r.rows)).catch(() => setRows([])); };
  useEffect(() => { load(); }, []);
  if (rows === "blocked" || rows === null && false) return <EmptyState kind="nocov" hint="无有效绑定" />;
  if (rows === null) return <EmptyState kind="loading" />;
  function busy(fn: () => Promise<{ idempotent_replay?: boolean; status?: string; new_status?: string }>, ok: string) { setMsg(null); fn().then((r) => { setMsg(r.idempotent_replay ? `幂等：返回既有状态（${r.status || r.new_status}），未重复写入` : ok); load(); }).catch((e) => setMsg(`拒绝：${e instanceof ApiError ? e.code : "network"}`)); }
  return <div className="stack">
    <h3 style={{ fontSize: 15 }}>培训任务</h3>
    {rows.length === 0 && <EmptyState kind="nomatch" hint="暂无分配给你的培训任务：课程须经团队审核后由安全员正式分配才会出现（不显示演示假任务）。" />}
    {rows.map((r) => { const editable = ["assigned", "in_progress", "returned"].includes(String(r.status)); const done = ["submitted", "reviewed", "observation", "interview"].includes(String(r.status)); const overdue = editable && r.due_at && new Date(String(r.due_at)) < new Date();
      return <div key={String(r.task_id)} className="task-card">
        <div className="t">{String(r.goal || r.task_id)}{r.mandatory ? <Tag tone="red"> 强制</Tag> : null} {overdue ? <Tag tone="red">逾期</Tag> : null}</div>
        <div className="meta">课程 {String(r.course_id)} · 截止 {String(r.due_at || "—")} · 状态 <Tag tone={done ? "green" : "blue"}>{String(r.status)}</Tag>{r.submitted_at ? <> · 提交于 {String(r.submitted_at)}</> : null}</div>
        {editable && <>
          <div className="field" style={{ marginTop: 6 }}><label>学习记录（事件复盘 + 行动；保存≠提交）</label>
            <textarea style={{ width: "100%", minHeight: 66, borderRadius: 8, border: "1px solid var(--line)", padding: 8, font: "inherit" }} value={edits[String(r.task_id)] ?? String(r.learning_record || "")} onChange={(e) => setEdits((s) => ({ ...s, [String(r.task_id)]: e.target.value }))} aria-label="学习记录" /></div>
          <input style={{ width: "100%", borderRadius: 8, border: "1px solid var(--line)", padding: 8, margin: "4px 0" }} value={fbs[String(r.task_id)] ?? ""} onChange={(e) => setFbs((s) => ({ ...s, [String(r.task_id)]: e.target.value }))} placeholder="反馈（可选）" aria-label="反馈" />
          <div className="row">
            {r.status === "assigned" || r.status === "returned" ? <button className="btn" onClick={() => { setMsg(null); taskStart(String(r.task_id)).then((x) => { setMsg(x.idempotent_replay ? `已开始（既有 ${x.started_at}）` : "任务已开始，进入进行中"); load(); }).catch((e) => setMsg(`拒绝：${e instanceof ApiError ? e.code : "network"}`)); }}>开始学习</button> : null}
            <button className="btn" onClick={() => busy(() => taskSaveDraft(String(r.task_id), edits[String(r.task_id)] || String(r.learning_record || "")) as never, "草稿已保存（未提交）")}>保存草稿</button>
            <button className="btn primary" style={{ width: "auto" }} onClick={() => busy(() => taskSubmit(String(r.task_id), edits[String(r.task_id)] || String(r.learning_record || ""), fbs[String(r.task_id)] || "") as never, "已提交，等待安全员复核（通知对方）")}>提交学习记录</button>
          </div>
          <p className="login-note">仅本人、仅未提交状态可改；提交后正文与时间持久化并由安全员在复核台处理。</p>
        </>}
        {done && <p className="login-note">{r.review_note ? `复核：${String(r.review_note)} @ ${String(r.reviewed_at)}` : "已提交，等待复核"}</p>}
      </div>; })}
    {msg && <div className="alert info">{msg}</div>}
  </div>;
}

function MyProfile({ user }: { user: MeUser }) {
  return <div className="stack">
    <h3 style={{ fontSize: 15 }}>我的资料</h3>
    <div className="panel"><div className="kv">
      <span className="kk">登录账号</span><b>{user.username || user.userId}</b>
      <span className="kk">显示名</span><b>{user.displayName || "—"}</b>
      <span className="kk">角色</span><b>司机</b>
      <span className="kk">司机绑定</span><b>{user.driverId ? (user.bindingVerified ? "绑定生效（演示映射）" : "待核实") : "未绑定"}</b>
      <span className="kk">driver_id</span><b className="mono">{user.driverId || "未绑定"}</b>
      <span className="kk">绑定口径</span><b>{user.bindingNote || "—"}</b>
      <span className="kk">登录方式</span><b>{user.authKind === "sso" ? "千问办公平台账号（SSO）" : "工作台账号（服务端会话）"}</b>
      <span className="kk">数据截止</span><b>待导入（快照 as_of 2026-07-31）</b>
    </div></div>
    <div className="panel">
      <h3>可维护范围</h3>
      <p className="page-desc" style={{ margin: 0 }}>司机仅可编辑允许的本人联系方式/个人资料字段；角色、绑定与任何评分均不可自行修改。</p>
      <div style={{ height: 8 }} />
      <button className="btn lg" disabled>编辑资料（第3轮启用）</button>
    </div>
    <NotesInbox />
    <button className="btn" onClick={async () => { await logout().catch(() => {}); try { const o = sessionStorage.getItem("claw_ai_owner"); if (o) sessionStorage.removeItem("claw_ai_msgs_" + o); sessionStorage.removeItem("claw_ai_owner"); sessionStorage.removeItem("claw_fill"); sessionStorage.removeItem("claw_fill_seen"); } catch {} window.dispatchEvent(new Event("claw:auth-lost")); location.reload(); }}>退出登录</button>
    {user.authKind === "sso" && <p className="login-note">平台 SSO 会话由网关管理，应用不提供强制登出；“退出”仅清除本工作台会话视图。</p>}
  </div>;
}

const TABS = [
  { key: "safety", ico: "🛡", label: "我的安全", el: (u: MeUser) => <MySafety user={u} /> },
  { key: "risk", ico: "⚠", label: "今日风险", el: (u: MeUser) => <MyRisk user={u} /> },
  { key: "training", ico: "🎓", label: "培训任务", el: () => <MyTraining /> },
  { key: "profile", ico: "👤", label: "我的资料", el: (u: MeUser) => <MyProfile user={u} /> },
];

export function DriverShell({ user }: { user: MeUser }) {
  const [tab, setTab] = useState(0);
  const active = TABS[tab];
  return <div className="driver-shell">
    <header className="driver-head">
      <div className="name">{user.displayName || "司机"}</div>
      <div className="sub">数据截止 2026-07-31 · {user.driverId ? `绑定 ${user.driverId}（演示映射）` : "身份未核实（演示）"}</div>
    </header>
    <main className="driver-main">
      <Banner tone="info">演示窄屏端 · 评分快照已导入；台账/趋势“待导入”即空态，不补造。“无事件”不等于“无覆盖”。</Banner>
      {active.el(user)}
    </main>
    <nav className="tabbar">
      {TABS.map((t, i) => <TabBtn key={t.key} active={i === tab} ico={t.ico} label={t.label} onClick={() => setTab(i)} />)}
    </nav>
  </div>;
}
