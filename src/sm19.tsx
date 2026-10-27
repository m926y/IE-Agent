// R19：TR05 课程库/审核面板（复用 course-review 状态机 + 新 course-draft） + SM04 审计控制台（服务端筛选/分页/导出）
import { useCallback, useEffect, useState } from "react";
import { auditQuery, courseCreate, courseDraftEdit, coursesBoard, courseReview, opsSet } from "./api";

type Course = Record<string, unknown> & { course_id: string; review_trail?: Record<string, unknown>[] };
type AudRow = Record<string, string | null>;

const STY: Record<string, [string, React.CSSProperties]> = {
  approved: ["已审核·可分配", { background: "#e6f4ea", color: "#1a6b2a", border: "1px solid #b7e0c0" }],
  pending_review: ["待审·不可分配", { background: "#fff7e6", color: "#ad6800", border: "1px solid #ffd591" }],
  demo_draft_requires_team_review: ["待审核", { background: "#fff7e6", color: "#ad6800", border: "1px solid #ffd591" }],
  draft: ["草稿·未生效", { background: "#f0f0f0", color: "#555", border: "1px solid #ccc" }],
  disabled: ["已停用", { background: "#fdecaa", color: "#8a2b0b", border: "1px solid #f5c0c0" }],
};
const Tag2 = ({ s }: { s: string }) => { const [t, st] = STY[s] || [s, {}]; return <span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 6, ...st }}>{t}</span>; };

export function CourseBoard() {
  const [rows, setRows] = useState<Course[] | null>(null);
  const [open, setOpen] = useState<Course | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [fStatus, setFStatus] = useState("");
  const [showTrail, setShowTrail] = useState<string | null>(null);
  const [nc, setNc] = useState({ course_id: "", title: "", dimension: "", content: "" });
  const [editFor, setEditFor] = useState<Course | null>(null);
  async function reload(pick?: string) { const r = await coursesBoard(); setRows(r.courses as Course[]); if (pick) setOpen((r.courses as Course[]).find(x => x.course_id === pick) || null); }
  useEffect(() => { reload().catch(() => setErr("课程板读取失败")); }, []);
  async function review(c: Course, next: string, confirm = false) {
    setErr(null);
    try { const r = await courseReview({ course_id: c.course_id, new_status: next, ...(confirm ? { confirm_by: "manual_admin" } : {}) }); setMsg(`${c.course_id} ${r.old_status} → ${r.new_status} · v${r.version_no} · 审计 ${r.audit_id}`); await reload(c.course_id); }
    catch (e) { setErr("审核动作被拒：" + String((e as { code?: string }).code || e)); }
  }
  const list = (rows || []).filter(x => !fStatus || String(x.content_status) === fStatus);
  return <div>
    {msg && <div className="alert info">{msg}</div>}
    {err && <div className="alert warn">{err}</div>}
    <div style={{ display: "flex", gap: 6, margin: "4px 0", flexWrap: "wrap" }}>
      <select className="btn" style={{ width: "auto" }} value={fStatus} onChange={(e) => setFStatus(e.target.value)} aria-label="课程状态筛选"><option value="">状态·全部</option>{Object.keys(STY).map(s => <option key={s}>{s}</option>)}</select>
      <span className="meta" style={{ alignSelf: "center" }}>{list.length}/{(rows || []).length}</span>
    </div>
    {!rows ? <div className="meta">读取中…</div> : <table className="tbl"><thead><tr><th>课程 / 标题</th><th>维度</th><th>状态</th><th>版本</th><th>作者</th><th>审核人 · 时间</th><th>操作</th></tr></thead>
      <tbody>{list.map(c => <tr key={c.course_id} style={{ outline: open?.course_id === c.course_id ? "2px solid #1a56c4" : "none" }}>
        <td><b>{c.course_id}</b> {String(c.title)}<div className="meta">{String((c.content as string) || "").slice(0, 60)}…</div></td>
        <td>{String(c.dimension || "—")}</td><td><Tag2 s={String(c.content_status)} /></td><td>v{String(c.version_no)}</td>
        <td className="meta">{String(c.authored_by || "—")}<div>{String(c.authored_at || "").slice(0, 10)}</div></td>
        <td className="meta">{c.reviewed_by ? `${String(c.reviewed_by)}` : "—"}<div>{String(c.reviewed_at || "").slice(0, 16)}</div></td>
        <td style={{ whiteSpace: "nowrap" }}>
          <button className="btn" style={{ padding: "2px 8px" }} onClick={() => { setOpen(c); setShowTrail(c.course_id); }}>审核 / 轨迹</button>
        </td>
      </tr>)}</tbody></table>}
    {open && <div className="task-card" style={{ marginTop: 8 }}>
      <div className="t">审核抽屉 · {open.course_id}（{String(open.title)}） <Tag2 s={String(open.content_status)} /> v{String(open.version_no)}</div>
      <div className="meta" style={{ whiteSpace: "pre-wrap", maxHeight: 120, overflowY: "auto" }}>{String(open.content)}</div>
      <div className="meta">完成要求：{String((open as { completion_requirement?: string }).completion_requirement || "—")} · source: {String((open as { source_version?: string }).source_version || "—")}</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
        {["demo_draft_requires_team_review", "draft"].includes(String(open.content_status)) && <button className="btn" onClick={() => review(open, "pending_review")}>提交审核</button>}
        {open.content_status === "pending_review" && <>
          <button className="btn" onClick={() => review(open, "draft")}>退回草稿</button>
          <button className="btn primary" style={{ width: "auto" }} onClick={() => { if (window.confirm(`确认以你的名义批准课程 ${open.course_id}？批准后方可被 TR02 正式分配（人工决定，不自动批准）。`)) review(open, "approved", true); }}>批准（明确确认）</button>
        </>}
        {open.content_status === "approved" && <button className="btn" onClick={() => { if (window.confirm(`停用 ${open.course_id}？此后 TR02 分配与 AI 引用将拒绝（文本与轨迹保留）。`)) review(open, "disabled", true); }}>停用（明确确认）</button>}
        {["draft", "pending_review", "demo_draft_requires_team_review"].includes(String(open.content_status)) && <button className="btn" onClick={() => setEditFor(open)}>修订文本</button>}
        <button className="btn" onClick={() => setOpen(null)}>收起</button>
      </div>
      {showTrail === open.course_id && <div style={{ marginTop: 6 }}>
        <div className="t" style={{ fontSize: 12.5 }}>审核轨迹（audit_logs 合成，可回看）</div>
        {(open.review_trail || []).slice().reverse().map((x) => <div key={String(x.audit_id)} className="meta" style={{ fontSize: 11.5 }}>
          {String(x.at || "").slice(0, 19)} · {String(x.action)} {x.from ? `${x.from}→${String(x.to)}` : ""} · {String(x.by)} · <a href={`#/sm-audit?audit_id=${String(x.audit_id)}`}>{String(x.audit_id)}</a>
        </div>)}
        {!(open.review_trail || []).length && <div className="meta">无审计事件</div>}
      </div>}
      {editFor && <div style={{ marginTop: 6, display: "grid", gap: 4 }}>
        <textarea className="btn" style={{ minHeight: 60, textAlign: "left", fontFamily: "inherit" }} defaultValue={String(editFor.content)} onChange={(e) => ((editFor as { _new?: string; })._new = e.target.value)} />
        <div style={{ display: "flex", gap: 6 }}>
          <button className="btn primary" style={{ width: "auto" }} onClick={async () => { try { const r = await courseDraftEdit({ course_id: editFor.course_id, content: (editFor as { _new?: string; })._new ?? String(editFor.content) }); setMsg(`已修订 ${r.course_id} → v${r.version_no} · 审计 ${r.audit_id}`); setEditFor(null); await reload(editFor.course_id); } catch (e) { setErr("修订被拒：" + String((e as { code?: string }).code || e)); } }}>保存修订（仅未审核课程）</button>
          <button className="btn" onClick={() => setEditFor(null)}>取消</button>
        </div>
        <div className="meta">已 approved 的课程修订走"停用 + 新课程"流程，避免静默改词。</div>
      </div>}
    </div>}
    <div className="task-card" style={{ marginTop: 8, padding: 8 }}>
      <div className="t">自建课程草稿（初始 draft，永不自动批准/分配）</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <input className="btn" style={{ width: 150 }} placeholder="course_id(大写)" value={nc.course_id} onChange={(e) => setNc({ ...nc, course_id: e.target.value.toUpperCase() })} aria-label="新课程ID" />
        <input className="btn" style={{ width: 200 }} placeholder="标题" value={nc.title} onChange={(e) => setNc({ ...nc, title: e.target.value })} aria-label="新课程标题" />
        <input className="btn" style={{ width: 130 }} placeholder="维度(可空)" value={nc.dimension} onChange={(e) => setNc({ ...nc, dimension: e.target.value })} />
      </div>
      <textarea className="btn" style={{ width: "100%", minHeight: 44, textAlign: "left", fontFamily: "inherit", marginTop: 4 }} placeholder="课程正文" value={nc.content} onChange={(e) => setNc({ ...nc, content: e.target.value })} aria-label="新课程正文" />
      <button className="btn primary" style={{ width: "auto", marginTop: 4 }} disabled={!nc.course_id || !nc.title || !nc.content} onClick={async () => { try { const r = await courseCreate(nc); setMsg(`已创建 ${r.course_id}（draft）· 审计 ${r.audit_id}`); setNc({ course_id: "", title: "", dimension: "", content: "" }); await reload(r.course_id); } catch (e) { setErr("创建被拒：" + String((e as { code?: string }).code || e)); } }}>创建草稿课程</button>
    </div>
  </div>;
}

const ACTION_PREFIXES = ["", "ai.chat", "ai.confirm", "account", "course", "knowledge", "rule_draft", "intervention", "alert", "training", "review", "import", "ops"];

export function AuditConsole() {
  const [q, setQ] = useState({ actor: "", entity_id: "", action_prefix: "", from: "", to: "" });
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ rows: AudRow[]; total: number } | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const limit = 25;
  const load = useCallback(async (p: number) => {
    setErr(null);
    try { const r = await auditQuery({ ...q, limit, offset: p * limit }); setData({ rows: r.rows as AudRow[], total: r.total as number }); }
    catch { setErr("审计查询失败（服务端过滤/分页）"); }
  }, [q]);
  useEffect(() => { load(0); setPage(0); }, [load]);
  const qs = () => new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();
  const pages = data ? Math.ceil(data.total / limit) : 0;
  return <div>
    <div className="task-card" style={{ padding: 8 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <input className="btn" style={{ width: 150 }} placeholder="操作者（user_id）" value={q.actor} onChange={(e) => setQ({ ...q, actor: e.target.value })} aria-label="审计-操作者" />
        <input className="btn" style={{ width: 190 }} placeholder="对象 ID（record_id）" value={q.entity_id} onChange={(e) => setQ({ ...q, entity_id: e.target.value })} aria-label="审计-对象ID" />
        <select className="btn" style={{ width: "auto" }} value={q.action_prefix} onChange={(e) => setQ({ ...q, action_prefix: e.target.value })} aria-label="审计-action前缀">
          <option value="">action 前缀·全部</option>{ACTION_PREFIXES.filter(Boolean).map(a => <option key={a}>{a}</option>)}
        </select>
        <input className="btn" style={{ width: 160 }} type="date" value={q.from} onChange={(e) => setQ({ ...q, from: e.target.value })} aria-label="审计-起" />
        <input className="btn" style={{ width: 160 }} type="date" value={q.to} onChange={(e) => setQ({ ...q, to: e.target.value })} aria-label="审计-止" />
        <a className="btn" style={{ alignSelf: "center" }} href={`/api/admin/audit?format=csv&limit=500&${qs()}`}>导出当前结果(CSV)</a>
        <button className="btn" onClick={() => load(page)}>刷新</button>
      </div>
      <div className="meta">{data ? `共 ${data.total} 条 · 第 ${page + 1}/${Math.max(pages, 1)} 页` : "查询中…"}</div>
    </div>
    {err && <div className="alert warn">{err}</div>}
    <table className="tbl"><thead><tr><th>audit_id / 时间</th><th>角色·操作者</th><th>动作</th><th>对象</th><th>状态变化</th><th>request_id</th></tr></thead>
      <tbody>{(data?.rows || []).map(r => <tr key={String(r.audit_id)}>
        <td><button className="btn" style={{ padding: "0 4px", fontSize: 11.5 }} onClick={async () => { try { const d = await fetch(`/api/admin/audit/${encodeURIComponent(String(r.audit_id))}`, { headers: {} , credentials:"include"}).then(x => x.json()); setDetail(d); } catch { setErr("详情读取失败"); } }}>{String(r.audit_id)}</button><div className="meta">{String(r.occurred_at || "").slice(0, 19)}</div></td>
        <td>{String(r.actor_role)}<div className="meta">{String(r.actor_id)}</div></td>
        <td><b>{String(r.action)}</b></td>
        <td>{String(r.entity_type)}<div className="meta">{String(r.entity_id).slice(0, 40)}</div></td>
        <td>{r.old_status ? `${r.old_status}→` : ""}{r.new_status ? String(r.new_status) : "—"}</td>
        <td className="meta">{String(r.request_id || "—")}</td>
      </tr>)}</tbody></table>
    <div style={{ display: "flex", gap: 8 }}><button className="btn" disabled={page === 0} onClick={() => { setPage(page - 1); load(page - 1); }}>上一页</button><button className="btn" disabled={page + 1 >= pages} onClick={() => { setPage(page + 1); load(page + 1); }}>下一页</button></div>
    {detail && <div className="task-card" style={{ marginTop: 6 }} key={JSON.stringify(detail).length}>
      <div className="t">审计详情 · {String((detail.audit as AudRow)?.audit_id)}</div>
      <pre style={{ fontSize: 11.5, whiteSpace: "pre-wrap", maxHeight: 200, overflowY: "auto" }}>{JSON.stringify({ audit: detail.audit, evidence_refs: detail.evidence_refs, detail_meta: detail.detail_meta, redaction_note: detail.redaction_note }, null, 1).slice(0, 1800)}</pre>
      <button className="btn" onClick={() => setDetail(null)}>关闭</button>
    </div>}
  </div>;
}

