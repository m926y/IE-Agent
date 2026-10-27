import { useEffect, useState } from "react";
import type { FleetSummary } from "./api";import type { MeUser } from "./api";
import { ApiError, fleetSummary, getOwnProfile, updateOwnProfile, getData, interventionRead, interventionReply, logout, myNotes, noteRead, rrCreate, taskSaveDraft, taskStart, taskSubmit } from "./api";
import { Banner, EmptyState, ResourceTable, Tag, GlobalSearch} from "./ui";

function FleetStatsPanel() {
  const [fs, setFs] = useState<FleetSummary | "loading" | "error" | null>(null);
  useEffect(() => { fleetSummary().then((r) => setFs(r)).catch(() => setFs("error")); }, []);
  return <div className="panel" style={{ borderColor: "var(--line)", background: "#fcf9ff" }} aria-label="anonymous fleet statistics panel">
    <h3>匿名车队统计</h3>
    {fs === "loading" && <EmptyState kind="loading" />}
    {fs === "error" && <div className="alert warn">无法获取车队统计：本账号未绑定/未核实或查询失败（服务端拒绝时不返回任何个人与车队数据）</div>}
    {typeof fs === "object" && fs && fs.data_status !== "ok" && (
      <div className={"alert " + (fs.data_status === "query_failed" ? "warn" : "info")}>
        {fs.data_status === "insufficient_sample" ? "样本不足：该车队有效评分人数少于 10，均值与分布已隐藏（隐私保护，不以 0 或空壳冒充）"
          : fs.data_status === "no_data" ? fs.note : "统计查询失败：请稍后重试（未以空值冒充 0）"}
        {fs.as_of_date ? " · 数据截止 " + fs.as_of_date : ""}
      </div>)}
    {typeof fs === "object" && fs && fs.data_status === "ok" && <>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 13 }}>
        <span>数据截止 <b>{fs.as_of_date}</b></span>
        <span>有效评分人数 <b>{fs.valid_count}</b></span>
        <span>车队平均安全分 <b>{fs.average ?? "—"}</b></span>
        <span className="meta">版本 {fs.source_version}</span>
      </div>
      {fs.distribution ? <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginTop: 8 }}>
        {(["A", "B", "C", "D"] as const).map((k) => { const v = (fs.distribution as Record<string, number>)[k] ?? 0; return <div key={k} className="task-card" style={{ padding: 6, textAlign: "center" }}>
          <div className="meta">{k} 级</div><div style={{ fontSize: 18, fontWeight: 700 }}>{v}</div>
          <div style={{ height: 4, background: "#dfe8f6", borderRadius: 2 }}><div style={{ height: 4, width: Math.round((v / (fs.valid_count || 1)) * 100) + "%", background: k === "D" ? "#b3261e" : k === "C" ? "#ad6800" : k === "B" ? "#1a56c4" : "#1a6b2a", borderRadius: 2 }} /></div>
        </div>; })}
      </div> : <div className="alert info" style={{ marginTop: 6 }}>{fs.note || "等级类别过细可能反推个人：本次不展示分布（人数与均值保留）"}</div>}
      <p className="login-note">{fs.note}</p>
    </>}
  </div>;
}

function TabBtn({ active, ico, label, onClick }: { active: boolean; ico: string; label: string; onClick: () => void }) {
  return <button className={active ? "active" : ""} onClick={onClick}><span className="ico" aria-hidden="true">{ico}</span>{label}</button>;
}



function MyHistory() {
  const [rows, setRows] = useState<Record<string, unknown>[] | null | "error">(null);
  useEffect(() => { getData<Record<string, unknown>>("my.score_history", { limit: 20, order: "as_of_date.desc" }).then((r) => setRows([...r.rows].sort((a, b) => String(a.as_of_date).localeCompare(String(b.as_of_date))))).catch(() => setRows("error")); }, []);
  const DIMS = [["history_contribution", "历史"], ["fatigue_distraction_contribution", "疲劳分心"], ["driving_stability_contribution", "驾驶稳定性"], ["road_rule_contribution", "道路规则"], ["management_contribution", "管理配合"], ["imu_evidence_contribution", "IMU证据"]];
  const COLORS = ["#a480c4", "#b298d2", "#9b80bc", "#cab6dd", "#b68dbd", "#c4aed4"];
  if (rows === "error") return <div className="panel"><EmptyState kind="error" /></div>;
  if (!rows) return <div className="panel"><EmptyState kind="loading" /></div>;
  const last = rows[rows.length - 1] || {};
  const maxd = Math.max(...DIMS.map(([k]) => Number(last[k] ?? 0) || 0), 1e-9);
  return <div className="panel"><h3>评分历史与六维</h3>
    <div className="table-wrap" style={{ marginBottom: 10 }}><table><thead><tr><th>截止日</th><th>安全分</th><th>等级</th><th>可信度</th></tr></thead><tbody>
      {rows.map((r) => <tr key={String(r.score_id)}><td>{String(r.as_of_date)}</td><td>{Number(r.safety_score).toFixed(2)}</td><td>{String(r.risk_level)}</td><td>{String(r.confidence_level)}</td></tr>)}
    </tbody></table></div>
    {DIMS.map(([k, label], i) => <div key={k} className="row" style={{ marginBottom: 4 }}>
      <span style={{ width: 90, fontSize: 12.5, color: "var(--ink-2)" }}>{label}</span>
      <span style={{ height: 12, width: `${(Number(last[k] ?? 0) / maxd) * 40}%`, minWidth: 2, background: COLORS[i], borderRadius: 3, display: "inline-block" }} />
      <span className="mono">{last[k] == null ? "—" : Number(last[k]).toFixed(2)}</span>
    </div>)}
    <p className="login-note">六维为最后一日（{String(last.as_of_date ?? "—")}）快照值，只读事实；“无事件”不等于“无覆盖”，本页不补造数据。</p>
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
    <h3>评分复核申请</h3>
    <p className="page-desc">填写原因及说明，提交后由安全员核查。仅可针对<b>本人真实存在</b>的评分/证据记录提交（系统按登录会话取 driver_id，不信任页面参数）；司机端不能修改任何评分，如源数据确有问题，由安全员转数据负责人走正式版本化流程。</p>
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
  if (!row) return <><div className="panel score-hero"><div className="l">近 14 天安全评分</div><div className="n">—</div><div className="l">暂无评分记录</div></div><FleetStatsPanel /></>;
  const low = row.confidence_level === "low";
  return <div className="stack">
    <div className="panel score-hero">
      <div className="n" style={{ color: "var(--ink)" }}>{Number(row.safety_score).toFixed(2)}</div>
      <div className="l">近14天安全评分 · {String(row.as_of_date)} · <Tag tone={low ? "amber" : "green"}>{String(row.confidence_level)}{low ? " · 建议先核验设备/数据" : ""}</Tag></div>
      <div className="l">等级 {String(row.risk_level)}· 7 天变化 {row.score_change_7d == null ? "—" : Number(row.score_change_7d).toFixed(2)}</div>
    </div>
    {low && <Banner tone="warn">可信度低：说明数据覆盖或设备状态待核实，先做数据/设备核验，不会被当作“安全”或自动奖惩。</Banner>}
    <FleetStatsPanel />
    <div className="panel"><h3>关注事项</h3><div className="kv">
      <span className="kk">主风险维度</span><b>{{history:"历史事故与未遂", fatigue_distraction:"疲劳与分心", driving_stability:"驾驶稳定性", road_rule:"道路规则", management:"管理配合", imu_evidence:"IMU证据"}[String(row.primary_risk_dimension)] || String(row.primary_risk_dimension || "—")}</b>
      <span className="kk">建议动作</span><b>{String(row.recommended_action ?? "—")}</b>
      <span className="kk">首要扣分原因</span><b>{String(row.top_reason_1 ?? "—")}</b>
      <span className="kk">未来40天预测</span><b>{row.forecast_40d_risk_prob == null ? "—" : (Number(row.forecast_40d_risk_prob) * 100).toFixed(2) + "%"}<small className="forecast-note">预测概率</small></b>
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
  return <div className="panel"><h3>站内消息</h3>
    {rows.length === 0 && <p className="login-note">暂无消息。</p>}
    {rows.map((r) => <div key={String(r.notification_id)} className="task-card"><div className="t">{String(r.title || r.type)} · <span className="mono">{String(r.source_entity_id)}</span></div>
      <div className="meta">{String(r.content).slice(0, 120)} · {String(r.created_at)} · {r.read_at ? <>已读 {String(r.read_at)}</> : <button className="btn" style={{ padding: "3px 10px" }} onClick={() => read(String(r.notification_id))}>标记已读</button>}</div></div>)}
    {msg && <div className="alert info">{msg}</div>}
  </div>;
}


function ProfileEdit() {
  const [prof, setProf] = useState<{ phone: string; intro: string; contact_pref: string } | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { getOwnProfile().then((r) => { const p = r.profile; let cp = "站内消息"; try { const pj = p?.prefs ? JSON.parse(String(p.prefs)) : null; if (pj?.contact_pref) cp = String(pj.contact_pref); } catch { /* defaults */ }
    setProf({ phone: String(p?.phone || ""), intro: String(p?.intro || ""), contact_pref: cp }); }).catch(() => setLoadErr(true)); }, []);
  if (loadErr) return <div className="panel"><EmptyState kind="error" /></div>;
  if (!prof) return <div className="panel"><EmptyState kind="loading" /></div>;
  async function save() { if (!prof) return; setBusy(true); setMsg(null);
    try { const r = await updateOwnProfile({ phone: prof.phone, intro: prof.intro, prefs: JSON.stringify({ contact_pref: prof.contact_pref }) }); setMsg(`已保存 · 审计 ${r.audit_id}（仅更新提交字段；不影响绑定与评分事实）`); }
    catch (e) { const c = e instanceof ApiError ? e.code : "network"; setMsg({ invalid_phone_format: "电话格式不正确（仅数字与 +() -，5-24 位）", profile_driver_only: "仅司机账号可维护", invalid_prefs_json: "偏好数据异常，请刷新页面" }[c] || `保存被拒：${c}`); }
    setBusy(false); }
  return <div className="panel stack">
    <h3>联系方式与备注（本人维护）</h3>
    <div className="field"><label>联系电话（安全员干预沟通用；5-24 位，可清空）</label><input value={prof.phone} onChange={(e) => setProf({ ...prof, phone: e.target.value })} inputMode="tel" placeholder="例如 138-0000-0000" /></div>
    <label className="field" style={{ fontSize: 13 }}>联系偏好
      <select value={prof.contact_pref} onChange={(e) => setProf({ ...prof, contact_pref: e.target.value })}>{["站内消息", "电话联系", "仅紧急事件联系"].map((o) => <option key={o}>{o}</option>)}</select></label>
    <div className="field"><label>个人备注（如常驻线路、班次说明；≤500 字，不对其他司机展示）</label><textarea style={{ width: "100%", minHeight: 56, borderRadius: 8, border: "1px solid var(--line)", padding: 8, font: "inherit" }} value={prof.intro} onChange={(e) => setProf({ ...prof, intro: e.target.value.slice(0, 500) })} /></div>
    <button className="btn primary" style={{ width: "auto" }} disabled={busy} onClick={save}>{busy ? "保存中…" : "保存资料"}</button>
    {msg && <div className="alert info">{msg}</div>}
  </div>;
}

function MySafety({ user }: { user: MeUser }) {
  const unbound = !user.driverId || !user.bindingVerified;
  return <div className="stack">
    {unbound
      ? <Banner tone="warn">当前账号未完成“已核实司机绑定”。未核实时不展示个人明细——这是设计约束，不是数据丢失。安全管理员在 SM01/SM02 核实绑定后刷新即可见。</Banner>
      : <Banner tone="warn"><span>演示数据绑定：{user.driverId}（{user.bindingNote || "synthetic_demo_mapping"}）。非真实司机身份核验，仅用于工作台演示。</span></Banner>}
    {!unbound ? <OwnScoreDetail /> : <div className="panel score-hero"><div className="n">—</div><div className="l">近14天安全评分（绑定核实后显示 · 只读算法事实）</div></div>}
    <details className="panel driver-review"><summary>评分复核申请（EV05）</summary><RRRequestPanel unbound={unbound} /></details>
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
    {rows.length === 0 && <EmptyState kind="nomatch" hint="暂无沟通记录" />}
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
  const [rows, setRows] = useState<Record<string, unknown>[] | null | "blocked" | "error">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [fbs, setFbs] = useState<Record<string, string>>({});
  const load = () => { getData<Record<string, unknown>>("my.trainings", { limit: 50 }).then((r) => setRows(r.rows)).catch(() => setRows("error")); };
  useEffect(() => { load(); }, []);
  if (rows === "blocked" || rows === null && false) return <EmptyState kind="nocov" hint="无有效绑定" />;
  if (rows === "error") return <EmptyState kind="error" onRetry={load} />;
  if (rows === null) return <EmptyState kind="loading" />;
  function busy(fn: () => Promise<{ idempotent_replay?: boolean; status?: string; new_status?: string }>, ok: string) { setMsg(null); fn().then((r) => { setMsg(r.idempotent_replay ? `幂等：返回既有状态（${r.status || r.new_status}），未重复写入` : ok); load(); }).catch((e) => setMsg(`拒绝：${e instanceof ApiError ? e.code : "network"}`)); }
  return <div className="stack">
    <h3 style={{ fontSize: 15 }}>培训任务</h3>
    {rows.length === 0 && <EmptyState kind="nomatch" hint="暂无培训任务" />}
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
      <span className="kk">司机绑定</span><b>{user.driverId ? (user.bindingVerified ? "已绑定" : "待核实") : "未绑定"}</b>
      <span className="kk">driver_id</span><b className="mono">{user.driverId || "未绑定"}</b>
      <span className="kk">绑定口径</span><b>{user.bindingNote || "—"}</b>
      <span className="kk">登录方式</span><b>{user.authKind === "sso" ? "千问办公平台账号（SSO）" : "账号登录"}</b>
      <span className="kk">数据截止</span><b>以本人评分快照为准</b>
    </div>
    <div className="meta" style={{ marginTop: 6 }}>绑定身份、角色与任何评分/预测由管理员与算法系统维护，本页不可改；以下联系方式与备注由本人维护。</div>
    </div>
    <ProfileEdit />
    <NotesInbox />
    <button className="btn" onClick={async () => { await logout().catch(() => {}); try { const o = sessionStorage.getItem("claw_ai_owner"); if (o) sessionStorage.removeItem("claw_ai_msgs_" + o); sessionStorage.removeItem("claw_ai_owner"); sessionStorage.removeItem("claw_fill"); sessionStorage.removeItem("claw_fill_seen"); } catch {} window.dispatchEvent(new Event("claw:auth-lost")); location.reload(); }}>退出登录</button>
    {user.authKind === "sso" && <p className="login-note">平台 SSO 会话由网关管理，应用不提供强制登出；“退出”仅清除本工作台会话视图。</p>}
  </div>;
}

const TABS = [
  { key: "safety", ico: "◈", label: "我的安全", el: (u: MeUser) => <MySafety user={u} /> },
  { key: "risk", ico: "△", label: "今日风险", el: (u: MeUser) => <MyRisk user={u} /> },
  { key: "training", ico: "▤", label: "培训任务", el: () => <MyTraining /> },
  { key: "profile", ico: "◎", label: "我的资料", el: (u: MeUser) => <MyProfile user={u} /> },
];

export function DriverShell({ user }: { user: MeUser }) {
  const [tab, setTab] = useState(0);
  const active = TABS[tab];
  return <div className="driver-shell">
    <header className="driver-head">
      <GlobalSearch />
      <div className="driver-identity"><span className="brand-symbol" aria-hidden="true">行</span><div><div className="name">{user.displayName || "司机"}</div><div className="sub">{user.driverId ? user.bindingNote || "司机账号" : "身份待核实"}</div></div><span className="driver-app-label">司机端</span></div>
    </header>
    <main className="driver-main">
      <div className="driver-safety-note">停车后操作</div>
      {active.el(user)}
    </main>
    <nav className="tabbar">
      {TABS.map((t, i) => <TabBtn key={t.key} active={i === tab} ico={t.ico} label={t.label} onClick={() => setTab(i)} />)}
    </nav>
  </div>;
}

