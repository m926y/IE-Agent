// R23 SM02：当前/历史绑定双区 + 窗口编辑/冲突预览/重排/删除（复用 manage.bindings 门禁与 binding-* 端点）
import { useEffect, useState } from "react";
type Row = { binding_id: string; user_id: string; driver_id: string | null; account_status: string; identity_status: string | null; effective_start: string | null; effective_end: string | null; note: string | null; fleet_id: string | null };
const api = async <T,>(p: string, init?: RequestInit): Promise<T> => { const r = await fetch(p, { credentials: "include", headers: { "content-type": "application/json" }, ...init }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error((j as { error?: string }).error || "HTTP " + r.status); return j as T; };
export function BindingsConsole({ drivers }: { drivers: { driver_id: string; gpsno: string }[] }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [asOf, setAsOf] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<Row | null>(null);
  const [st, setSt] = useState(""); const [en, setEn] = useState("");
  const [nb, setNb] = useState({ user_id: "", driver_id: "", s: "", e: "", verified: true });
  async function reload() { setRows((await api<{ rows: Row[] }>(`/api/admin/bindings${asOf ? "?as_of=" + asOf : ""}`)).rows); }
  useEffect(() => { reload().catch(() => setErr("绑定列表读取失败")); }, [asOf]);
  const today = new Date().toISOString().slice(0, 10);
  const cur = (rows || []).filter((x) => x.account_status === "active");
  const hist = (rows || []).filter((x) => x.account_status !== "active");
  async function preview() { const before = await fetch("/api/admin/binding-conflicts?user_id=" + encodeURIComponent(edit ? edit.user_id : nb.user_id) + "&driver_id=" + encodeURIComponent(edit ? String(edit.driver_id) : nb.driver_id) + "&start=" + encodeURIComponent(edit ? st : nb.s) + "&end=" + encodeURIComponent(edit ? en : nb.e) + (edit ? "&exclude=" + edit.binding_id : ""), { credentials:"include" }).then((x)=>x.json()).catch(()=>null); console.log("PREVIEW_RAW", JSON.stringify(before)); try { const r = await api<{ conflicts: { kind: string; binding_id: string }[] }>("/api/admin/binding-conflicts?user_id=" + encodeURIComponent(edit ? edit.user_id : nb.user_id) + "&driver_id=" + encodeURIComponent(String(edit ? edit.driver_id : nb.driver_id)) + "&start=" + encodeURIComponent(edit ? st : nb.s) + "&end=" + encodeURIComponent(edit ? en : nb.e) + (edit ? "&exclude=" + edit.binding_id : "")); setMsg(r.conflicts.length ? "预览到冲突：" + r.conflicts.map(c => c.kind + " (" + c.binding_id + ")").join("、") : "预览：无冲突（相邻不重叠可保存）"); setErr(null); } catch (e) { setErr("预览失败：" + String((e as Error).message)); } }
  async function save() {
    setErr(null);
    try {
      if (edit) { const r = await api<{ binding_id: string }>("/api/admin/binding-reschedule", { method: "POST", body: JSON.stringify({ binding_id: edit.binding_id, start: st || undefined, end: en === "" ? null : en }) }); setMsg(`已重排 ${r.binding_id} → [${st || "不变"}, ${en || "开放"}]`); }
      else { const r = await api<{ binding_id: string; identity_status: string }>("/api/admin/bindings", { method: "POST", body: JSON.stringify({ user_id: nb.user_id, driver_id: nb.driver_id, verified: nb.verified, window: { start: nb.s || null, end: nb.e || null }, note: "SM02 页面绑定操作" }) }); setMsg(`已保存 ${r.binding_id}（${r.identity_status}）`); }
      setEdit(null); await reload();
    } catch (e) { setErr("服务端校验拒绝：" + String((e as Error).message)); await reload().catch(() => undefined); }
  }
  const d2g = (id: string | null) => drivers.find(x => x.driver_id === id)?.gpsno || "—";
  const line = (x: Row, his: boolean) => <tr key={x.binding_id}>
    <td><b>{x.driver_id || "—"}</b><div className="meta">车辆 {d2g(x.driver_id)}</div></td>
    <td className="meta">{x.user_id}</td>
    <td>{x.identity_status || "—"}{(x.identity_status || "").includes("synthetic") ? <span className="tag amber" style={{ marginLeft: 4 }}>演示身份</span> : null}</td>
    <td>{(x.effective_start || "").slice(0, 10)} → {x.effective_end ? String(x.effective_end).slice(0, 10) : "持续有效"}<div className="meta">{x.account_status}{his && x.effective_end ? "（已于 " + x.effective_end.slice(0, 16) + " 关闭）" : ""}</div></td>
    <td style={{ whiteSpace: "nowrap" }}>
      <button className="btn" style={{ padding: "2px 8px" }} onClick={() => { setEdit(x); setSt(""); setEn(x.effective_end ? x.effective_end.slice(0, 10) : ""); }}>编辑有效期</button>{" "}
      <button className="btn" style={{ padding: "2px 8px" }} onClick={async () => { if (!window.confirm("删除该绑定行（快照与审计保留，drivers 冻结映射不受影响）？")) return; try { await api("/api/admin/binding-delete", { method: "POST", body: JSON.stringify({ binding_id: x.binding_id }) }); await reload(); } catch (e) { setErr("删除被拒：" + String((e as Error).message)); } }}>删除</button>
    </td>
  </tr>;
  return <div>
    {msg && <div className="alert info">{msg}</div>}
    {err && <div className="alert warn">{err}</div>}
    <div style={{ display: "flex", gap: 8, margin: "6px 0", flexWrap: "wrap", alignItems: "center" }}>
      <label className="meta">按历史日期过滤（空=显示全部当前 active）：<input type="date" className="btn" style={{ width: "auto" }} value={asOf} onChange={(e) => setAsOf(e.target.value)} aria-label="as_of 历史日期" /></label>
      <span className="meta">当前 {cur.length} · 历史 {hist.length}（含 as_of 过滤）· 规则：闭区间含首尾日，相邻可，空结束=持续有效；同车重叠/一号多司机/结束早于开始 均服务端强制拒绝</span>
    </div>
    {!rows ? <div className="meta">读取中…</div> : <>
      <h3 style={{ fontSize: 14 }}>当前绑定（{asOf} 有效）</h3>
      <table className="tbl"><thead><tr><th>司机 / 车辆</th><th>平台账号</th><th>identity_status</th><th>生效起止</th><th>操作</th></tr></thead><tbody>{cur.map((x) => line(x, false))}</tbody></table>
      <h3 style={{ fontSize: 14, marginTop: 10 }}>历史绑定（已关闭/更替，保留可追溯）</h3>
      <table className="tbl"><thead><tr><th>司机 / 车辆</th><th>平台账号</th><th>identity_status</th><th>生效起止</th><th>操作</th></tr></thead><tbody>{hist.slice(0, 20).map((x) => line(x, true))}</tbody></table>
    </>}
    <div className="task-card" style={{ marginTop: 8, padding: 8 }}>
      <div className="t">{edit ? "编辑有效期 · " + edit.binding_id : "新建/变更绑定（verified=false 不授予个人明细）"}</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {!edit && <input className="btn" style={{ width: 200 }} placeholder="user_id" value={nb.user_id} onChange={(e) => setNb({ ...nb, user_id: e.target.value })} aria-label="目标账号" />}
        {!edit && <select className="btn" value={nb.driver_id} onChange={(e) => setNb({ ...nb, driver_id: e.target.value })} aria-label="选择司机">{drivers.slice(0, 600).map((d) => <option key={d.driver_id} value={d.driver_id}>{d.driver_id} · {d.gpsno}</option>)}</select>}
        <input type="date" className="btn" value={edit ? st : nb.s} onChange={(e) => (edit ? setSt(e.target.value) : setNb({ ...nb, s: e.target.value }))} aria-label="生效开始" />
        <input type="date" className="btn" value={edit ? en : nb.e} onChange={(e) => (edit ? setEn(e.target.value) : setNb({ ...nb, e: e.target.value }))} aria-label="结束（留空=持续）" placeholder="空=开放" />
        {!edit && <label className="meta" style={{ alignSelf: "center" }}><input type="checkbox" checked={nb.verified} onChange={(e) => setNb({ ...nb, verified: e.target.checked })} /> 已核实身份</label>}
        <button className="btn" onClick={preview}>预览冲突（不落库）</button>
        <button className="btn primary" style={{ width: "auto" }} disabled={!edit && !nb.user_id} onClick={save}>{edit ? "保存有效期" : "提交绑定"}</button>
        {edit && <button className="btn" onClick={() => { setEdit(null); setSt(""); setEn(""); }}>取消编辑</button>}
      </div>
      <p className="meta">保存由服务端重校验（预览仅为辅助）；变更保留旧行与审计（操作者/时间/旧新区间）；不覆写 drivers 冻结映射、历史评分或预测快照。未核实绑定的司机端个人明细不下发（my.* 403）。</p>
    </div>
  </div>;
}

