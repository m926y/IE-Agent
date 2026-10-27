// R18 SM01 账号管理：列表筛选 + 编辑抽屉 + 创建/停用/恢复（复用 manage.accounts 门禁；页面永不渲染口令）
import { useEffect, useState } from "react";
import { accountEdit, createUser, getData, setUserStatus } from "./api";

type Acct = Record<string, string | number | boolean | null>;

export function AccountAdminPanel({ onChanged }: { onChanged?: () => void }) {
  const [rows, setRows] = useState<Acct[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [fRole, setFRole] = useState(""); const [fStatus, setFStatus] = useState(""); const [fFleet, setFFleet] = useState("");
  const [editing, setEditing] = useState<Acct | null>(null);
  const [eDn, setEDn] = useState(""); const [eScope, setEScope] = useState(""); const [eDriver, setEDriver] = useState(""); const [eClear, setEClear] = useState(false);
  const [username, setUsername] = useState(""); const [role, setRole] = useState("driver"); const [dn, setDn] = useState("");
  async function reload() { try { setRows((await getData<Acct>("admin.accounts", { limit: 50 })).rows); onChanged?.(); } catch { setErr("账号列表读取失败"); } }
  useEffect(() => { reload(); }, []);
  const filtered = (rows || []).filter((r) => (!fRole || r.role === fRole) && (!fStatus || r.account_status === fStatus) && (!fFleet || String(r.fleet_scope || "").toLowerCase().includes(fFleet.toLowerCase())));
  function openEdit(a: Acct) { setEditing(a); setEDn(String(a.display_name || "")); setEScope(String(a.fleet_scope || "*")); setEDriver(String(a.driver_id || "")); setEClear(false); setErr(null); }
  async function saveEdit() {
    if (!editing) return;
    const b: Record<string, unknown> = {};
    if (String(editing.display_name || "") !== eDn) b.display_name = eDn;
    if (String(editing.fleet_scope || "*") !== eScope) b.fleet_scope = eScope;
    if (eClear) b.clear_binding = true; else if (String(editing.driver_id || "") !== eDriver) b.driver_id = eDriver;
    if (!Object.keys(b).length) { setMsg("无字段变化"); return; }
    try { const r = await accountEdit(String(editing.user_id), b); setMsg(`已更新 ${editing.user_id} · ${JSON.stringify(r.changed)} · 审计 ${r.audit_id}`); setEditing(null); await reload(); }
    catch (e) { setErr("编辑被拒：" + (e instanceof Error ? e.message : "?")); }
  }
  async function status(a: Acct, next: string) {
    try { const r = await setUserStatus(String(a.user_id), next); setMsg(`${a.user_id} ${a.account_status} → ${r.account_status} · 审计 ${r.audit_id} · ${r.note || ""}`); await reload(); }
    catch (e) { setErr("状态操作被拒：" + (e instanceof Error ? e.message : "?")); }
  }
  return <div>
    {err && <div className="alert warn">{err}</div>}
    {msg && <div className="alert info">{msg}</div>}
    <div className="task-card" style={{ padding: 8, marginBottom: 8 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <select className="btn" style={{ width: "auto" }} value={fRole} onChange={(e) => { setFRole(e.target.value); }} aria-label="筛选角色"><option value="">角色·全部</option><option value="safety_admin">safety_admin</option><option value="team_leader">team_leader</option><option value="driver">driver</option></select>
        <select className="btn" style={{ width: "auto" }} value={fStatus} onChange={(e) => setFStatus(e.target.value)} aria-label="筛选状态"><option value="">状态·全部</option><option value="active">active</option><option value="disabled">disabled</option></select>
        <input className="btn" style={{ width: 150 }} placeholder="车队筛选（fleet_scope）" value={fFleet} onChange={(e) => setFFleet(e.target.value)} aria-label="车队筛选" />
        <span className="meta">列表按你（当前管理员）的 fleet_scope 过滤 · {filtered.length}/{(rows || []).length}{rows ? "" : " 加载中…"}</span>
      </div>
    </div>
    <table className="tbl"><thead><tr><th>平台用户 / 显示名</th><th>角色</th><th>状态</th><th>已核实 driver_id</th><th>fleet_scope</th><th>更新</th><th>操作</th></tr></thead>
      <tbody>{filtered.map((a) => <tr key={String(a.user_id)}>
        <td><b>{String(a.username)}</b><div className="meta">{String(a.user_id)} · {String(a.display_name || "—")}</div></td>
        <td>{String(a.role)}</td>
        <td><span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 6, ...(a.account_status === "active" ? { background: "#e6f4ea", color: "#1a6b2a" } : { background: "#fdecaa", color: "#8a2b0b" }) }}>{String(a.account_status)}</span></td>
        <td>{a.driver_id ? `${String(a.driver_id)}${a.binding_verified ? "" : " (未核实)"}` : "—"}</td>
        <td>{String(a.fleet_scope || "—")}</td>
        <td className="meta">{String(a.updated_at || "").slice(0, 16)}</td>
        <td style={{ whiteSpace: "nowrap" }}>
          <button className="btn" style={{ padding: "2px 8px" }} onClick={() => openEdit(a)}>编辑</button>{" "}
          {a.account_status === "active" ? <button className="btn" style={{ padding: "2px 8px" }} onClick={() => status(a, "disabled")}>停用</button> : <button className="btn" style={{ padding: "2px 8px" }} onClick={() => status(a, "active")}>恢复</button>}
        </td>
      </tr>)}</tbody></table>
    {editing && <div className="task-card" style={{ marginTop: 8, outline: "2px solid #1a56c4" }}>
      <div className="t">编辑抽屉 · {String(editing.user_id)}</div>
      <div style={{ display: "grid", gap: 6, gridTemplateColumns: "1fr 1fr", alignItems: "end" }}>
        <label>显示名<input className="btn" style={{ width: "100%" }} value={eDn} onChange={(e) => setEDn(e.target.value)} /></label>
        <label>fleet_scope（* 或精确车队ID）<input className="btn" style={{ width: "100%" }} value={eScope} onChange={(e) => setEScope(e.target.value)} aria-label="车队范围" /></label>
        <label>司机绑定<div style={{ display: "flex", gap: 6 }}>
          <select className="btn" style={{ flex: 1 }} disabled={eClear || !editing.binding_verified} value={eDriver} onChange={(e) => setEDriver(e.target.value)} aria-label="司机绑定">
            <option value="">（不变更/空）</option>
            {(rows || []).filter((x) => x.role === "driver" && x.user_id !== editing.user_id && x.driver_id).map((x) => <option key={String(x.user_id)}>{String(x.driver_id)}</option>)}
          </select>
          <label className="meta" style={{ alignSelf: "center" }}><input type="checkbox" checked={eClear} onChange={(e) => setEClear(e.target.checked)} /> 清除绑定</label>
        </div>
        <div className="meta">{editing.binding_verified ? "身份已核实" : "请先核实身份绑定"}</div></label>
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <button className="btn primary" style={{ width: "auto" }} onClick={saveEdit}>保存编辑</button>
        <button className="btn" onClick={() => setEditing(null)}>取消</button>
      </div>
      <p className="login-note">编辑不落任何口令字段；被停用账号即时清除会话（旧 Cookie 立即 401）。</p>
    </div>}
    <div className="task-card" style={{ marginTop: 10, padding: 8 }}>
      <div className="t">创建账号</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <input className="btn" style={{ width: 170 }} value={username} onChange={(e) => setUsername(e.target.value.replace(/[^a-z0-9_.-]/g, ""))} placeholder="登录名(小写)" aria-label="新账号登录名" />
        <input className="btn" style={{ width: 150 }} value={dn} onChange={(e) => setDn(e.target.value)} placeholder="显示名" />
        <select className="btn" style={{ width: "auto" }} value={role} onChange={(e) => setRole(e.target.value)} aria-label="新账号角色"><option value="driver">driver</option><option value="safety_admin">safety_admin</option></select>
        <button className="btn primary" style={{ width: "auto" }} onClick={async () => { try { const r = await createUser({ username, display_name: dn || "临时账号", role }); setMsg(`已创建 ${r.user_id}（${r.username}/${r.role}）· 审计 ${r.audit_id} · 初始口令不显示、不记录于页面（仅 API 一次性返回）`); setUsername(`temp_${Date.now() % 100000}`); await reload(); } catch (e) { setErr("创建被拒：" + (e instanceof Error ? e.message : "?")); } }}>创建</button>
      </div>
      <p className="login-note">仅两类登录身份（safety_admin / driver），不设第三种管理员登录；username 唯一（重复 409）。未核实身份不可自动绑定演示司机；有效绑定唯一。</p>
    </div>
  </div>;
}

