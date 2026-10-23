// R17 SM05 规则草案双栏 + SM06 知识内容管理（服务端强制门禁；草案/待审永不成为正式依据）
import React, { useEffect, useState } from "react";
import { knowledgeAction, knowledgeCreate, knowledgeList, ruleDraftAction, ruleDraftCreate, rulesBoard } from "./api";


const DIMS = ["history", "driving_stability", "fatigue_distraction", "management", "imu_evidence", "gps_coverage"];
type Row = Record<string, string | number | boolean | null | undefined>;
function PageHead({ code, title, desc }: { code: string; title: string; desc: string }) {
  return <div style={{ marginBottom: 10 }}><div className="meta">{code}</div><h2 style={{ margin: "2px 0 4px" }}>{title}</h2><p className="meta">{desc}</p></div>;
}

function StatusTag({ s }: { s: string }) {
  const map: Record<string, [string, React.CSSProperties]> = {
    draft: ["草案·未生效", { background: "#f0f0f0", color: "#555", border: "1px solid #ccc" }],
    pending_review: ["待审·未生效", { background: "#fff7e6", color: "#ad6800", border: "1px solid #ffd591" }],
    archived: ["已归档", { background: "#eee", color: "#888", border: "1px solid #ddd" }],
    approved: ["正式生效", { background: "#e6f4ea", color: "#1a6b2a", border: "1px solid #b7e0c0" }],
    disabled: ["已停用", { background: "#fdecaa", color: "#8a2b0b", border: "1px solid #f5c0c0" }],
  };
  const [txt, style] = map[s] || [s, {}];
  return <span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 6, ...style }}>{txt}</span>;
}

export function SmDraftsPage() {
  const [board, setBoard] = useState<{ current: Row[]; drafts: Row[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [dim, setDim] = useState(DIMS[0]);
  const [prop, setProp] = useState("");
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [noteTxt, setNoteTxt] = useState("");
  async function reload() { try { setBoard((await rulesBoard()) as { current: Row[]; drafts: Row[] }); setErr(null); } catch { setErr("读取失败：规则板不可用"); } }
  useEffect(() => { reload(); }, []);
  async function act(id: string, b: Row) { try { const r = await ruleDraftAction(id, b); setMsg(`${id} → ${r.new_status} · 审计 ${r.audit_id}`); await reload(); } catch (e) { setErr(e instanceof Error ? e.message : "操作被拒（状态机或权限）"); } }
  return <div>
    <PageHead code="SM05" title="评分口径：现行（只读冻结）与草案（未生效）" desc="现行权重直读 evaluation_rules（editable=false，source_version=冻结快照）；evaluation_rule_drafts 仅承载提案文本。任何页面/接口/AI 工具都不会把草案当现行参数；新算法版本须走独立验证与重新出数流程。" />
    {err && <div className="alert warn">{err}</div>}
    {msg && <div className="alert info">{msg}</div>}
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, alignItems: "start" }}>
      <div className="task-card"><div className="t">现行口径（只读 · 冻结，6 维）</div>
        {!board ? <div className="meta">读取中…</div> : <table className="tbl"><thead><tr><th>维度</th><th>权重</th><th>窗口</th><th>source_version</th></tr></thead>
          <tbody>{board.current.map((c) => <tr key={String(c.dimension)}><td>{String(c.dimension_name || c.dimension)}</td><td>{Number(c.weight).toFixed(4)}</td><td>{String(c.window_days)}天</td><td><span className="meta">{String(c.source_version)}</span></td></tr>)}</tbody></table>}
        <div className="meta">对 risk/score/ledger/evaluation_rules 的写回：本应用无路径（410 frozen_rules_not_writable）</div></div>
      <div className="task-card"><div className="t">规则草案（永不生效）</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
          <select className="btn" value={dim} onChange={(e) => setDim(e.target.value)} style={{ width: "auto" }}>{DIMS.map((d) => <option key={d}>{d}</option>)}</select>
          <button className="btn" disabled={!prop.trim()} onClick={async () => { try { const r = await ruleDraftCreate({ dimension: dim, proposal: prop }); setMsg(`已建草案 ${r.draft_id} · 审计 ${r.audit_id}`); setProp(""); await reload(); } catch (e) { setErr(e instanceof Error ? e.message : "创建失败"); } }}>创建草案</button>
        </div>
        <textarea className="btn" style={{ width: "100%", minHeight: 56, textAlign: "left", fontFamily: "inherit" }} placeholder="提案文本（拟议口径/理由/影响评估）——仅记录，不参与计算" value={prop} onChange={(e) => setProp(e.target.value)} />
        {!board ? <div className="meta">读取中…</div> : board.drafts.length === 0 ? <div className="meta">暂无草案</div> : board.drafts.map((d) => <div key={String(d.draft_id)} className="task-card" style={{ padding: 8, marginTop: 6 }}>
          <div style={{ fontSize: 12.5 }}><b>{String(d.draft_id)}</b> · {String(d.dimension)} <StatusTag s={String(d.status)} /></div>
          <div className="meta" style={{ whiteSpace: "pre-wrap" }}>{String(d.proposal || "").slice(0, 300)}</div>
          <div className="meta">基线 {String(d.base_version || "—")} · {String(d.created_by)} · {String(d.updated_at || "").slice(0, 10)}{d.review_note ? ` · 意见：${String(d.review_note).slice(0, 60)}` : ""}</div>
          <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
            {d.status === "draft" && <button className="btn" style={{ padding: "2px 8px" }} onClick={() => act(String(d.draft_id), { action: "submit" })}>提交审核</button>}
            {d.status === "pending_review" && <button className="btn" style={{ padding: "2px 8px" }} onClick={() => act(String(d.draft_id), { action: "withdraw" })}>撤回为草案</button>}
            {d.status !== "archived" && <button className="btn" style={{ padding: "2px 8px" }} onClick={() => act(String(d.draft_id), { action: "archive" })}>归档</button>}
            <button className="btn" style={{ padding: "2px 8px" }} onClick={() => setNoteFor(noteFor === String(d.draft_id) ? null : String(d.draft_id))}>审阅意见</button>
          </div>
          {noteFor === String(d.draft_id) && <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <input className="btn" style={{ flex: 1, width: "auto" }} value={noteTxt} onChange={(e) => setNoteTxt(e.target.value)} placeholder="审阅意见（留痕可追溯）" />
            <button className="btn primary" style={{ padding: "2px 8px", width: "auto" }} onClick={() => { act(String(d.draft_id), { action: "note", review_note: noteTxt }); setNoteTxt(""); }}>保存意见</button>
          </div>}
        </div>)}
      </div>
    </div>
    <p className="login-note">全部草案动作写 audit_logs（rule_draft.create/submit/withdraw/note/archive），本页无“启用/生效”按钮。</p>
  </div>;
}

export function SmKnowledgePage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [title, setTitle] = useState(""); const [content, setContent] = useState(""); const [snote, setSnote] = useState(""); const [role, setRole] = useState("all");
  const [editFor, setEditFor] = useState<string | null>(null); const [editTxt, setEditTxt] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const hl = (location.hash.split("article_id=")[1] || "").split("&")[0];
  async function reload() { try { setRows((await knowledgeList()).rows as Row[]); setErr(null); } catch { setErr("知识清单读取失败"); } }
  useEffect(() => { reload(); }, []);
  async function act(id: string, b: Row, label: string) {
    try { const r = await knowledgeAction(id, b); setMsg(`${label}：${id} → ${r.new_status ?? r.version_no ?? "ok"} · 审计 ${r.audit_id}${r.self_review_confirmed ? "（同作者二次确认已留痕）" : ""}`); setErr(null); await reload(); }
    catch (e) { const m = e instanceof Error ? e.message : String(e); if (m.includes("self_review_requires_explicit_confirm")) { setConfirmId(id); setErr("你是该条目作者：请点“确认并批准”完成同作者二次确认（将写入审计）"); } else setErr("操作被拒：" + m); }
  }
  return <div>
    <PageHead code="SM06" title="知识内容管理（draft → pending_review → approved → disabled）" desc="全部转换由服务端校验并写审计（含版本坐标 article_id:version_no）；同作者审阅必须显式二次确认。运行时 AI 正式引用 = 仅 approved 的最新版本（含版本核验，停用/待审拒绝）。" />
    {err && <div className="alert warn">{err}</div>}
    {msg && <div className="alert info">{msg}</div>}
    <div className="task-card"><div className="t">新建知识条目（起草即 draft，不会自动批准）</div>
      <input className="btn" style={{ width: "100%" }} placeholder="标题" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea className="btn" style={{ width: "100%", minHeight: 52, textAlign: "left", fontFamily: "inherit", marginTop: 4 }} placeholder="正文（Markdown 纯文本均可）" value={content} onChange={(e) => setContent(e.target.value)} />
      <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
        <input className="btn" style={{ flex: 1, width: "auto" }} placeholder="source_note（来源说明/依据）" value={snote} onChange={(e) => setSnote(e.target.value)} />
        <select className="btn" style={{ width: "auto" }} value={role} onChange={(e) => setRole(e.target.value)}><option value="all">all</option><option value="driver">driver</option><option value="safety_admin">safety_admin</option></select>
        <button className="btn primary" style={{ width: "auto" }} disabled={!title.trim() || !content.trim()} onClick={async () => { try { const r = await knowledgeCreate({ title, content, source_note: snote, applicable_role: role }); setMsg(`已建 ${r.article_id} v${r.version_no}（draft）· 审计 ${r.audit_id}`); setTitle(""); setContent(""); setSnote(""); await reload(); } catch (e) { setErr(e instanceof Error ? e.message : "创建失败"); } }}>创建草稿</button>
      </div></div>
    {!rows ? <div className="meta">读取中…</div> : rows.map((r) => <div key={`${r.article_id}:${r.version_no}`} className="task-card" style={{ padding: 8, marginTop: 6, outline: hl === String(r.article_id) ? "2px solid #1a56c4" : "none" }}>
      <div style={{ fontSize: 12.5 }}><b>{String(r.article_id)} · v{String(r.version_no)}</b> {r.is_latest ? null : <span className="meta">（历史版本，仅追溯）</span>} <StatusTag s={String(r.review_status)} /> {r.officially_referenceable ? <span style={{ fontSize: 11, color: "#1a6b2a" }}>· AI 可正式引用</span> : null}</div>
      <div className="t" style={{ fontSize: 13 }}>{String(r.title)}</div>
      <div className="meta">维度 {String(r.dimension || "—")} · 适用 {String(r.applicable_role || "all")} · 来源 {String(r.source_note || "—")} · 作者 {String(r.created_by)} · {r.reviewed_by ? `审核 ${String(r.reviewed_by)} @${String(r.reviewed_at || "").slice(0, 16)}` : "未审"}</div>
      {r.content ? <div className="meta" style={{ whiteSpace: "pre-wrap" }}>{String(r.content).slice(0, 240)}{(String(r.content).length > 240 ? "…" : "")}</div> : null}
      {r.is_latest ? <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
        {r.review_status === "draft" && <>
          {editFor === `${r.article_id}` ? <div style={{ display: "flex", gap: 6, width: "100%" }}><input className="btn" style={{ flex: 1, width: "auto" }} value={editTxt} onChange={(e) => setEditTxt(e.target.value)} placeholder="修订正文" /><button className="btn primary" style={{ width: "auto" }} onClick={() => { act(String(r.article_id), { action: "edit", content: editTxt }, "修订"); setEditFor(null); }}>存修订</button></div>
            : <button className="btn" style={{ padding: "2px 8px" }} onClick={() => { setEditFor(String(r.article_id)); setEditTxt(String(r.content || "")); }}>编辑</button>}
          <button className="btn" style={{ padding: "2px 8px" }} onClick={() => act(String(r.article_id), { action: "submit" }, "提交审核")}>提交审核</button></>}
        {r.review_status === "pending_review" && <>
          <button className="btn" style={{ padding: "2px 8px" }} onClick={() => act(String(r.article_id), { action: "withdraw" }, "退回")}>退回草案</button>
          {confirmId === String(r.article_id)
            ? <button className="btn primary" style={{ padding: "2px 8px", width: "auto", background: "#8a2b0b", borderColor: "#8a2b0b" }} onClick={() => act(String(r.article_id), { action: "approve", confirm_same_actor: true }, "同作者批准")}>确认并批准（同作者留痕）</button>
            : <button className="btn primary" style={{ padding: "2px 8px", width: "auto" }} onClick={() => act(String(r.article_id), { action: "approve" }, "审核通过")}>审核通过</button>}</>}
        {r.review_status === "approved" && <>
          <button className="btn" style={{ padding: "2px 8px" }} onClick={() => act(String(r.article_id), { action: "disable" }, "停用")}>停用</button>
          <button className="btn" style={{ padding: "2px 8px" }} onClick={() => act(String(r.article_id), { action: "new_version", content: String(r.content) }, "建新版本(基于当前)")}>新版本</button></>}
      </div> : null}
    </div>)}
    <p className="login-note">状态机：draft→pending_review→approved→disabled（服务端校验 + 409 拒非法转移）；approved 后改内容=新版本（旧版留档可追溯）；AI/evidence-check 引用带版本号，停用后即时失效。</p>
  </div>;
}
