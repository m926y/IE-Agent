import { useEffect, useMemo, useRef, useState } from "react";
import type { MeUser, ImportCheckReport, ImportCommitReport } from "./api";
import {ApiError, alertConfirm, alertContact, alertHandoff, alertNote, alertStatus, caseView, courseReview, createUser, egressProbe, getData, getHistoryDates, importCheck, importCommit, interventionDraft, interventionEdit, interventionSend, myNotes, noteRead, notesSummary, opsConfigUpdate, rrAdvance, rrView, setBinding, setUserStatus, taskReview, taskView, trainingAssign, taskSummary, TaskSummary, aiEvidenceCheck} from "./api";
import type { RRView } from "./api";
import type { CaseView as CaseViewT } from "./api";
import { Banner, EmptyState, ResourceTable, Tag, GlobalSearch } from "./ui";
import { SmDraftsPage, SmKnowledgePage } from "./sm17";
import { AccountAdminPanel } from "./sm18";
import { BindingsConsole } from "./sm23";
import { AiPreplanPage } from "./sm26";
import { TemplatesTab, TemplateScenePicker } from "./sm27";
import { AuditConsole, CourseBoard } from "./sm19";
import { Dashboard } from "./dashboard";
import { RootCausesPage, MandatePolicyCard } from "./r37";
import { TrainingNotificationRecovery, notificationText } from "./training-recovery";
import { AdminDailyReportPanel } from './daily-report';

const IMPORTABLE_TABLES = [
  "drivers", "risk_snapshots", "score_snapshots", "review_queue", "score_history", "deduction_ledger",
  "replay_events", "evaluation_rules", "training_courses", "operation_config", "user_bindings",
  "alerts", "interventions", "training_tasks", "review_requests", "knowledge_articles",
  "evaluation_rule_drafts", "notification_events",
];

function ImportPanel({ onCommitted }: { onCommitted: () => void }) {
  const [table, setTable] = useState("drivers");
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [sv, setSv] = useState("snapshot_ffbc02143fcb");
  const [report, setReport] = useState<ImportCheckReport | null>(null);
  const [commit, setCommit] = useState<ImportCommitReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const canCommit = Boolean(report?.ok && report.run_id && !commit);
  async function pick(f: File | undefined) {
    setErr(null); setReport(null); setCommit(null); setNote(null);
    if (!f) { setFile(null); return; }
    if (f.size > 4 * 1024 * 1024) { setErr("文件超过 4MB 上限，请拆分后再导入"); return; }
    const csv = await f.text();
    setFile({ name: f.name, csv });
  }
  async function check() {
    if (!file) { setErr("先选择 CSV 文件"); return; }
    setBusy(true); setErr(null); setCommit(null);
    try { const r = await importCheck({ table, filename: file.name, csv: file.csv, source_version: sv || undefined }); setReport(r); }
    catch (e) { setErr(e instanceof ApiError ? errText(e.code) : "连接失败，请重试"); }
    setBusy(false);
  }
  async function doCommit() {
    if (!report?.run_id || !file) return;
    setBusy(true); setErr(null);
    try {
      const c = await importCommit({ run_id: report.run_id, csv: file.csv });
      setCommit(c); setReport(null); setFile(null); if (fileRef.current) fileRef.current.value = "";
      onCommitted();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "network_error";
      if (code === "content_changed_since_check") setErr("文件内容与预检时不一致，已拒绝写入；请重新预检。");
      else if (code === "confirm_window_expired") setErr("确认窗口（30分钟）已过，请重新预检。");
      else if (code === "precheck_not_passed") setErr("该预检未通过或已作废，不能写入。");
      else setErr(errText(code));
    }
    setBusy(false);
  }
  function errText(code: string) {
    if (code === "forbidden") return "当前账号无导入权限（仅安全管理员）。";
    if (code === "unsupported_table") return "该表不在版本化导入白名单（audit_logs 等由系统写入）。";
    if (code === "file_too_large") return "文件超过 4MB 上限。";
    if (code === "bad_json") return "请求格式错误。";
    if (code === "unknown_columns_in_header") return "文件中存在契约外列，提交被服务端二次防线拒绝；请修正表头后重新预检。";
    if (code === "missing_pk_column") return "文件缺少业务主键列，提交被拒绝。";
    return `导入失败：${code}`;
  }
  return <div className="panel">
    <h3>版本化 CSV 导入（仅安全管理员 · 预检 → 确认 → UPSERT）</h3>
    <p className="page-desc">流程：选择业务表与 CSV 文件 → 服务端预检（不落业务数据）→ 管理员确认后按业务主键 UPSERT（重复执行不新增记录）。文本列原样保留；空值不转 0；数值按字符串写入保留原始小数位。浏览器不持有任何数据库凭证。</p>
    <div className="row">
      <select className="btn" value={table} onChange={(e) => { setTable(e.target.value); setReport(null); setCommit(null); }} aria-label="目标表">
        {IMPORTABLE_TABLES.map((x) => <option key={x} value={x}>{x}</option>)}
      </select>
      <label className="btn" htmlFor="csvfile">选择 CSV 文件</label>
      <input id="csvfile" ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={(e) => pick(e.target.files?.[0])} />
      <span className="mono">{file ? `${file.name}（${(file.csv.length / 1024).toFixed(1)}KB 字符）` : "未选择文件"}</span>
      <input className="btn" style={{ width: 240 }} value={sv} onChange={(e) => setSv(e.target.value)} aria-label="source_version" placeholder="source_version（运行级口径）" />
      <button className="btn" onClick={check} disabled={busy || !file}>预检（不写入）</button>
      <button className="btn primary" style={{ width: "auto" }} onClick={doCommit} disabled={busy || !canCommit}>{busy ? "处理中…" : "确认写入"}</button>
    </div>
    {err && <div className="alert danger">{err}</div>}
    {note && <div className="alert ok">{note}</div>}
    {report && !report.ok && <div className="alert danger">预检被拒：{report.fatal}</div>}
    {report?.ok && <div className="alert info">
      预检通过：目标 <b>{report.table}</b> · 文件 <b>{report.filename}</b> · 数据行 <b>{report.row_total}</b> ·
      预计写入 <b>{report.accepted_row_estimate}</b> · 拒绝行 <b>{report.rejected_count}</b> · 文件内重复主键 <b>{report.dup_pk_count}</b> ·
      类型错误 <b>{(report.type_errors || []).length}</b>（明细最多各列 50 条） · run <span className="mono">{report.run_id}</span> · 审计 <span className="mono">{report.audit_id || "—"}</span>
      <br />确认窗口 {report.confirm_window_minutes} 分钟内有效；写入按业务主键 UPSERT，重复执行结果不变。
      {report.unknown_columns?.length ? <><br />未知列：{report.unknown_columns.join(", ")}</> : null}
      {report.missing_contract_columns?.length ? <><br />缺失契约列（该列不更新）：{report.missing_contract_columns.join(", ")}</> : null}
      {(report.dup_pk || []).slice(0, 20).map((d) => <div key={d.key} className="mono">重复主键 {d.key} 行 {d.lines.join("↔")}（后写覆盖先写）</div>)}
      {(report.type_errors || []).slice(0, 20).map((x, i) => <div key={i} className="mono">第 {x.line} 行 {x.field}：{x.reason}「{x.value}」</div>)}
      {(report.rejected_rows || []).slice(0, 20).map((x, i) => <div key={i} className="mono">第 {x.line} 行拒绝：{x.reason}</div>)}
      {(report.warnings || []).slice(0, 10).map((w, i) => <div key={i}>提示：{w}</div>)}
    </div>}
    {commit && <div className="alert ok">
      导入 {commit.result === "committed" ? "完成" : "部分失败（已停止，可查审计）"}：{commit.table} · 提交 {commit.submitted_rows} 行 ·
      UPSERT {commit.upserted} 行 · 最终拒绝 {commit.rejected_final} 行 · 分块 {commit.chunks.filter((c) => c.ok).length}/{commit.chunks.length} ·
      run <span className="mono">{commit.run_id}</span> · 审计 <span className="mono">{commit.audit_id || "—"}</span>
      {commit.idempotent_replay ? " · （重复确认，返回既有结果，未重复写入）" : null}
    </div>}
  </div>;
}

const NAV: { group: string; items: { key: string; label: string; code?: string }[] }[] = [
  { group: "工作台", items: [{ key: "overview", label: "工作台总览" }, { key: "daily-reports", label: "每日安全简报" }] },
  { group: "安全评价", items: [
    { key: "ev-fleet", label: "车队总览", code: "EV01" },
    { key: "ev-week", label: "周度分析", code: "EV02" },
    { key: "ev-driver", label: "司机详情", code: "EV03" },
    { key: "ev-review", label: "评价复核/数据异议", code: "EV05" },
    { key: "ev-root", label: "根因分析", code: "EV06" },
  ]},
  { group: "风险监控", items: [
    { key: "rm-queue", label: "风险工作台", code: "RM01" },
    { key: "rm-replay", label: "历史回放", code: "RM02" },
    { key: "rm-alerts", label: "告警与事件档案", code: "RM03/RM05" },
    { key: "ai-preplan", label: "管理动作预演", code: "AI04" },
  ]},
  { group: "培训改善", items: [
    { key: "tr-ledger", label: "培训台账", code: "TR01" },
    { key: "tr-courses", label: "课程库与审核", code: "TR05/SM06" },
    { key: "tr-create", label: "创建培训", code: "TR02" },
  ]},
  { group: "系统管理", items: [
    { key: "sm-accounts", label: "账号与角色", code: "SM01" },
    { key: "sm-bindings", label: "司机档案与绑定", code: "SM02" },
    { key: "sm-config", label: "规则与运营配置", code: "SM03" },
    { key: "sm-audit", label: "数据版本与审计", code: "SM04" },
    { key: "sm-drafts", label: "规则草案", code: "SM05" },
    { key: "sm-knowledge", label: "知识内容", code: "SM06" },
  ]},
];

function NavIcon({ kind }: { kind: number }) {
  const paths = [
    <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    <><path d="M4 16V8l2-4h12l2 4v8M4 9h16M7 13h1m8 0h1M6 16v3m12-3v3M3 16h18" /></>,
    <><path d="m12 3 9 16H3L12 3Z" /><path d="M12 9v4m0 3h.01" /></>,
    <><path d="m2 8 10-5 10 5-10 5L2 8Zm4 2v7l6 3 6-3v-7M22 8v8" /></>,
    <><rect x="4" y="7" width="16" height="13" rx="3" /><path d="M12 3v4M9 12v2m6-2v2M9 17h6M1 11v5m22-5v5" /></>,
    <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="8" cy="6" r="2" /><circle cx="16" cy="12" r="2" /><circle cx="10" cy="18" r="2" /></>,
  ];
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}

function PageHead({ title }: { code?: string; title: string; desc: string }) {
  return <div className="page-head"><h2>{title}</h2></div>;
}

const RR_LABEL: Record<string, string> = { identity_association: "身份关联疑问", event_record: "事件记录疑问", device_or_data_missing: "设备或数据缺失", score_explanation: "评分解释疑问" };
function EvReview() {
  const [tick, setTick] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  const [v, setV] = useState<RRView | null | "error">(null);
  const [note, setNote] = useState("");
  const [rrTpl, setRrTpl] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (sel) rrView(sel).then(setV).catch(() => setV("error")); else setV(null); }, [sel, tick]);
  async function move(st: string) {
    setMsg(null);
    try { const r = await rrAdvance(sel!, st, note || (st === "checking" ? "" : note), rrTpl); setMsg(`→ ${r.new_status} · 审计 ${r.audit_id}${r.driver_notified ? " · 已站内通知司机" : ""}`); setNote(""); setTick((x) => x + 1); }
    catch (e) { const c = e instanceof ApiError ? e.code : "network"; setMsg({ response_note_required: "该状态必须填写答复/说明（进审计）" }[c] || `拒绝：${c}`); }
  }
  return <div>
    <PageHead code="EV05" title="评价复核与数据异议" desc="算法输出纠错与业务解释分开：核查=查看原快照与台账（只读）；答复=说明证据链；源数据确有问题仅可转数据负责人（awaiting_data_owner），等待正式版本化重建——本页面与接口无评分写路径。" />
    <ResourceTable key={`rr${tick}`} resource="admin.review_requests" onRowClick={(r) => setSel(String(r.request_id))} labels={{ request_id: "request_id", driver_id: "司机", score_id: "评分对象", evidence_id: "证据", reason_code: "原因", status: "状态", review_note: "最新答复", reviewer_id: "处理人", created_at: "提交时间", updated_at: "更新" }} />
    {v && v !== "error" && <div className="panel"><h3>复核详情 {String(v.request.request_id)} · <Tag tone="blue">{String(v.request.status)}</Tag></h3>
      <div className="grid2">
        <div><h4 style={{ fontSize: 12.5 }}>司机原文（{RR_LABEL[String(v.request.reason_code)] || String(v.request.reason_code)}）</h4>
          <p style={{ whiteSpace: "pre-wrap", background: "var(--bg)", borderRadius: 8, padding: 8, fontSize: 13 }}>{String(v.request.description)}</p>
          <div className="kv"><span className="kk">针对记录</span><b className="mono">{String(v.request.score_id || v.request.evidence_id || "—")}</b><span className="kk">source_version</span><b className="mono">{String(v.request.source_version || "—")}</b></div></div>
        <div><h4 style={{ fontSize: 12.5 }}>原始评分</h4>
          {v.snapshot ? <div className="kv">
            <span className="kk">安全分/等级</span><b>{String(v.snapshot.safety_score)} / {String(v.snapshot.risk_level)}（rank {String(v.snapshot.rank)}）</b>
            <span className="kk">可信度</span><b>{String(v.snapshot.confidence_level)}（{String(v.snapshot.confidence_score)}）</b>
            <span className="kk">状态</span><b>{String(v.snapshot.score_status)}</b><span className="kk">as_of/版本</span><b className="mono">{String(v.snapshot.as_of_date)} · {String(v.snapshot.source_version)}</b></div> : <p className="login-note">（无关联评分快照）</p>}
          {v.ledger !== null && v.ledger.length > 0 && <><h4 style={{ fontSize: 12.5, marginTop: 6 }}>关联台账证据</h4>{v.ledger.map((l) => <div key={String(l.ledger_id)} className="meta mono" style={{ fontSize: 11.5 }}>{String(l.ledger_id)} · {String(l.dimension)} · {String(l.event_type)} · 分摊 {String(l.allocated_points)}</div>)}</>}
        </div>
      </div>
      <TemplateScenePicker scene="review_answer" driverId={v && typeof v === "object" ? String((v as unknown as { request?: { driver_id?: string } }).request?.driver_id ?? "") : ""} onPick={(r) => setRrTpl(r)} label="答复通知模板（可选，仅 approved）" />
      <div className="field" style={{ marginTop: 8 }}><label>答复/处理说明（answered、awaiting_data_owner、closed 必填，进审计与司机端）</label>
        <textarea style={{ width: "100%", minHeight: 56, borderRadius: 8, border: "1px solid var(--line)", padding: 8, font: "inherit" }} value={note} onChange={(e) => setNote(e.target.value)} aria-label="答复说明" /></div>
      <div className="row">
        {(["checking", "awaiting_data_owner", "answered", "closed"] as const).map((st) => { const allowed: Record<string, string[]> = { submitted: ["checking", "answered"], checking: ["awaiting_data_owner", "answered"], awaiting_data_owner: ["answered"], answered: ["closed"], closed: [] }; return allowed[String(v.request.status)]?.includes(st) ? <button key={st} className="btn" onClick={() => move(st)}>{ { checking: "开始核查", awaiting_data_owner: "转数据负责人(等版本化流程)", answered: "答复司机", closed: "关闭申请" }[st]}</button> : null; })}
        <button className="btn" onClick={() => setSel(null)}>收起</button>
      </div>
      {msg && <div className="alert info">{msg}</div>}
      <h4 style={{ fontSize: 13, marginTop: 8 }}>状态时间轴（audit）</h4>
      {(v.timeline || []).map((e) => <div key={String(e.audit_id)} className="task-card"><div className="t"><span className="mono">{String(e.action)}</span> · {String(e.old_status || "—")} → {String(e.new_status || "—")}</div><div className="meta">{String(e.occurred_at)} · {String(e.actor_id)}</div></div>)}
    </div>}
    {v === "error" && <EmptyState kind="error" />}
  </div>;
}

type ScoreRow = Record<string, unknown>;
const PAGE = 200;

function EvFleet() {
  const [agg, setAgg] = useState<{ n: number; avg: number | null; dist: Record<string, number>; low: number; date: string } | null>(null);
  const [filter, setFilter] = useState<string | null>(() => { const level = new URLSearchParams(location.hash.split("?")[1]).get("level"); return level && ["A", "B", "C", "D", "conf"].includes(level) ? level : null; });
  const [vehicleQuery, setVehicleQuery] = useState("");
  const [driver, setDriver] = useState<ScoreRow | null>(null);
  const parseQ = () => { const m = location.hash.match(/[?&](driver_id|gpsno)=([^&#]+)/); return m ? { key: m[1], val: decodeURIComponent(m[2]) } : null; };
  const [q, setQ] = useState<{ key: string; val: string } | null>(parseQ);
  const [deepErr, setDeepErr] = useState<string | null>(null);
  useEffect(() => {
    if (!q) return;
    let alive = true; setDriver(null); setDeepErr("加载中…");
    getData<ScoreRow>("admin.score_snapshots", { limit: 1, order: "as_of_date.desc", ...(q.key === "driver_id" ? { driver_id: q.val } : { gpsno: q.val }) })
      .then((r) => { if (!alive) return; if ((r.rows || []).length) { setDriver(r.rows[0] as ScoreRow); setDeepErr(null); } else setDeepErr("无记录：该标识在当日评分快照中不存在（或超出你的车队范围）"); })
      .catch(() => alive && setDeepErr("查询失败（会话过期或服务异常），请重试"));
    return () => { alive = false; };
  }, [q]);

  useEffect(() => {
    const onHash = () => { if (location.hash.includes("ev-fleet")) { setQ(parseQ()); setDriver(null); setDeepErr(null); } };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    let alive = true;
    (async () => {
      let rows: ScoreRow[] = [];
      for (let off = 0; ; off += PAGE) {
        const r = await getData<ScoreRow>("admin.score_snapshots", { limit: PAGE, offset: off });
        rows = rows.concat(r.rows);
        if (r.rows.length < PAGE) break;
      }
      if (!alive) return;
      const dist: Record<string, number> = {}; let low = 0; let sum = 0; let cnt = 0;
      for (const r of rows) {
        dist[String(r.risk_level)] = (dist[String(r.risk_level)] || 0) + 1;
        if (r.confidence_level === "low") low++;
        if (typeof r.safety_score === "number") { sum += r.safety_score; cnt++; }
      }
      setAgg({ n: rows.length, avg: cnt ? sum / cnt : null, dist, low, date: String(rows[0]?.as_of_date || "—") });
    })().catch(() => {});
    return () => { alive = false; };
  }, []);
  if (driver) return <EvDriver row={driver} onBack={() => setDriver(null)} />;
  if (deepErr && !driver) return <div><button className="btn" onClick={() => { setDeepErr(null); setQ(null); history.pushState("", "", location.pathname + location.search + "#/ev-fleet"); window.dispatchEvent(new HashChangeEvent("hashchange")); }}>← 返回车队总览</button><div style={{ height: 10 }} />{deepErr === "加载中…" ? <EmptyState kind="loading" /> : <EmptyState kind="nomatch" hint={deepErr} />}</div>;
  const setF = (v: string) => () => setFilter((cur) => (cur === v ? null : v));
  const filterParams: Record<string, string> = !filter ? {} : filter.startsWith("conf") ? { confidence_level: "low" } : { risk_level: filter };
  return <div>
    <div className="dashboard-heading fleet-heading"><h1>车队总览</h1><span className="date-label">数据截止 <b>{agg?.date || "—"}</b></span></div>
    <div className="dashboard-metrics fleet-metrics">
      {[
        ["评分车辆", agg?.n ?? "—", null],
        ["平均安全分", agg?.avg?.toFixed(2) ?? "—", null],
        ["D 级车辆", agg?.dist.D ?? "—", "D"],
        ["低可信度车辆", agg?.low ?? "—", "conf"],
      ].map(([label, value, target], i) => <button key={String(label)} className={`dashboard-metric ${i === 1 ? "featured" : ""}`} onClick={() => setFilter(target === null ? null : String(target))}><span className="metric-label">{label}</span><strong>{value}</strong><span className="metric-note">{i === 1 ? "近 14 天" : "辆"}</span></button>)}
    </div>
    <section className="panel fleet-list">
      <div className="fleet-toolbar">
        <div className="fleet-filters" aria-label="等级筛选"><button className={!filter ? "active" : ""} onClick={() => setFilter(null)}>全部</button>{["A", "B", "C", "D"].map(level => <button key={level} className={filter === level ? "active" : ""} onClick={setF(level)}>{level} 级 <span>{agg?.dist[level] ?? "—"}</span></button>)}</div>
        <form className="fleet-search" onSubmit={e => { e.preventDefault(); if (vehicleQuery.trim()) { setFilter(null); setQ({ key: "gpsno", val: vehicleQuery.trim() }); } }}><input placeholder="输入车辆编号" aria-label="车辆编号" value={vehicleQuery} onChange={e => setVehicleQuery(e.target.value)} /><button className="btn" type="submit">查询</button></form>
      </div>
      {filter === "conf" && <div className="row filter-note"><Tag tone="amber">低可信度</Tag><button className="btn" onClick={() => setFilter(null)}>清除筛选</button></div>}
      <ResourceTable key={filter + JSON.stringify(q ?? {}) + "ev01"} resource="admin.score_snapshots" rowActionLabel="查看" pageSize={15} params={{ order: "safety_score.asc", ...filterParams, ...(q ? { [q.key]: q.val } : {}) }} columns={["gpsno", "safety_score", "rank", "risk_level", "score_change_7d", "confidence_level", "primary_risk_dimension", "recommended_action"]} labels={{ gpsno: "车辆编号", safety_score: "安全分", rank: "排名", risk_level: "等级", score_change_7d: "7天变化", confidence_level: "可信度", primary_risk_dimension: "主要风险维度", recommended_action: "建议动作" }} onRowClick={r => setDriver({ ...r })} />
    </section>
    <p className="login-note">排序=安全分升序（低分先复核）；“平均安全分”为列表算术平均（页面聚合，非算法值）；等级=复核优先级非事故概率。深链支持 #/ev-fleet?driver_id=DEMO_D0177 或 ?gpsno=。</p>
  </div>;
}

const DIM_ORDER: [string, string][] = [
  ["history_contribution", "历史事故与未遂"], ["fatigue_distraction_contribution", "疲劳与分心"],
  ["driving_stability_contribution", "驾驶稳定性"], ["road_rule_contribution", "道路规则"],
  ["management_contribution", "管理配合度"], ["imu_evidence_contribution", "IMU证据"],
];
const DIM_COLORS = ["#a389c3", "#ad95ce", "#b8a1d7", "#c0abdf", "#cbbbe6", "#d5c8ed"];

function SixBars({ row }: { row: ScoreRow }) {
  const vals = DIM_ORDER.map(([k]) => Number(row[k] ?? 0) || 0);
  const max = Math.max(...vals, 1e-9);
  const sixSum = vals.reduce((a, b) => a + b, 0);
  const target = 100 - Number(row.safety_score ?? 0);
  const diff = Math.abs(sixSum - target);
  const verdict = diff <= 1e-6 ? "一致（原始数值精度内）" : diff <= 1e-4 ? `极小差异 ${diff.toExponential(1)}（源文件数值舍入所致，页面不修改算法值）` : `差异 ${diff.toExponential(2)}，需数据组核对；页面不改写`;
  return <div className="panel"><h3>六维扣分（只读算法事实 · 合计=100−安全分在线对账）</h3>
    {DIM_ORDER.map(([k, label], i) => <div key={k} className="row" style={{ marginBottom: 5 }}>
      <span style={{ width: 110, color: "var(--ink-2)", fontSize: 12.5 }}>{label}</span>
      <span style={{ height: 14, width: `${(vals[i] / max) * 45}%`, minWidth: vals[i] > 0 ? 2 : 0, background: DIM_COLORS[i], borderRadius: 3, display: "inline-block" }} />
      <span className="mono" title={String(row[k] ?? "")}>{row[k] == null ? "—" : Number(row[k]).toFixed(2)}</span>
    </div>)}
    <p className="login-note" style={{ marginTop: 6 }}>六维合计 {sixSum.toFixed(6)} vs 100 − 安全分 {target.toFixed(6)} → <b>{verdict}</b>。行为观察扣分 {String(row.behavior_safety_score ?? "—")} · 评分保守下界 {String(row.confidence_adjusted_floor ?? "—")}</p>
  </div>;
}

function EvWeek() {
  const [meta, setMeta] = useState<{ dates: string[]; counts: Record<string, number | null> } | null>(null);
  const [a, setA] = useState<string>(""); const [b, setB] = useState<string>("");
  const [cmp2, setCmp2] = useState<{ dropped10: string[]; risen: number; dropped: number; same: number; samples: [string, string, string][] } | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(false);
  useEffect(() => { getHistoryDates().then((d) => { setMeta(d); if (d.dates.length) { setA(d.dates[0]); setB(d.dates[d.dates.length - 1]); } }).catch(() => setErr(true)); }, []);
  async function run() {
    if (!a || !b || a === b) return;
    setBusy(true); setCmp2(null);
    const grab = async (date: string) => { let acc: ScoreRow[] = []; for (let off = 0; ; off += 200) { const r = await getData<ScoreRow>("admin.score_history", { limit: 200, offset: off, as_of_date: date }); acc = acc.concat(r.rows); if (r.rows.length < 200) break; } return acc; };
    const A = await grab(a), B = await grab(b);
    const mapA = new Map(A.map((x) => [String(x.gpsno), x]));
    let risen = 0, dropped = 0, same = 0; const d10: string[] = []; const samples: [string, string, string][] = [];
    for (const x of B) { const ya = mapA.get(String(x.gpsno)); if (!ya) continue;
      const diff = Number(x.safety_score) - Number(ya.safety_score);
      if (diff > 0) risen++; else if (diff < 0) dropped++; else same++;
      if (diff <= -10) d10.push(String(x.driver_id || x.gpsno));
      samples.push([String(x.driver_id || x.gpsno), String(ya.safety_score), String(x.safety_score)]); }
    samples.sort((x, y) => (Number(x[2]) - Number(x[1])) - (Number(y[2]) - Number(y[1])));
    setCmp2({ dropped10: d10, risen, dropped, same, samples: samples.slice(0, 10) }); setBusy(false);
  }
  if (err) return <EmptyState kind="error" />;
  if (!meta) return <EmptyState kind="loading" />;
  if (!meta.dates.length) return <EmptyState kind="nomatch" hint="暂无评分历史" />;
  const DATES = meta.dates;
  return <div>
    <PageHead code="EV02" title="评分趋势" desc="日期选项与逐日数量直接查询自 score_history（distinct as_of_date + count），不写死、不补造；无记录日期不出现。" />
    <div className="panel"><h3>已有日期（DB 实查）</h3>
      <div className="row">{DATES.map((d) => <Tag key={d} tone={d === b ? "blue" : "gray"}>{d} · {meta.counts[d] ?? "?"}</Tag>)}</div>
    </div>
    <div className="row" style={{ marginBottom: 10 }}>
      <select className="btn" style={{ background: "#fff" }} value={a} onChange={(e) => setA(e.target.value)}>{DATES.map((d) => <option key={d}>{d}</option>)}</select>
      <span>→</span>
      <select className="btn" style={{ background: "#fff" }} value={b} onChange={(e) => setB(e.target.value)}>{DATES.map((d) => <option key={d}>{d}</option>)}</select>
      <button className="btn primary" style={{ width: "auto" }} onClick={run} disabled={busy || !a || !b || a === b}>{busy ? "计算中…" : "对比两日"}</button>
    </div>
    {cmp2 && <div className="panel"><h3>{a} → {b}（两日均为已有日终快照；周视图=各日 14 天滚动值）</h3>
      <p className="page-desc">上升 {cmp2.risen} · 下降 {cmp2.dropped} · 持平 {cmp2.same}；<b>下降≥10 分（运营阈值建议 10 分，仅形成优先队列，不生成新分数或告警）：{cmp2.dropped10.length} 个</b></p>
      <div className="table-wrap"><table><thead><tr><th>对象</th><th>{a}</th><th>{b}</th><th>变化</th></tr></thead><tbody>
        {cmp2.samples.map((s) => <tr key={s[0]}><td className="mono">{s[0]}</td><td>{s[1]}</td><td>{s[2]}</td><td style={{ color: Number(s[2]) - Number(s[1]) < 0 ? "var(--risk)" : "var(--ok)" }}>{(Number(s[2]) - Number(s[1])).toFixed(4)}</td></tr>)}
      </tbody></table></div>
      <p className="login-note">限制：两日 window 起点/终点不同但均为 14 天窗口末值；可比性前提是同一 source_version 口径（本库均为 snapshot_ffbc02143fcb）。跨日变化不构成因果解释。</p>
    </div>}
  </div>;
}

function EvDriver({ row, onBack, sourceQueueId }: { row: Record<string, unknown>; onBack: () => void; sourceQueueId?: string }) {
  const [tab, setTab] = useState(() => { const m = /[?&]tab=([0-3])/.exec(location.hash); return m ? Number(m[1]) : 0; });
  const [facts, setFacts] = useState<{ risk: number; alerts: Record<string, unknown>[]; tasks: Record<string, unknown>[] } | null>(null);
  const tabs = ["已观察行为", "未来风险预测", "事件证据", "管理动作"];
  const drvId = row.driver_id ? String(row.driver_id ?? "—") : ""; const gps = String(row.gpsno); const low = String(row.confidence_level) === "low";
  useEffect(() => { setFacts(null); let alive = true;
    Promise.all([
      getData<Record<string, unknown>>("admin.risk_snapshots", { gpsno: gps, limit: 1 }).catch(() => ({ rows: [] as Record<string, unknown>[] })),
      getData<Record<string, unknown>>("admin.alerts", { gpsno: gps, limit: 10 }).catch(() => ({ rows: [] as Record<string, unknown>[] })),
      getData<Record<string, unknown>>("admin.trainings", { driver_id: drvId, limit: 10 }).catch(() => ({ rows: [] as Record<string, unknown>[] })),
      getData<Record<string, unknown>>("admin.drivers", { driver_id: drvId, limit: 5 }).catch(() => ({ rows: [] as Record<string, unknown>[] })),
    ]).then(([rk, al, tr, dv]) => { if (alive) setFacts({ risk: (rk.rows || []).length, alerts: (al.rows || []) as Record<string, unknown>[], tasks: (tr.rows || []) as Record<string, unknown>[], ident: ((dv.rows || [])[0] || {}).identity_status ? String(((dv.rows || [])[0] || {}).identity_status) : null } as never); });
    return () => { alive = false; };
  }, [gps, drvId]);
  return <div>
    <button className="btn" onClick={onBack}>← 返回车队总览</button>
    <div style={{ height: 10 }} />
    <div className="meta" style={{ marginBottom: 4 }}>EV03 · {String(row.driver_id ?? "—")} · 车辆 {String(row.gpsno)}{facts && (facts as { ident?: string | null }).ident ? (String((facts as { ident?: string }).ident).includes("synthetic") ? <span className="tag amber" style={{ marginLeft: 6 }}>演示身份（synthetic_demo_mapping，持续标注，非真实身份核验）</span> : <> · 身份 {(facts as { ident?: string }).ident}</>) : null}</div>
    <PageHead code={`EV03 · ${String(row.driver_id ?? "—")} · 车辆 ${String(row.gpsno)}`} title={`车辆 ${gps}`} desc="页首分栏区分“近14天观察”与“未来40天预测”，两口径不可互相换算；全部值为只读事实。" />
    <Banner tone={row.confidence_level === "low" ? "warn" : "info"}>
      <span>近14天观察：安全分 <b>{row.safety_score == null ? "—" : Number(row.safety_score).toFixed(2)}</b> · 等级 <b>{String(row.risk_level)}</b> · 7天变化 {row.score_change_7d == null ? "—" : Number(row.score_change_7d).toFixed(2)} · 可信度 <b>{{ high: "高", medium: "中", low: "低" }[String(row.confidence_level)] || "—"}（{String(row.confidence_score)}）</b> · 截止 {String(row.as_of_date)}（窗口起 {String(row.window_start)}）{row.confidence_level === "low" ? " → 低可信度：请先核验设备与数据覆盖，不自动奖惩" : ""}</span>
    </Banner>
    <div className="grid2">
      <div className="panel"><h3>评分信息</h3><div className="kv">
        <span className="kk">40天风险概率</span><b>{row.forecast_40d_risk_prob == null ? "—" : (Number(row.forecast_40d_risk_prob) * 100).toFixed(2) + "%"}</b>
        <span className="kk">车队排名</span><b>{String(row.rank)}</b>
        <span className="kk">数据截止</span><b className="mono">{String(row.as_of_date)}</b>
      </div></div>
      <div className="panel"><h3>建议动作</h3><div className="kv">
        <span className="kk">主风险维度</span><b>{({history:"历史事故与未遂", fatigue_distraction:"疲劳与分心", driving_stability:"驾驶稳定性", road_rule:"道路规则", management:"管理配合", imu_evidence:"IMU证据"}[String(row.primary_risk_dimension)] || String(row.primary_risk_dimension ?? "—"))}</b>
        <span className="kk">建议</span><b>{String(row.recommended_action)}</b>
        <span className="kk">复核周期</span><b>{{ monthly: "每月", weekly: "每周", daily: "每日" }[String(row.review_cycle)] || String(row.review_cycle || "—")}</b>
      </div></div>
    </div>
    <SixBars row={row} />
    <div className="row">{tabs.map((tb, i) => <button key={tb} className="btn" style={i === tab ? { borderColor: "var(--navy)", color: "var(--navy)" } : undefined} onClick={() => setTab(i)}>{tb}</button>)}</div>
    <div style={{ height: 10 }} />
    {tab === 0 && <section className="panel score-reasons"><h3>主要扣分原因（冻结快照值，只读）</h3>{[1, 2, 3].map(i => <div key={i}><span className="reason-number">0{i}</span><p>{String(row[`top_reason_${i}`] || "—")}</p>{row[`top_reason_${i}_penalty_points`] != null && <b>{Number(row[`top_reason_${i}_penalty_points`]).toFixed(2)} <small>分</small></b>}</div>)}<p className="login-note" style={{ marginTop: 0 }}>六维合计=100−安全分的对账见上方六维面板；下表为该对象已入库评分快照（只读）。</p><ResourceTable resource="admin.score_snapshots" pageSize={5} params={{ driver_id: String(row.driver_id) }} /></section>}
    {tab === 1 && <>{facts && facts.risk === 0 ? <div className="alert info">该时点无此车辆的 40 天预测快照 → 不可用（未取得）；系统不以观察分反推概率。</div> : <ResourceTable resource="admin.risk_snapshots" pageSize={10} params={{ gpsno: String(row.gpsno) }} />}</>}
    {tab === 2 && <section className="panel"><h3>扣分依据 · 事件台账</h3><p className="page-desc">事件台账（deduction_ledger）按维度解释扣分分摊，每行含 event_type/事件数/分摊扣分/维度截止日/ledger_id。<b>台账归因仅用于解释与对账，不宣称任何单条事件具有独立因果效应</b>；若此表无该车辆记录：可能是确无可记录事件，也可能是设备未覆盖——必须结合其可信度与 score_status 判断，不据此推断“有覆盖”或“风险为零”。</p>{row.top_reason_1_code ? <div className="table-wrap"><table><thead><tr><th>维度</th><th>事件数量</th><th>扣分</th><th>关联事件类型</th></tr></thead><tbody>{[1, 2, 3].map(i => <tr key={i}><td>{{ history: "历史事故与未遂", fatigue_distraction: "疲劳与分心", driving_stability: "驾驶稳定性", road_rule: "道路规则", management: "管理配合度", imu_evidence: "IMU 风险佐证" }[String(row[`top_reason_${i}_dimension`])] || "—"}</td><td>{row[`top_reason_${i}_event_count`] == null ? "—" : String(row[`top_reason_${i}_event_count`])}</td><td>{row[`top_reason_${i}_penalty_points`] == null ? "—" : Number(row[`top_reason_${i}_penalty_points`]).toFixed(2)}</td><td className="mono">{String(row[`top_reason_${i}_source_event_codes`] || "—")}</td></tr>)}</tbody></table></div> : <ResourceTable resource="admin.deduction_ledger" pageSize={20} params={{ gpsno: gps }} labels={{ ledger_id: "台账ID", gpsno: "车辆", event_type: "事件类型", dimension: "维度", event_count: "事件数", decayed_severity: "衰减严重度", allocated_points: "分摊扣分", dimension_points: "维度扣分", as_of_date: "截止日" }} />}</section>}
    {tab === 3 && <div className="panel">
      <h3>管理动作</h3>
      {low && <div className="alert warn">低可信度对象：<b>先完成设备/数据覆盖核验</b>（RM03 核验向草稿 / SM02 绑定核对），再讨论处置；本页不自动安排惩罚性培训。</div>}
      {!facts ? <div className="meta">读取处置现状…</div> : <>
        <div className="kv"><span className="kk">队列原因（冻结 review_queue 快照）</span><b>{String(row.review_queue ?? "—")} · {String((row as { action_deadline?: string }).action_deadline || "—")}{sourceQueueId ? " · 队列记录 " + sourceQueueId : ""}</b></div>
        <div className="kv"><span className="kk">告警（alerts，按本车 gpsno）</span><b>{facts.alerts.length ? facts.alerts.map((a) => String(a.alert_id) + "（" + String(a.status) + "）").join("、") : "无记录"}</b></div>
        <div className="kv"><span className="kk">培训任务（training_tasks）</span><b>{facts.tasks.length ? facts.tasks.map((x) => String(x.task_id) + " " + String(x.status)).join("、") : "无记录"}</b></div>
        <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 8 }}>
          <button className="btn" onClick={() => { location.hash = "ev-review"; }}>EV05 复核处理（列表含 {drvId} 相关申请）→</button>
          {facts!.alerts.map((a) => <button key={String(a.alert_id)} className="btn" onClick={() => { location.hash = "rm-alerts?alert_id=" + encodeURIComponent(String(a.alert_id)); }}>RM03 干预草稿 · {String(a.alert_id)}（{String(a.status)}）→</button>)}
          {!facts!.alerts.length && <button className="btn" disabled>创建干预（需关联告警）</button>}
          <button className="btn" onClick={() => { try { sessionStorage.setItem("claw_fill", JSON.stringify({ form: "tr2", driver_id: drvId, alert_id: !facts ? null : facts.alerts[0] ? String(facts.alerts[0].alert_id) : null, goal: (low ? "【先核设备/数据，不建议惩罚性课程】" : "") + "围绕 " + String((row as { primary_risk_dimension?: string }).primary_risk_dimension || "主维度") + " 制定培训方案", note: "来自 EV03 管理动作入口" })); } catch { /* ignore */ } window.dispatchEvent(new CustomEvent("claw:fill")); location.hash = "tr-create"; }}>TR02 培训草稿（带对象上下文）→</button>
          <button className="btn" onClick={() => { window.dispatchEvent(new CustomEvent("claw:ai-preset", { detail: { prompt: "对 " + drvId + "（车辆 " + gps + "）做 AI04 三种管理路径并排预演（沟通/培训/设备核验路径对比），只预演不写入" } })); }}>AI 方案建议 →</button>
          <button className="btn" onClick={() => { window.dispatchEvent(new CustomEvent("claw:ev-cache", { detail: null })); location.hash = "ai-preplan?" + (String(row.driver_id ?? "—") === "—" ? "gpsno=" + encodeURIComponent(String(row.gpsno)) : "driver_id=" + encodeURIComponent(String(row.driver_id ?? "—"))); }}>比较处置方案 →</button>
        </div>
      </>}
    </div>}
    <p className="login-note">record_id：评分 {String(row.score_id)} · 来源 {String(row.source_version)}{sourceQueueId ? <> · 队列来源 <span className="mono">{sourceQueueId}</span></> : null}</p>
  </div>;
}

function Drop7Panel({ data, openRow }: { data: Drop7ish; openRow: (gps: string) => void }) {
  if (data.data_status !== "ok") return <EmptyState kind="nocov" hint="缺少可比较的评分历史" />;
  return <div>
    <div className="alert info" style={{ fontSize: 12 }}>{data.data_status === "ok" ? `比较对 ${data.date_pair?.[0]} → ${data.date_pair?.[1]}（相隔恰好 7 自然日，只读比较）· 阈值 ${data.threshold} 分（版本 ${data.threshold_version}）· 可比 ${data.comparable} · 命中 ${data.drop_count} · 无法比较 ${data.not_comparable_count}（缺日/版本不一致/状态不可比，均不记为未下滑） · ${data.scope_note || ""} · ${data.generated || ""}` : data.note || "无数据"}</div>
    {(data.rows || []).length === 0 && <EmptyState kind="nomatch" hint="按你的车队范围与阈值，无 7 天下降达到阈值的对象" />}
    <table className="tbl"><thead><tr><th>车辆 / 司机</th><th>两日采样（早→晚）</th><th>原分→现分（Δ）</th><th>score_id（早 / 晚）</th><th>可信度 / 原标签</th><th>责任人 / 下一步</th><th></th></tr></thead>
      <tbody>{(data.rows || []).map((x) => <tr key={x.gpsno + x.early_score_id}>
        <td><b>{x.gpsno}</b><div className="meta">{x.driver_id || "—"}</div></td>
        <td>{x.early_date} → {x.late_date}<div className="meta">阈值 {x.threshold}（{x.threshold_version}）</div></td>
        <td><b>{x.early_score}</b> → <b>{x.late_score}</b><div style={{ color: "#b3261e", fontWeight: 700 }}>▼ {x.drop}</div></td>
        <td className="meta" style={{ fontSize: 11 }}>{x.early_score_id}<br />{x.late_score_id}</td>
        <td><Tag tone={x.confidence === "low" ? "amber" : "blue"}>{x.confidence === "low" ? "低可信度·先核验" : "可信度 " + (x.confidence ?? "—")}</Tag>{x.base_tags.map((bg) => <span key={bg} style={{ marginLeft: 4 }}><Tag tone={bg.includes("priority") ? "red" : "gray"}>{bg}</Tag></span>)}</td>
        <td className="meta">{x.owner}<div>{x.next_step}</div></td>
        <td><button className="btn" style={{ padding: "2px 8px" }} onClick={() => openRow(x.gpsno)}>EV03 详情/证据 ↗</button></td>
      </tr>)}</tbody></table>
    {((data.not_comparable || []) as unknown[]).length > 0 && <details style={{ marginTop: 6 }}><summary className="meta">无法比较清单（{data.not_comparable_count}，不记为未下滑）</summary>
      <ul>{(data.not_comparable || []).slice(0, 20).map((x: Record<string, string | null>) => <li key={String(x.gpsno)} className="meta">{x.gpsno}（{x.driver_id || "—"}）：{x.reason}</li>)}</ul></details>}
  </div>;
}
type Drop7ish = import("./api").Drop7;

const QUEUE_GROUPS: [string, string, string][] = [
  ["priority_review", "优先复核", "red"],
  ["behavior_coaching", "行为辅导", "amber"],
  ["prediction_review", "预测核查", "blue"],
  ["data_quality_review", "数据质量核验", "amber"],
  ["routine", "常规观察", "gray"],

  ["drop7", "7天下滑", "gray"], ];

function RmQueue() {
  const [queueOverview, setQueueOverview] = useState<import("./api").OverviewResult | null>(null);
  useEffect(() => { import("./api").then(m => m.getOverview().then(setQueueOverview).catch(() => {})); }, []);
  const [drop7Data, setDrop7] = useState<Drop7ish | null>(null);
  useEffect(() => { import("./api").then((m) => m.drop7().then(setDrop7).catch(() => setDrop7(null))); }, []);
  const [rows, setRows] = useState<ScoreRow[] | null>(null);
  const [err, setErr] = useState(false);
  const [openG, setOpenG] = useState<string>("priority_review");
  const [detail, setDetail] = useState<ScoreRow | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      let acc: ScoreRow[] = [];
      for (let off = 0; ; off += 200) {
        const r = await getData<ScoreRow>("admin.review_queue", { limit: 200, offset: off });
        acc = acc.concat(r.rows);
        if (r.rows.length < 200) break;
      }
      if (alive) setRows(acc);
    })().catch(() => setErr(true));
    return () => { alive = false; };
  }, []);
  async function openDriver(queueRow: ScoreRow) {
    const r = await getData<ScoreRow>("admin.score_snapshots", { limit: 1, gpsno: String(queueRow.gpsno) });
    if (r.rows[0]) setDetail({ ...r.rows[0], __queue_id: String(queueRow.queue_id) });
  }
  if (detail) return <EvDriver row={detail} onBack={() => setDetail(null)} sourceQueueId={detail.__queue_id as string | undefined} />;
  if (err) return <EmptyState kind="error" />;
  if (!rows) return <EmptyState kind="loading" />;
  const counts = Object.fromEntries(QUEUE_GROUPS.map(([k]) => [k, k === "drop7" ? (drop7Data?.data_status === "ok" ? drop7Data.drop_count : "—") : rows.filter((r) => r.review_queue === k).length]));
  return <div>
    <PageHead code="RM01 · 队列来源 review_queue（as_of 2026-07-31）" title="风险监控" desc="队列来自算法快照；排序仅用于复核优先级，不自动创建告警。" />
    <div className="cards">
      <div className="card"><div className="k">监测车辆</div><div className="v">{new Set(rows.map(r => r.gpsno)).size}</div></div>
      <div className="card risk"><div className="k">优先复核</div><div className="v">{counts.priority_review}</div></div>
      <div className="card warn"><div className="k">行为辅导</div><div className="v">{counts.behavior_coaching}</div></div>
      <div className="card warn"><div className="k">数据质量核验</div><div className="v">{counts.data_quality_review}</div><div className="s">先核验设备/数据</div></div>
      <div className="card"><div className="k">待核查告警 / 待回复</div><div className="v">{queueOverview?.metrics.find(m => m.key === "alerts_pending")?.count ?? "—"} / {queueOverview?.metrics.find(m => m.key === "interventions_unreplied")?.count ?? "—"}</div></div>
    </div>
    <div className="row" style={{ marginBottom: 8 }}>
      {QUEUE_GROUPS.map(([k, label]) => <button key={k} className="btn" style={openG === k ? { borderColor: "var(--navy)", color: "var(--navy)" } : undefined} onClick={() => setOpenG(k)}>{label} {counts[k]}</button>)}
    </div>
    {openG === "drop7" ? <>{drop7Data ? <Drop7Panel data={drop7Data} openRow={(gps) => { location.hash = `ev-fleet?gpsno=${encodeURIComponent(gps)}`; }} /> : <EmptyState kind="loading" />}</> : null}
    
    {openG !== "drop7" && <ResourceTable key={`q-${openG}`} resource="admin.review_queue" pageSize={15} columns={["gpsno", "safety_score", "risk_level", "confidence_level", "forecast_40d_risk_prob", "action_deadline", "top_reason_1"]} params={{ review_queue: openG }}
      rowActionLabel="查看" onRowClick={openDriver} labels={{ primary_risk_dimension: "主要风险维度", recommended_action: "建议动作", queue_id: "queue_id(来源)", gpsno: "车辆", safety_score: "14天安全分", rank: "车队排名", risk_level: "等级", forecast_40d_risk_prob: "40天概率", action_deadline: "处置时限", confidence_level: "可信度", top_reason_1: "首要原因", as_of_date: "截止日", source_version: "来源版本" }} />}
    
    {openG !== "drop7" && <QueueConfirm group={openG} />}
  </div>;
}

const REPLAY_VEHICLES = ["95301325", "95301330", "95301567", "95302616"];

function QueueConfirm({ group }: { group: string }) {
  const [gpsno, setGpsno] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dual = group === "priority_review";
  async function go() {
    setBusy(true); setMsg(null);
    try {
      const evidence = `${gpsno}_2026-07-31`;
      const r = await alertConfirm({ gpsno, rule_code: dual ? "dual_signal_priority" : "data_verification", evidence_id: evidence, occurred_at: "2026-07-31" });
      setMsg(`${r.idempotent_replay ? "幂等重放：返回既有 " : "已创建待人工核查告警 "}alert_id=${r.alert_id}（status=${r.status}，规则版本 ${r.rule_code === "data_verification" ? "data_verification@queue_rules_v1，核验性待办、非惩罚" : "dual_signal_priority@queue_rules_v1"}）。确认前不发送任何消息。`);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "network_error";
      setMsg({ rule_dual_not_top20pct: "拒绝：不满足双信号（预测前20%且行为C/D）——不自动打分", rule_dual_behavior_not_CD: "拒绝：行为等级非C/D", rule_data_low_confidence_required: "拒绝：该对象可信度不低，不应走数据核验分流", evidence_not_found: "拒绝：找不到该证据行", case_closed_reopen_requires_new_alert: "案卷已关闭，重新处置需另建告警（保留旧案）" }[code] || `拒绝：${code}`);
    }
    setBusy(false);
  }
  return <div className="panel"><h3>{dual ? "双信号优先对象 · 待人工核查入口" : "低可信度分流 · 建立设备/数据核验待办"}</h3>
    <p className="page-desc">{dual ? "入口仅对『预测排名前20% ∧ 行为等级C/D』成立：服务端复核证据（review_queue/risk_snapshots），只决定处置先后，不产生新风险分；确认前不生成正式alert。" : "低可信度对象进入数据/设备核验方向（人工点击触发），自动奖惩与自动培训均禁止。"}</p>
    <div className="row"><input className="btn" style={{ width: 160, textAlign: "left" }} value={gpsno} onChange={(e) => setGpsno(e.target.value)} aria-label="车辆gpsno" placeholder="gpsno" />
      <button className="btn primary" style={{ width: "auto" }} onClick={go} disabled={busy}>{busy ? "处理中…" : (dual ? "对该对象发起人工核查（建待复核告警）" : "建立设备/数据核验待办")}</button></div>
    {msg && <div className="alert info">{msg}</div>}
    <p className="login-note">幂等：车辆+规则+证据+日期只建一条；重试与双击返回同一 alert_id。正面对象：95301325（DEMO_D0149）。</p>
  </div>;
}

function RmReplay() {
  const [all, setAll] = useState<ScoreRow[] | null>(null);
  const [err, setErr] = useState(false);
  const [veh, setVeh] = useState<string>("all");
  const [cursor, setCursor] = useState(0);   // 已揭示事件数
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => { let acc: ScoreRow[] = []; for (let off = 0; ; off += 200) { const r = await getData<ScoreRow>("admin.replay_events", { limit: 200, offset: off }); acc = acc.concat(r.rows); if (r.rows.length < 200) break; } if (!alive) return; setAll(acc.sort((a, b) => String(a.event_time).localeCompare(String(b.event_time)))); })().catch(() => setErr(true));
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!playing || !all) return;
    const t = setInterval(() => setCursor((c) => { if (c + 1 >= shown.length) { setPlaying(false); return c + 1; } return c + 1; }), 120);
    return () => clearInterval(t);
  });
  if (err) return <EmptyState kind="error" />;
  if (!all) return <EmptyState kind="loading" />;
  if (all.length === 0) return <EmptyState kind="nomatch" hint="replay_events 未导入；不展示虚构回放。" />;
  const shownAll = veh === "all" ? all : all.filter((e) => e.gpsno === veh);
  const shown = shownAll;
  const visible = shown.slice(0, Math.min(cursor, shown.length));
  const clock = visible.length ? String(visible[visible.length - 1].event_time) : "未到首个事件";
  const byVeh: Record<string, number> = {};
  for (const e of all) byVeh[String(e.gpsno)] = (byVeh[String(e.gpsno)] || 0) + 1;
  return <div>
    <PageHead code="RM02" title="历史事件回放" desc="" />
    <Banner tone="warn"><span><b>历史回放 · 2026-07-29 · 仅覆盖选定车辆（{Object.keys(byVeh).length} 辆：{Object.entries(byVeh).map(([g, n]) => `${g}(${n})`).join("，")}）</b>。这不是车队全量监控，也不是实时推送；回放操作只推进显示时钟，不生成告警、不写任何业务表。</span></Banner>
    <div className="panel"><h3>回放时钟：<span className="mono">{clock}</span> · 已揭示 {visible.length}/{shown.length} 事件</h3>
      <div className="row">
        <button className="btn" onClick={() => setPlaying((v) => !v)}>{playing ? "⏸ 暂停" : "▶ 播放"}</button>
        <button className="btn" onClick={() => setCursor((c) => Math.min(c + 10, shown.length))}>⏩ 跳进一步(+10)</button>
        <select className="btn" style={{ background: "#fff" }} value={Math.min(cursor, Math.max(shown.length - 1, 0))} onChange={(e) => { setPlaying(false); setCursor(Number(e.target.value) + 1); }}>
          {shown.map((e, i) => <option key={String(e.event_id)} value={i}>{`${String(e.event_time)} · ${String(e.gpsno)} · ${String(e.event_name).slice(0, 18)}`}</option>).slice(0, 200)}
        </select>
        <button className="btn" onClick={() => { setPlaying(false); setCursor(shown.length); }}>跳至结束</button>
        <button className="btn" onClick={() => { setPlaying(false); setCursor(0); }}>↺ 重置</button>
        <select className="btn" style={{ background: "#fff" }} value={veh} onChange={(e) => { setVeh(e.target.value); setCursor(0); setPlaying(false); }}>
          <option value="all">全部四辆</option>{REPLAY_VEHICLES.map((g) => byVeh[g] ? <option key={g} value={g}>{g}</option> : null)}
        </select>
      </div>
      <p className="meta">跳转下拉列出前 200 个事件时间；时钟未到不显示。</p>
    </div>
    <div className="table-wrap" style={{ maxHeight: 380, overflow: "auto" }}>
      <table><thead><tr><th>事件时间</th><th>车辆</th><th>事件类型</th><th>名称</th><th>速度km/h</th><th>维度</th><th>event_id</th></tr></thead><tbody>
        {visible.map((e) => <tr key={String(e.event_id)}><td className="mono">{String(e.event_time)}</td><td className="mono">{String(e.gpsno)}</td><td className="mono">{String(e.event_type)}</td><td title={String(e.event_name)}>{String(e.event_name).slice(0, 28)}</td><td>{String(e.speed_kmh)}</td><td>{String(e.dimension)}</td><td className="mono" style={{ fontSize: 11 }}>{String(e.event_id)}</td></tr>)}
      </tbody></table>
      {visible.length === 0 && <EmptyState kind="nomatch" hint="回放时钟未推进——点“播放”或“跳进”，不显示未来事件。" />}
    </div>
    <div className="panel" style={{ marginTop: 12 }}>
      <h3>事后参考（非 07-29 当时已知）</h3>
      <p className="page-desc">下表为 2026-07-31 预测快照与近14天评分（含 07-24→07-29 前后的滚动值）：<b>仅供事后对照，回放时点不可作为当时证据；14天评分窗口值同样按事后回算参考呈现</b>。单次未遂（如某车辆的 near-miss 类事件）不等同于正式 40 天事故标签成立。</p>
      <ResourceTable resource="admin.score_snapshots" pageSize={10} params={{ gpsno: veh === "all" ? REPLAY_VEHICLES.join(",") : veh }} labels={{ driver_id: "司机", gpsno: "车辆", safety_score: "14天分(0731快照)", risk_level: "等级", confidence_level: "可信度", forecast_40d_risk_prob: "40天概率(事后)" }} />
    </div>
  </div>;
}

function RmAlerts({ initialAlertId }: { initialAlertId?: string | null }) {
  const [tick, setTick] = useState(0);
  const [openId, setOpenId] = useState<string | null>(initialAlertId || null);
  const [cs, setCs] = useState<CaseViewT | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [closeReason, setCloseReason] = useState("");
  const [owner, setOwner] = useState(""); const [contactAt, setContactAt] = useState(""); const [noteTxt, setNoteTxt] = useState("");
  useEffect(() => {
    const take = () => { try { const raw = sessionStorage.getItem("claw_fill"); if (!raw) return false; const ft = JSON.parse(raw); if (ft.form !== "rm3_draft") return false; if (ft.alert_id) { setOpenId(String(ft.alert_id)); if (ft.draft_text) setDraft(String(ft.draft_text)); sessionStorage.removeItem("claw_fill"); setFillNote("已填入 AI 草稿（可编辑）：保存草稿仅建 draft；确认前不会发送"); } return true; } catch { return false; } };
    if (!take()) setFillNote(null);
    const onHash = () => { const m = location.hash.match(/[?&]alert_id=([^&#]+)/); if (m) setOpenId(decodeURIComponent(m[1])); take(); };
    window.addEventListener("hashchange", onHash); window.addEventListener("claw:fill", onHash as never);
    return () => { window.removeEventListener("hashchange", onHash); window.removeEventListener("claw:fill", onHash as never); };
  }, []);
  const [fillNote, setFillNote] = useState<string | null>(null);
  useEffect(() => {
    if (openId) caseView(openId).then((v) => { setCs(v); const d = v.interventions.find((i) => i.status === "draft"); if (d) setDraft(String(d.draft_text || "")); }).catch(() => setCs(null));
    else setCs(null);
  }, [openId, tick]);
  async function act(fn: () => Promise<unknown>, okMsg: string) {
    setMsg(null); setSending(true);
    try {
      const r = (await fn()) as { audit_id?: string | null; idempotent_replay?: boolean };
      setMsg(`${okMsg} · 审计 ${r.audit_id ?? "—"}/${r.idempotent_replay ? "幂等重放（未新增）" : "已持久化"}`);
      setTick((x) => x + 1);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "network";
      const text = { alert_not_confined_as_confirmed: "拒绝：先在案卷内「确认证据属实」后才可建干预草稿", intervention_state_sent_not_editable: "已发送正文不可改写", intervention_state_invalid: "当前状态不允许该转移", close_reason_required: "关闭必须写明原因（已完成干预/证据不成立/转设备核验/重复记录）" }[code] || `拒绝：${code}`;
      setMsg(text);
    }
    setSending(false);
  }
  const al = cs?.alert as Record<string, unknown> | undefined;
  const st = String(al?.status || "");
  const draftRow = cs?.interventions.find((i) => i.status === "draft");
  return <div>
    <PageHead code="RM03 / RM05" title="告警复核与事件档案" desc="状态机（服务端强制，客户端仅呈现合法动作）：待复核 → 已确认/重复/需补充 → 干预草稿 → 已发送 → 已读/已回复 → 关闭(带原因)。确认发送是唯一送达入口；当前运行时AI未接通，草稿为人工撰写。" />
    <ResourceTable key={`al${tick}`} resource="admin.alerts" onRowClick={(r) => setOpenId(String(r.alert_id))} labels={{ alert_id: "alert_id", gpsno: "车辆", driver_id: "司机", rule_code: "触发规则", evidence_id: "证据ID", occurred_at: "事实日期", status: "状态", owner_user_id: "责任人" }} />
    {cs && al && <div className="panel">
      <h3>事件档案 · {String(al.gpsno)} · {String(al.rule_code)} @ {String(al.rule_version)}</h3>
      <Banner tone="info"><span>alert_id <span className="mono">{String(al.alert_id)}</span> · 证据 <span className="mono">{String(al.evidence_id)}</span> · 事实日期 {String(al.occurred_at)}</span></Banner>
      <div className="grid2">
        <div className="stack">
          <div className="kv">
            <span className="kk">状态</span><b>{st}</b>
            <span className="kk">责任人</span><b className="mono">{String(al.owner_user_id || "—")}</b>
            <span className="kk">司机绑定</span><b>{cs.demo_binding ? cs.demo_binding.note : "无有效绑定账号：待办保留、不显示“已送达”"}</b>
            <span className="kk">下一步</span><b>{st === "pending_review" ? "人工复核三选一" : st === "confirmed" ? "建草稿并确认发送" : ["sent", "read"].includes(st) ? "等待司机" : st === "closed" ? "查看记录" : "复核反馈"}</b>
          </div>
          {st === "pending_review" && <div className="row">
            <button className="btn primary" style={{ width: "auto" }} disabled={sending} onClick={() => act(() => alertStatus(String(al.alert_id), "confirmed"), "已确认：证据属实")}>■ 确认证据属实</button>
            <button className="btn" disabled={sending} onClick={() => act(() => alertStatus(String(al.alert_id), "duplicate"), "标记为重复/误触发")}>误触发/重复</button>
            <button className="btn" disabled={sending} onClick={() => act(() => alertStatus(String(al.alert_id), "supplement_data"), "转数据/设备补充")}>需补充核查</button>
          </div>}
          {st === "confirmed" && !draftRow && <div className="stack">
            <div className="row" style={{ margin: 0 }}><span className="tag" style={{ background: "#fff7e6", color: "#ad6800", borderColor: "#ffd591", fontSize: 12 }}>草稿，未发送（AI 填入内容可直接编辑）</span></div>
          <TemplateInsertRow gpsno={"—"} driverId={String(cs?.alert?.driver_id ?? ((location.hash.match(/driver_id=([^&]+)/)||[])[1] ?? ""))} onInsert={(txt) => setDraft(txt)} />
          <textarea className="btn" style={{ width: "100%", minHeight: 76, textAlign: "left", fontFamily: "inherit" }} aria-label="干预草稿" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="人工撰写沟通正文（发送前不落任何 sent 字段）" />
            <button className="btn primary" style={{ width: "auto" }} disabled={sending || !draft.trim()} onClick={() => act(() => interventionDraft(String(al.alert_id), draft), "干预草稿已建（仅草稿）")}>保存草稿（不构成送达）</button>
          </div>}
          {st === "confirmed" && draftRow && <div className="stack">
            <textarea className="btn" style={{ width: "100%", minHeight: 76, textAlign: "left", fontFamily: "inherit" }} aria-label="草稿编辑" value={draft} onChange={(e) => setDraft(e.target.value)} />
            <div className="row">
              <button className="btn" disabled={sending} onClick={() => act(() => interventionEdit(String(draftRow.intervention_id), draft), "草稿已更新")}>更新草稿</button>
              <button className="btn primary" style={{ width: "auto" }} disabled={sending || !draft.trim()} onClick={() => act(() => interventionSend(String(draftRow.intervention_id)), "安全员已确认发送：sent_text/sent_at/审计/站内通知")}>■ 确认发送（唯一入口，双击幂等）</button>
            </div>
          </div>}
          {st !== "closed" && <div className="row" style={{ marginTop: 6 }}>
            <select className="btn" style={{ background: "#fff" }} aria-label="转交对象" value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">转交给…</option><option value="u-admin-0001">u-admin-0001（安全管理员）</option></select>
            <button className="btn" disabled={!owner || sending} onClick={() => act(() => alertHandoff(String(al.alert_id), owner), "责任人已转交")}>转交责任人</button>
            <input className="btn" style={{ width: 170 }} type="date" value={contactAt} onChange={(e) => setContactAt(e.target.value)} aria-label="再次联系日期" />
            <button className="btn" disabled={!contactAt || sending} onClick={() => act(() => alertContact(String(al.alert_id), contactAt), "再次联系时间已设")}>设定再次联系</button>
            <input className="btn" style={{ flex: 1, minWidth: 160, textAlign: "left" }} value={noteTxt} onChange={(e) => setNoteTxt(e.target.value)} placeholder="内部备注（仅管理员端与审计可见）" aria-label="内部备注" />
            <button className="btn" disabled={!noteTxt.trim() || sending} onClick={() => act(() => alertNote(String(al.alert_id), noteTxt), "内部备注已留痕")}>记备注</button>
          </div>}
          <div className="row">
            <select className="btn" style={{ background: "#fff" }} aria-label="关闭原因" value={closeReason} onChange={(e) => setCloseReason(e.target.value)}><option value="">关闭原因…</option>{["已完成干预", "证据不成立", "转设备核验", "重复记录"].map((x) => <option key={x}>{x}</option>)}</select>
            <button className="btn" disabled={sending || !closeReason || st === "closed"} onClick={() => act(() => alertStatus(String(al.alert_id), "closed", closeReason), "案卷已关闭")}>关闭案卷</button>
          </div>
          {st !== "closed" && <details style={{ marginTop: 8 }}><summary style={{ cursor: "pointer", fontSize: 13 }}>处置方案预演（未写入任何数据）</summary>
            <div className="grid2" style={{ fontSize: 13 }}>
              <div className="task-card"><div className="t">① 先设备/数据核验</div><div className="meta">将产生：data_verification 待办或核验备注；不判罚、不改分；适用：低可信/manual_review（本规则 {String(al.rule_code)}）</div></div>
              <div className="task-card"><div className="t">② 先沟通干预</div><div className="meta">将产生：干预草稿→确认发送后站内消息；前提：alert 已 confirmed、司机为有效绑定（当前 {cs.demo_binding ? "有账号" : "无绑定→不可标已送达"}）</div></div>
              <div className="task-card"><div className="t">③ 分配已审核课程</div><div className="meta">前提：课程 approved + 绑定核实；未满足必 409；效果=培训待办/任务，绝不改算法值（见 TR02/TR05）</div></div>
              <div className="task-card"><div className="t">④ 关闭案卷</div><div className="meta">选择关闭原因，保留处置记录</div></div>
            </div>
          </details>}
          {fillNote && <div className="alert info">{fillNote}</div>}
          {msg && <div className="alert info">{msg}</div>}
        </div>
        <div className="stack">
          <h4 style={{ fontSize: 13 }}>真实时间轴（audit_logs）</h4>
          {cs.timeline.map((e) => <div key={String(e.audit_id)} className="task-card"><div className="t"><span className="mono">{String(e.action)}</span> · {String(e.old_status || "—")} → {String(e.new_status || "—")}</div><div className="meta">{String(e.occurred_at)} · {String(e.actor_id)}（{String(e.actor_role)}）{e.detail_json ? ` · 内部备注：${String((JSON.parse(String(e.detail_json)) as { internal_note?: string }).internal_note || "").slice(0, 70)}` : ""}</div></div>)}
          {cs.timeline.length === 0 && <EmptyState kind="nomatch" hint="本案卷尚无动作" />}
          {cs.interventions.map((i) => <div key={String(i.intervention_id)} className="task-card"><div className="t">干预 {String(i.intervention_id)} · <Tag tone={String(i.status) === "replied" ? "green" : "blue"}>{String(i.status)}</Tag></div><div className="meta">sent_at {String(i.sent_at || "—")} · read_at {String(i.read_at || "—")} · replied_at {String(i.replied_at || "—")}</div>{i.sent_text ? <div className="meta">正文（发送后冻结）：{String(i.sent_text)}</div> : null}{i.reply_text ? <div className="meta">司机回复：{String(i.reply_text)}</div> : null}</div>)}
          {cs.notifications.map((n) => <div key={String(n.notification_id)} className="task-card"><div className="t">站内通知 {String(n.notification_id)}</div><div className="meta">target {String(n.target_user_id)} · 读 {String(n.read_at || "未读")} · ≠外部渠道送达</div></div>)}
        </div>
      </div>
      <div className="row"><button className="btn" onClick={() => { setOpenId(null); setMsg(null); }}>← 返回告警列表（保留状态）</button></div>
    </div>}
    {!openId && <p className="login-note">点告警行看案卷；低可信对象（如 95302616）只应出现核验类待办；案卷不自动关闭。</p>}
  </div>;
}

const TASK_STATUSES = ["assigned", "in_progress", "submitted", "reviewed", "returned", "observation", "interview"];

function TaskDetail({ taskId, onBack }: { taskId: string; onBack: () => void }) {
  const [v, setV] = useState<Awaited<ReturnType<typeof taskView>> | null | "error">(null);
  useEffect(() => { taskView(taskId).then(setV).catch(() => setV("error")); }, [taskId]);
  if (v === "error") return <EmptyState kind="error" />;
  if (!v) return <EmptyState kind="loading" />;
  const { task, alert, course, timeline, reassess } = v;
  const now = new Date();
  const overdue = ["assigned", "in_progress", "returned"].includes(String(task.status)) && task.due_at && new Date(String(task.due_at)) < now;
  return <div className="panel">
    <div className="row"><button className="btn" onClick={onBack}>← 返回台账</button><h3 style={{ fontSize: 14 }}>培训任务 {String(task.task_id)}</h3><Tag tone="blue">{String(task.status)}</Tag>{overdue ? <Tag tone="red">逾期（展示分支）</Tag> : null}</div>
    <div className="grid2" style={{ marginTop: 8 }}>
      <div className="kv">
        <span className="kk">司机</span><b className="mono">{String(task.driver_id)}</b>
        <span className="kk">课程</span><b>{String(course?.title || task.course_id)}（{String(course?.course_id)} · {String(course?.content_status)}）</b>
        <span className="kk">完成条件</span><b>{String(course?.completion_requirement || "—")}</b>
        <span className="kk">目标</span><b>{String(task.goal)}</b>
        <span className="kk">强制性</span><b>{task.mandatory ? "强制（安全员指定）" : "非强制"}</b>
        <span className="kk">截止</span><b>{String(task.due_at || "—")}</b>
        <span className="kk">关联证据</span><b className="mono">{alert ? `alert ${String(alert.alert_id)} · ${String(alert.rule_code)} · 证据 ${String(alert.evidence_id)}` : "无（仅目标驱动）"}</b>
      </div>
      <div>
        <h4 style={{ fontSize: 13 }}>学习记录（提交后冻结）</h4><p style={{ whiteSpace: "pre-wrap", fontSize: 13, background: "var(--bg)", borderRadius: 8, padding: 8 }}>{String(task.learning_record || "（未填写）")}</p>
        <h4 style={{ fontSize: 13 }}>司机反馈</h4><p style={{ fontSize: 13 }}>{String(task.feedback || "—")}</p>
        {task.review_note ? <><h4 style={{ fontSize: 13 }}>审核意见（{String(task.reviewer_id)} @ {String(task.reviewed_at)}）</h4><p style={{ fontSize: 13 }}>{String(task.review_note)}</p></> : null}
      </div>
    </div>
    <h4 style={{ fontSize: 13, marginTop: 10 }}>时间轴（同 task_id 审计链）</h4>
    {timeline.map((e) => <div key={String(e.audit_id)} className="task-card"><div className="t"><span className="mono">{String(e.action)}</span> · {String(e.old_status || "—")} → {String(e.new_status || "—")}</div><div className="meta">{String(e.occurred_at)} · {String(e.actor_id)}（{String(e.actor_role)}）</div></div>)}
    {timeline.length === 0 && <EmptyState kind="nomatch" hint="尚无动作" />}
    <h4 style={{ fontSize: 13, marginTop: 8 }}>复评（同一维度下一可用日期的真实观测，不宣称因果）</h4>
    {reassess?.date ? <p style={{ fontSize: 13 }}>{reassess.date}：安全分 {String(reassess.row?.safety_score)} · 等级 {String(reassess.row?.risk_level)} · 可信度 {String(reassess.row?.confidence_level)}（仅作前后观察陈述）</p>
      : <p className="login-note"><b>待下一周期数据</b>——尚无晚于提交日的日终快照；不虚构提升，不将变化归因于培训本身。</p>}
  </div>;
}

function ReviewBench() {
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof taskView>> | null>(null);
  const [decision, setDecision] = useState("approved");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [sum, setSum] = useState<TaskSummary | "loading" | null>(null);
  const [chk, setChk] = useState<string | null>(null);
  const load = () => { getData<Record<string, unknown>>("admin.trainings", { limit: 100 }).then((r) => setRows(r.rows.filter((x) => x.status === "submitted" || x.status === "returned"))).catch(() => setRows([])); };
  useEffect(load, [msg]);
  useEffect(() => { if (sel) { taskView(sel).then((v) => setDetail(v)).catch(() => setDetail(null)); setSum(null); setChk(null); } }, [sel]);
  if (!rows) return <EmptyState kind="loading" />;
  async function send() { setMsg(null); try { const r = await taskReview(sel!, decision, reason); setMsg(`审核完成：${r.new_status} · 业务=${r.task_id} · 审计 ${r.audit_id}${r.idempotent_replay ? "（旧状态复核：仅返回原结果，未重复写入）" : ""}`); setSel(null); load(); } catch (e) { setMsg("审核被拒：" + (e instanceof ApiError ? e.code : "network") + "（需 submitted/returned 态 + 理由）"); } }
  return <div>
    <h3 style={{ fontSize: 14 }}>TR06 反馈与复核工作台（待复核队列：submitted / returned）</h3>
    {rows.length === 0 && <EmptyState kind="nomatch" hint="当前没有已提交待复核的任务（历史 reviewed 任务可经 TR01 台账查看，不生成假待办）" />}
    <ResourceTable resource="admin.trainings" pageSize={20} params={{}} onRowClick={(r) => { if (r.status === "submitted" || r.status === "returned") setSel(String(r.task_id)); }} labels={{ task_id: "task_id", driver_id: "司机", course_id: "课程", status: "状态", submitted_at: "提交时间", due_at: "截止" }} />
    {sel && detail && <div className="panel" style={{ marginTop: 10 }}>
      <h3>复核详情</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
        <div className="task-card" style={{ padding: 8 }}>
          <div className="t">① 司机提交原文（永不改写/覆盖，AI 仅引用）</div>
          <p style={{ whiteSpace: "pre-wrap", fontSize: 13, background: "var(--bg)", borderRadius: 8, padding: 8 }} id="tr06-original">{String((detail.task as { learning_record?: string }).learning_record || "—")}{(detail.task as { feedback?: string }).feedback ? "\n[反馈] " + String((detail.task as { feedback?: string }).feedback) : ""}</p>
          <div className="meta">提交时间：{String(detail.task.submitted_at || "—")} · 状态：{String(detail.task.status)}</div>
        </div>
        <div className="task-card" style={{ padding: 8 }}>
          <div className="t">② 课程要求（任务分配指向的版本记录）</div>
          <div className="kv"><span className="kk">课程</span><b>{String(detail.course?.title || "—")} · v{String((detail.course as { version_no?: number } | undefined)?.version_no ?? "—")}</b></div>
          <div className="kv"><span className="kk">完成条件</span><b>{String(detail.course?.completion_requirement || "—")}</b></div>
          <div className="kv"><span className="kk">学习目标</span><b>{String(detail.task.goal || "—")}{detail.task.mandatory ? " · 强制" : ""}</b></div>
          <div className="meta">课程当前状态：{String((detail.course as { content_status?: string } | undefined)?.content_status || "—")}{(detail.course as { content_status?: string } | undefined)?.content_status === "disabled" ? "（课程已停用——本处仍展示分配时的历史版本要求，不回写不删除）" : ""}</div>
        </div>
        <div className="task-card" style={{ padding: 8 }}>
          <div className="t">③ 已授权且可核实的关联证据</div>
          {detail.task.alert_id ? <>
            <div className="kv"><span className="kk">关联案卷</span><b className="mono">{String(detail.task.alert_id)}</b></div>
            <div className="kv"><span className="kk">规则/证据</span><b>{String((detail as { alert?: { rule_code?: string; evidence_id?: string } }).alert?.rule_code || "—")} · {String((detail as { alert?: { evidence_id?: string } }).alert?.evidence_id || "—")}</b></div>
            <div className="kv"><span className="kk">事实日期</span><b>{String((detail as { alert?: { occurred_at?: string } }).alert?.occurred_at || "—")}</b></div>
          </> : <div className="alert info">未取得：该任务未关联 alert_id（系统不臆造证据）</div>}
        </div>
        <div className="task-card" style={{ padding: 8, borderColor: "#b9cbe8", background: "#f6f9ff" }}>
          <div className="t">④ AI 辅助摘要（只读草稿，不判定通过/退回；零写库）</div>
          <button className="btn" disabled={sum === "loading"} onClick={async () => { setSum("loading"); try { setSum(await taskSummary(sel!)); } catch { setSum({ available: false, note: "生成失败（服务端已留审计）" }); } }}>{sum === "loading" ? "生成中…" : sum && typeof sum === "object" && sum.available ? "重新生成摘要" : "生成 AI 辅助摘要（受控只读）"}</button>
          {sum === "loading" && <div className="meta">模型运行中（读取的是本页同源事实，生成不改任务状态/reviewer/时间戳）</div>}
          {sum && typeof sum === "object" && !sum.available && <div className="alert warn">AI 摘要暂不可用：{String(sum.reason || "")} —— {String(sum.note || "前三部分与人工审核照常可用")}</div>}
          {sum && sum !== "loading" && sum.available && <>
            {sum.cached ? <div className="meta">（10 分钟内复用缓存结果，未重复计费/调用）</div> : null}
            {sum.course ? <div className="meta">课程版本核对：v{sum.course.version_no} · 当前 {sum.course.current_status}{sum.course.note ? " · " + sum.course.note : ""}</div> : null}
            {(sum.items || []).map((it, n) => <div key={n} className="task-card" style={{ padding: 6, marginTop: 5 }}>
              <div style={{ fontSize: 12.5 }}><b>{it.judgment}</b> <Tag tone={it.state === "覆盖" ? "green" : it.state === "未见" ? "amber" : "gray"}>{it.state}</Tag>{!it.ref_ok ? <Tag tone="red">ref 不在白名单（已隔离不生效）</Tag> : null}</div>
              <div className="meta" style={{ fontSize: 11.5 }}>依据：{it.fact} → <button className="btn" style={{ padding: "0 6px", fontSize: 11 }} onClick={async () => { const ref = it.ref.startsWith("task:") ? null : it.ref; if (!ref) { document.getElementById("tr06-original")?.scrollIntoView({ block: "center" }); setChk("已定位到 ① 原文（同一记录）"); return; } try { const rr = await aiEvidenceCheck(ref); if (rr.ok && rr.route) { location.hash = rr.route.replace(/^#/, ""); setChk("引用重新验权通过：" + ref); } else setChk("该引用重新验权未通过或记录已变化（不缓存旧数据）"); } catch { setChk("引用验权失败"); } }}>{it.ref} ↗</button></div>
            </div>)}
            <div className="meta">{(sum.limitations || []).join(" ")}</div>
            <div className="meta">{sum.audit_note} · 模型 {sum.model}</div>
          </>}
          {chk && <div className="alert info">{chk}</div>}
        </div>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <select className="btn" style={{ background: "#fff" }} value={decision} onChange={(e) => setDecision(e.target.value)} aria-label="审核决定"><option value="approved">通过</option><option value="returned">退回补充</option><option value="observe">继续观察</option><option value="interview">转面谈</option></select>
        <input className="btn" style={{ flex: 1, textAlign: "left", minWidth: 200 }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="审核理由（必填；先看原文再填写）" aria-label="审核理由" />
        <button className="btn primary" style={{ width: "auto" }} onClick={send} disabled={!reason.trim()}>人工确认（写入并留痕）</button>
        <button className="btn" onClick={() => setSel(null)}>收起</button>
      </div>
      <p className="meta">AI 摘要与人工确认相互独立：摘要生成/刷新零写库；确认走原有状态机（校验角色、旧状态版本、幂等——旧已审任务重复点击仅回放原业务结果，人工原结论不被改写）。</p>
      {msg && <div className="alert info">{msg}</div>}
    </div>}
    {sel && !detail && <div className="meta">任务读取失败或无权访问</div>}
  </div>;
}

function TrLedger()  {
  const tid = (location.hash.split("task_id=")[1] || "").split("&")[0];
  const [tick, setTick] = useState(0);
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => { getData<Record<string, unknown>>("admin.trainings", { limit: 200 }).then((r) => setRows(r.rows)).catch(() => setRows([])); }, [tick]);
  const counts: Record<string, number> = {};
  for (const r of rows || []) { counts[String(r.status)] = (counts[String(r.status)] || 0) + 1; if (r.due_at && ["assigned", "in_progress", "returned"].includes(String(r.status)) && new Date(String(r.due_at)) < new Date()) counts.overdue = (counts.overdue || 0) + 1; }
  if (sel) return <TaskDetail taskId={sel} onBack={() => { setSel(null); setTick((x) => x + 1); }} />;
  return <div>
    <PageHead code="TR01" title="培训任务台账" desc="任务状态按“草稿(TR02未提交)→已分配→进行中→已提交→已复核”，逾期/退回为分支（红=逾期）。计数为 training_tasks 实数。" />
    <TrainingNotificationRecovery />
    <div className="cards">
      {["assigned", "in_progress", "submitted", "reviewed", "returned", "overdue"].map((k) => <div key={k} className={`card ${k === "overdue" ? "risk" : ""}`}><div className="k">{({ assigned: "已分配", in_progress: "进行中", submitted: "待复核", reviewed: "已复核", returned: "退回补充", overdue: "逾期(展示)" } as Record<string, string>)[k]}</div><div className={`v ${!(counts[k] || 0) ? "zero" : ""}`}>{counts[k] || 0}</div></div>)}
    </div>
    {(!rows || rows.length === 0) ? <>
      <EmptyState kind="nomatch" hint="暂无分配中的培训任务：课程须经团队审核批准后由 TR02 正式分配才会出现（服务端门禁：未审核课程分配一律 409）。" />
      <ReviewBench />
    </> : <>
      <ResourceTable resource="admin.trainings" params={tid ? { task_id: tid } : {}} onRowClick={(r) => setSel(String(r.task_id))} labels={{ task_id: "task_id", driver_id: "司机", alert_id: "关联告警", course_id: "课程", mandatory: "强制", due_at: "截止", status: "状态", submitted_at: "提交", reviewed_at: "复核" }} />
      <ReviewBench />
    </>}
  </div>;
}

function TrCourses({ localOnly = false }: { localOnly?: boolean }) {
  return <div>
    <PageHead code="TR05 / SM06" title="课程库与人工审核" desc="真实 training_courses：保留原 content_status 与课程文本；作者/审核人/审核时间由 audit_logs 合成（表无该列，平台无 DDL 通道）。三门 DEMO_C01–C03 保持待团队审核，不因挂载自动批准。批准/停用为明确确认动作；TR02 与 AI 只引用 approved 版本，草稿/待审/停用直接接口请求被服务端拒绝。" />
    <CourseBoard localOnly={localOnly} />
  </div>;
}

// SM01：挂载完整账号管理面板（组件与 manage.accounts 门禁复用第2/13轮后端，未重建账号体系）
function AccountAdmin() { return null; }
function TemplateInsertRow(props: { gpsno: string; driverId: string; onInsert: (t: string) => void }) {
  const [opts, setOpts] = useState<{ migration_pending?: boolean; latest?: { template_id: string; template_key: string; version: number; title: string; review_status: string }[] } | null>(null);
  const [sel, setSel] = useState(""); const [note, setNote] = useState<string | null>(null);
  useEffect(() => { fetch("/api/admin/templates?review_status=approved&scene=rm3_draft", { credentials: "include" }).then((r) => r.json()).then((j) => setOpts(j)).catch(() => setOpts({ latest: [] })); }, []);
  const approved = (opts?.latest || []).filter((x) => x.review_status === "approved");
  if (opts && opts.migration_pending) return <div className="meta">通知模板暂不可用。<b>可编辑草稿</b>。</div>;
  return <div className="row" style={{ gap: 6, margin: "4px 0", flexWrap: "wrap" }}>
    <select className="btn" style={{ width: "auto", maxWidth: 260 }} value={sel} onChange={(e) => setSel(e.target.value)} aria-label="模板选择"><option value="">从已审核模板插入…（{approved.length ? approved.length + " 个可用" : "暂无 approved 模板——不会凭空插入"}）</option>{approved.map((a) => <option key={a.template_id} value={a.template_id}>{a.template_key}:v{a.version} · {a.title}</option>)}</select>
    <button className="btn" disabled={!sel} onClick={async () => { try { const r = await fetch(`/api/admin/template-preview?template_id=${encodeURIComponent(sel)}&driver_id=${encodeURIComponent(props.driverId)}`, { credentials: "include" }).then((x) => x.json()); if (r.ok && r.rendered) { props.onInsert(String(r.rendered)); setNote("预览已插入正文（可编辑；缺事实保留（待核：…））" + (r.missing_facts?.length ? " · 缺：" + r.missing_facts.join("、") : "") + (r.bound_account ? "" : " · 该司机无已核实绑定：发送后不会显示已送达") + "；发送仍需人工确认"); } else setNote(String(r.error || r.note || "预览不可用（未审核模板已拒绝）")); } catch { setNote("预览失败"); } }}>预览并插入草稿</button>
    {note && <span className="meta">{note}</span>}
  </div>;
}

function SmAccounts() {
  return <div>
    <PageHead code="SM01" title="账号与角色管理" desc="列表按当前管理员 fleet_scope 过滤；角色/状态/车队筛选；创建（演示仅 safety_admin 与 driver 两类登录）、编辑抽屉（显示名/车队范围/司机绑定）、停用与恢复。服务端唯一性：登录名唯一、司机有效绑定唯一、未核实身份不可自动绑定演示司机；停用即时清会话。任何页面与日志均不出现口令明文。" />
    <AccountAdminPanel />
    <p className="login-note">同一 safety_admin 兼具系统配置与安全处置两组能力（capability 矩阵见后端 ROLE_CAPABILITIES），不设第三种管理员登录。绑定核实入口保持在 SM02（BindPanel）。任何页面与日志均不出现口令明文。</p>
  </div>;
}

function BindPanel() { return <BindingsPanelLazy />; }
function BindingsPanelLazy() { const [drv, setDrv] = useState<{ driver_id: string; gpsno: string }[] | null>(null); useEffect(() => { import("./api").then((m) => m.getData<{ driver_id: string; gpsno: string }>("admin.drivers", { limit: 600 }).then((r) => setDrv(r.rows)).catch(() => setDrv([]))); }, []); if (!drv) return <div className="meta">读取车队司机档案…</div>; return <BindingsConsole drivers={drv} />; }

function SmBindings() {
  return <div>
    <PageHead code="SM02" title="司机档案与车辆绑定" desc="绑定关系写 user_bindings（account/user 体系），展示 gpsno、driver_id、平台账号、identity_status、生效起止与演示身份标识；drivers 表冻结映射、历史评分与预测快照永不改写。日期语义：闭区间含首尾日；相邻(次日开始)允许；空结束=持续有效。结束早于开始、同车重叠跨账号、同账号同窗多司机均在服务端强制拒绝（编辑排除自身；并发经进程内互斥+写后回读自动回滚——多副本部署时该保护降级，需平台事务/唯一约束）。未核实的绑定不会下发个人明细（my.* 403）。as_of 可回看历史当日有效关系。" />
    <BindingsPanelLazy />
  </div>;
}

function OpConfigPanel() {
  const [rows, setRows] = useState<ScoreRow[] | null>(null);
  const [sel, setSel] = useState(""); const [val, setVal] = useState(""); const [eff, setEff] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [ver, setVer] = useState<string | null>(null);
  useEffect(() => { getData<ScoreRow>("admin.operation_config").then((r) => { setRows(r.rows); const c = r.rows.find((x) => x.config_id === "drop_threshold"); if (c) { setSel("drop_threshold"); setVer(String(c.config_version)); setVal(String(c.value)); } }).catch(() => setRows([])); }, []);
  async function upd() {
    setMsg(null);
    try {
      const r = await opsConfigUpdate({ config_id: sel, value: val, effective_at: eff || undefined });
      setMsg(`已生成新版本 v${r.new_version}：${r.old_value} → ${r.new_value}，生效 ${r.effective_at}，审计 ${r.audit_id}`);
      const g = await getData<ScoreRow>("admin.operation_config"); setRows(g.rows);
    } catch (e) { setMsg(e instanceof ApiError ? `拒绝：${e.code}` : "网络异常"); }
  }
  return <div>
    <p className="page-desc">运营参数影响待办优先级与流程时限（如 7 天下降阈值仅决定队列提示），<b>不参与也不得重算/覆写事故概率、安全分、等级、六维扣分</b>；每次修改版本+1，旧值/新值/操作者/生效时间入审计。本轮保持 ops_v1 原值。</p>
    <ResourceTable resource="admin.operation_config" labels={{ config_id: "配置项", value: "值", unit: "单位", config_version: "版本", updated_by: "修改人", updated_at: "修改时间", effective_at: "生效时间" }} />
    <div className="panel" style={{ marginTop: 10 }}><h3>修改运营参数（产生新版本，需安全管理员确认）</h3>
      <div className="row">
        <select className="btn" style={{ background: "#fff" }} value={sel} onChange={(e) => { setSel(e.target.value); const x = (rows || []).find((y) => y.config_id === e.target.value); if (x) setVal(String(x.value)); }}>{(rows || []).map((x) => <option key={String(x.config_id)} value={String(x.config_id)}>{String(x.config_id)}（当前 {String(x.value)} {String(x.unit || "")} · v{String(x.config_version)}）</option>)}</select>
        <input className="btn" style={{ width: 120, textAlign: "left" }} value={val} onChange={(e) => setVal(e.target.value)} placeholder="新值" aria-label="新值" />
        <input className="btn" style={{ width: 210, textAlign: "left" }} value={eff} onChange={(e) => setEff(e.target.value)} placeholder="生效时间（默认现在）" aria-label="生效时间" />
        <button className="btn primary" style={{ width: "auto" }} onClick={upd} disabled={!sel || !val}>确认修改并升版</button>
      </div>
      {msg && <div className="alert info">{msg}</div>}
    </div>
    <MandatePolicyCard />
  </div>;
}

function SmConfig() {
  const [tab, setTab] = useState(0);
  return <div>
    <PageHead code="SM03 · 数据截止 2026-07-31" title="评价规则与运营配置" desc="" />
    <div className="row">
      <button className="btn" style={tab === 0 ? { borderColor: "var(--navy)", color: "var(--navy)" } : undefined} onClick={() => setTab(0)}>评分规则</button>
      <button className="btn" style={tab === 1 ? { borderColor: "var(--navy)", color: "var(--navy)" } : undefined} onClick={() => setTab(1)}>运营参数（带版本）</button>
    </div>
    <div style={{ height: 10 }} />
    {tab === 0 && <>
      <Banner tone="info">本表为<b>现行生效口径</b>（各维度显示其生效 source_version：历史出数快照或 ruleset_vN）。评分标准的唯一变更通道=SM05 结构化草案→人工批准（同作者二次确认）→显式「生效」写为新版本 ruleset_vN（旁路直改一律 410 frozen_rules_not_writable）。生效不改写历史：score_snapshots/score_history/deduction_ledger/risk_snapshots 为各时点口径离线所算、不回算不重算；重新出数由算法侧执行。<a className="meta" href="#/sm-drafts" style={{ marginLeft: 6 }}>去 SM05 提案/批准/生效 ↗</a></Banner>
      <ResourceTable resource="admin.evaluation_rules" labels={{ dimension: "维度码", dimension_name: "维度名", weight: "权重(frozen)", window_days: "窗口(天)", score_method: "评分方法", editable: "可编辑", source_version: "来源版本" }} />
      <p className="login-note">六维权重合计以冻结文件为准；本页仅展示，不做归一化。</p>
    </>}
    {tab === 1 && <OpConfigPanel />}
  </div>;
}

function SmAudit() {
  const [tick, setTick] = useState(0);
  return <div key={tick}>
    <PageHead code="SM04" title="数据版本与审计" desc="快照版本、导入运行台账、校验（概率一致性/评分对账/主键检查）与按操作者/对象/日期的操作日志。" />
    <ImportPanel onCommitted={() => setTick((v) => v + 1)} />
    
    <h3 style={{ fontSize: 14, margin: "6px 0" }}>导入运行台账（import_runs）</h3>
    <ResourceTable resource="admin.import_runs" labels={{ run_id: "run_id", filename: "文件", target_table: "目标表", source_version: "版本口径", check_status: "预检", row_total: "行数", accepted_count: "接受", rejected_count: "拒绝", dup_pk_count: "重复主键", type_error_count: "类型错误", unknown_columns: "未知列", actor_id: "操作者", created_at: "预检时间", committed_at: "写入时间", created_audit_id: "预检审计ID", commit_audit_id: "提交审计ID" }} />
    <h3 style={{ fontSize: 14, margin: "6px 0" }}>操作审计（服务端筛选/分页/CSV 导出；不显示口令、完整问答或越权目标详情）</h3>
    <AuditConsole />
  </div>;
}

function TrCreate() {
  const [courses, setCourses] = useState<Record<string, unknown>[]>([]);
  const [alerts, setAlerts] = useState<Record<string, unknown>[]>([]);
  const [driver, setDriver] = useState("");
  const [course, setCourse] = useState("DEMO_C01");
  const [alertId, setAlertId] = useState<string>("");
  const [goal, setGoal] = useState("");
  const [due, setDue] = useState("2026-11-15");
  const [mand, setMand] = useState(false);
  const [mandTouched, setMandTouched] = useState(false);
  const [polInfo, setPolInfo] = useState<string | null>(null);
  const policyRef = useRef<Record<string, string> | null>(null);
  useEffect(() => { (async () => { try { const r = await getData<Record<string, unknown>>("admin.operation_config", { limit: 50 }); const row = r.rows.find((x) => String(x.config_id) === "training_mandate_policy"); if (row) { policyRef.current = JSON.parse(String(row.value)); } } catch {} })(); }, []);
  useEffect(() => { (async () => { setPolInfo(null); const pol = policyRef.current; if (!pol || !driver.trim()) return;
    try { const r = await getData<Record<string, unknown>>("admin.score_snapshots", { driver_id: driver.trim(), limit: 1 }); const lvl = String(r.rows[0]?.risk_level || ""); const want = lvl ? String(pol[lvl] || "") : "";
      if (want === "mandatory" || want === "optional") { if (!mandTouched) setMand(want === "mandatory"); setPolInfo(`等级 ${lvl} 映射=${want === "mandatory" ? "强制" : "非强制"}，已按现行映射预填（可显式改判；不改则服务端按同一映射定值并留痕）`); }
      else setPolInfo(lvl ? `等级 ${lvl} 未配置映射：缺省非强制` : null);
    } catch {} })(); }, [driver, mandTouched]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tplRef, setTplRef] = useState<string | null>(null);
  const [aiFill, setAiFill] = useState<string | null>(null);
  useEffect(() => {
    const take = () => { try { const raw = sessionStorage.getItem("claw_fill"); if (!raw) return; const ft = JSON.parse(raw); if (ft.form !== "tr2") return;
      if (ft.driver_id) setDriver(String(ft.driver_id)); if (ft.course_id) setCourse(String(ft.course_id));
      const gc = (ft.goal_candidates || [])[0]; if (gc && !course) setCourse(String(gc));
      if (ft.due_at) setDue(String(ft.due_at)); setMand(Boolean(ft.mandatory)); if (ft.alert_id) setAlertId(String(ft.alert_id));
      if (ft.goal) setGoal(String(ft.goal)); else if (ft.note) setGoal(""); sessionStorage.removeItem("claw_fill"); setAiFill("已填入 AI 草稿（全部可改）；确认分配前不写 training_tasks；未审核课程将被服务端 409 拒绝"); } catch {} };
    take(); window.addEventListener("claw:fill", take); return () => window.removeEventListener("claw:fill", take);
  }, []);
  useEffect(() => { Promise.all([getData<Record<string, unknown>>("admin.training_courses", { limit: 20 }), getData<Record<string, unknown>>("admin.alerts", { limit: 50 })]).then(([c, a]) => { setCourses(c.rows); setAlerts(a.rows.filter((x) => x.status !== "closed")); }).catch(() => {}); }, []);
  const approved = courses.filter((c) => c.content_status === "approved");
  async function submit() {
    setBusy(true); setMsg(null);
    try { const r = await trainingAssign({ course_id: course, driver_id: driver, goal: goal || `结合 ${driver} 已核实证据完成 ${course} 复盘`, ...(mandTouched ? { mandatory: mand } : {}), due_at: due, alert_id: alertId || undefined, template_ref: tplRef || undefined } as never);
      setMsg(`${r.idempotent_replay ? "已存在同一任务" : "分配成功"} task_id=${r.task_id} · 强制=${r.mandatory ? "是" : "否"}（来源 ${r.mandatory_source || "已有任务"}）${r.course_snapshot_saved ? ` · 已留存课程版本 ${r.course_version}` : ""} · ${notificationText(r.notification)}${r.idempotent_replay ? " · 未重复创建任务" : ""}`); }
      catch (e) { const c2 = e instanceof ApiError ? e.code : "network"; setMsg({ course_not_approved: "服务端拒绝：课程处于待审核演示草稿——安全管理员团队人工审核通过前不得正式分配（training_tasks 不新增）", driver_binding_unverified: "服务端拒绝：目标司机绑定未核实", evidence_driver_mismatch: "服务端拒绝：所选告警证据与该司机不匹配", evidence_alert_not_found: "服务端拒绝：告警不存在", learning_migration_required: "学习扩展尚未迁移：请先执行008数据库迁移，再分配带版本留存的新任务。此次未创建任务。", assignment_idempotency_conflict: "请求标识已用于其他课程或司机，请核对任务来源。此次未创建任务。", template_unavailable: "通知模板暂不可用，请重试或取消模板选择。此次未创建任务。", template_not_approved_or_disabled: "通知模板尚未批准或已停用。此次未创建任务。" }[c2] || `拒绝：${c2}`); }
    setBusy(false);
  }
  return <div>
    <PageHead code="TR02" title="创建培训（分配受审核门禁）" desc="表单强制顺序：已审核课程 → 关联真实证据（本车队告警）→ 目标/强制性/截止 → 安全员页面确认分配。低可信度且行为证据不足时应优先设备核验而非惩罚培训。" />
    <div className="panel stack">
      <div className="field"><label>目标司机</label><input value={driver} onChange={(e) => setDriver(e.target.value)} /></div>
      <div className="field"><label>从告警关联证据（可选，须与司机匹配）</label>
        <select className="btn" style={{ background: "#fff", textAlign: "left" }} aria-label="关联告警" value={alertId} onChange={(e) => setAlertId(e.target.value)}><option value="">不关联</option>{alerts.map((a) => <option key={String(a.alert_id)} value={String(a.alert_id)}>{String(a.gpsno)} · {String(a.rule_code)} · {String(a.status)}</option>)}</select></div>
      <div className="field"><label>课程（approved 才允许正式分配）</label>
        <select className="btn" style={{ background: "#fff", textAlign: "left" }} value={course} onChange={(e) => setCourse(e.target.value)}>{(approved.length ? approved.map((c) => <option key={String(c.course_id)}>{String(c.course_id)}</option>) : courses.map((c) => <option key={String(c.course_id)}>{String(c.course_id)}（{String(c.content_status)}）</option>))}</select>
        <span className="login-note">当前已审核课程：{approved.length} / {courses.length}——{approved.length === 0 ? "全部仍为演示草稿待团队审核（需 TR05 人工批准后才能在 TR02 选择）" : ""}</span></div>
      <div className="field"><label>学习目标</label><input value={goal} onChange={(e) => setGoal(e.target.value)} aria-label="学习目标" placeholder="结合已核实证据写可观察目标" /></div>
      <div className="field"><label>截止日（逾期将入展示分支）</label><input value={due} onChange={(e) => setDue(e.target.value)} aria-label="截止日期" type="date" /></div>
      <label className="row" style={{ fontSize: 13 }}><input type="checkbox" checked={mand} onChange={(e) => { setMand(e.target.checked); setMandTouched(true); }} /> 强制培训（按 SM03「风险等级→强制性映射」自动预填；显式改动=人工改判将被记录。AI 不得自动设为强制）</label>
      {polInfo && <div className="meta" style={{ color: "#8059a0" }}>{polInfo}</div>}
      {aiFill && <div className="alert info">{aiFill}</div>}
      <TemplateScenePicker scene="task_assigned" driverId={driver} onPick={(r) => setTplRef(r)} label="分配通知模板（可选，仅 approved；选择/预览不写库）" />
      <div className="row"><span className="tag blue" style={{ fontSize: 12 }}>草稿状态，未分配</span><button className="btn primary" style={{ width: "auto" }} disabled={busy} onClick={submit}>确认分配</button></div>
      {msg && <div className="alert warn">{msg}</div>}
      
    </div>
  </div>;
}

// SM01：挂载完整账号管理面板（组件与 manage.accounts 门禁复用第2/13轮后端，未重建账号体系）
function SmDrafts() { return <SmDraftsPage />; }
function SmKnowledge() {
  const [tab, setTab] = useState<"knowledge" | "templates">(() => new URLSearchParams(location.hash.split("?")[1]).get("tab") === "templates" ? "templates" : "knowledge");
  return <div>
    <div className="row" style={{ gap: 6, margin: "4px 0 8px" }}>
      <button className="btn" style={tab === "knowledge" ? { borderColor: "var(--navy)", color: "var(--navy)" } : undefined} onClick={() => setTab("knowledge")}>知识条目（SM06）</button>
      <button className="btn" style={tab === "templates" ? { borderColor: "var(--navy)", color: "var(--navy)" } : undefined} onClick={() => setTab("templates")} aria-label="通知模板标签">通知模板（第三类内容）</button>
      <a className="meta" href="#/tr-courses" style={{ marginLeft: 8 }}>课程审核在 TR05 ↗（同门禁）</a>
    </div>
    {tab === "knowledge" ? <SmKnowledgePage /> : <TemplatesTab />}
  </div>;
}

export function AdminShell({ user, aiOpen, onAiToggle }: { user: MeUser; aiOpen: boolean; onAiToggle: () => void }) {
  const [routeKey, setRouteKey] = useState(() => location.hash);
  const route = (routeKey.replace(/^#\/?/, "") || "overview").split("?")[0];
  useEffect(() => {
    const onHash = () => setRouteKey(location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const view = useMemo(() => {
    switch (route) {
      case "ev-fleet": return <EvFleet />;
      case "daily-reports": return <AdminDailyReportPanel localOnly={Boolean(user.localSourceOnly)} />;
      case "ev-week": return <EvWeek />;
      case "ev-driver": return <EvFleet />; // 详情需从列表行进入
      case "ev-review": return <EvReview />;
      case "ev-root": return <RootCausesPage />;
      case "rm-queue": return <RmQueue />;
      case "rm-replay": return <RmReplay />;
      case "rm-alerts": { const m = location.hash.match(/[?&]alert_id=([^&#]+)/); return <RmAlerts initialAlertId={m ? decodeURIComponent(m[1]) : null} />; }
      case "tr-ledger": return <TrLedger />;
      case "tr-courses": return <TrCourses localOnly={Boolean(user.localSourceOnly)} />;
      case "tr-create": return <TrCreate />;
      case "sm-accounts": return <SmAccounts />;
      case "sm-bindings": return <SmBindings />;
      case "sm-config": return <SmConfig />;
      case "ai-preplan": return <AiPreplanPage />;
      case "sm-audit": return <SmAudit />;
      case "sm-drafts": return <SmDrafts />;
      case "sm-knowledge": return <SmKnowledge />;
      default: return <Dashboard />;
    }
  }, [routeKey]);
  return <div className="admin-shell">
    <header className="topbar">
      <a className="app-brand" href="#/overview"><span className="brand-symbol" aria-hidden="true">行</span><span>行安<span className="brand-caption">驾驶安全管理</span></span></a>
      <GlobalSearch />
      <span className="spacer" />
      <NotesChips />
      <span className="user"><span className="user-avatar" aria-hidden="true">{(user.displayName || user.username || "管").slice(0, 1)}</span><span><b>{user.displayName || user.username}</b><span className="user-role">{user.role === "safety_admin" ? "安全管理员" : user.role}</span></span><LogoutButton /></span>
    </header>
    <nav className="side" aria-label="主导航">
      {[{ index: 0, label: "数据总览", icon: 0 }, { index: 1, label: "车队管理", icon: 1 }, { index: 2, label: "风险监控", icon: 2 }, { index: 3, label: "培训管理", icon: 3 }].map(({ index, label, icon }) => {
        const active = NAV[index].items.some(it => it.key === route) || (index === 0 && !NAV.some(g => g.items.some(it => it.key === route)));
        return <a key={label} className={active ? "active" : ""} href={`#/${NAV[index].items[0].key}`} aria-current={active ? "page" : undefined}><NavIcon kind={icon} /><span>{label}</span></a>;
      })}
      {!user.localSourceOnly && <button className={aiOpen ? "active" : ""} onClick={onAiToggle} aria-pressed={aiOpen}><NavIcon kind={4} /><span>智能助手</span></button>}
      <a className={route.startsWith("sm-") ? "active" : ""} href="#/sm-accounts" aria-current={route.startsWith("sm-") ? "page" : undefined}><NavIcon kind={5} /><span>系统管理</span></a>
    </nav>
    <main className="main" key={routeKey}>
      {user.localSourceOnly && <Banner tone="warn">仅使用IE亮剑本地材料和历史回放。课程待团队审核；本地模式不提供专业测验或外部AI问答。</Banner>}
      {NAV.filter(g => g.items.length > 1 && g.items.some(it => it.key === route)).map(g => <nav className="module-tabs" aria-label={g.group} key={g.group}>{g.items.filter(it => it.key !== "ev-driver").map(it => <a key={it.key} href={`#/${it.key}`} aria-current={route === it.key ? "page" : undefined} className={route === it.key ? "active" : ""}>{it.label.replace("/数据异议", "")}</a>)}</nav>)}
      {view}
    </main>
  </div>;
}

function NotesChips() {
  const [s, setS] = useState<{ unread_notes: number; todo_count: number; todo_label: string } | null>(null);
  useEffect(() => { notesSummary().then(setS).catch(() => {}); const id = setInterval(() => notesSummary().then(setS).catch(() => {}), 60000); return () => clearInterval(id); }, []);
  return <>{s ? <><span className="chip" title="本人站内未读通知">消息 {s.unread_notes}</span><span className="chip" title={s.todo_label}>待办 {s.todo_count}</span></> : <><span className="chip">消息 —</span><span className="chip">待办 —</span></>}</>;
}
import { logout } from "./api";
export function onAppLogout() { try { const owner = sessionStorage.getItem("claw_ai_owner"); if (owner) sessionStorage.removeItem("claw_ai_msgs_" + owner); sessionStorage.removeItem("claw_ai_owner"); sessionStorage.removeItem("claw_fill"); sessionStorage.removeItem("claw_fill_seen"); } catch {} }
function LogoutButton() {
  return <button className="btn" style={{ background: "var(--navy-line)", color: "#fff", borderColor: "var(--navy-line)", padding: "4px 10px" }} onClick={async () => { await logout().catch(() => {}); onAppLogout(); location.reload(); }}>退出</button>;
}

