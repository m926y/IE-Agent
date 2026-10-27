// R37：EV06 根因分析（只读聚合页） + SM03 风险等级→强制性培训映射卡（运营配置域）
import { useEffect, useState } from "react";
import { ApiError, opsConfigUpdate, rootCauses, getData } from "./api";
import type { RootCausesResult } from "./api";
import { EmptyState, Tag } from "./ui";

const LEVELS = ["A", "B", "C", "D"] as const;

export function RootCausesPage() {
  const [cohort, setCohort] = useState("cd");
  const [data, setData] = useState<RootCausesResult | null | "error">(null);
  async function load(c = cohort) { setData(null); try { setData(await rootCauses(c)); } catch { setData("error"); } }
  useEffect(() => { load(cohort); }, [cohort]);
  if (data === "error") return <EmptyState kind="error" onRetry={() => load()} />;
  if (!data) return <EmptyState kind="loading" />;
  if (data.data_status !== "ok") return <div><div className="page-head"><h2>根因分析</h2></div><EmptyState kind="nocov" hint={data.note} /></div>;
  const dims = data.dimensions || []; const maxShare = Math.max(...dims.map((d) => d.share_pct || 0), 1);
  return <div>
    <div className="dashboard-heading fleet-heading"><h1>根因分析</h1><span className="date-label">数据截止 <b>{data.as_of_date || "—"}</b></span></div>
    <div className="fleet-toolbar" style={{ marginBottom: 10 }}>
      <div className="fleet-filters" aria-label="分析对象"><button className={cohort === "cd" ? "active" : ""} onClick={() => setCohort("cd")}>C+D 级对象</button><button className={cohort === "d" ? "active" : ""} onClick={() => setCohort("d")}>仅 D 级</button></div>
      <button className="btn" style={{ marginLeft: "auto" }} onClick={() => load()}>重新计算（只读）</button>
    </div>
    <div className="dashboard-metrics">
      {[["分析对象数", data.cohort_count ?? "—"], ["池内平均分", data.pool_avg ?? "—"], ["低可信度对象", data.low_conf_in_pool ?? "—"], ["池内台账分摊合计", data.ledger_total_allocated_in_pool ?? "—"]].map(([k, v]) => <div className="dashboard-metric" key={String(k)}><span className="metric-label">{k}</span><strong>{String(v)}</strong><span className="metric-note">{k === "低可信度对象" ? "先核验" : "实时聚合"}</span></div>)}
    </div>
    <div className="meta" style={{ margin: "6px 0" }}>口径：{data.cohort} · 快照来源 {data.source_version} · 现行规则口径 {data.ruleset_source_version || "—"} · 池内有台账覆盖 {data.gps_covered_in_pool} 车 / 无台账行 {data.gps_without_ledger_in_pool} 车（不等于零风险）</div>
    <section className="panel"><h3>维度分摊贡献（结构性归因，非单事件因果）</h3>
      {dims.map((d) => <div key={d.dimension} className="row" style={{ marginBottom: 5 }}>
        <span style={{ width: 130, fontSize: 12.5, color: "var(--ink-2)" }}>{d.dimension_name}</span>
        <span style={{ height: 14, width: `${(d.share_pct || 0) / maxShare * 42}%`, minWidth: 2, background: "#a389c3", borderRadius: 3, display: "inline-block" }} />
        <span className="mono">{d.allocated_points}（{d.share_pct ?? "—"}%）· 事件 {d.events}</span>
      </div>)}
      {!dims.length && <EmptyState kind="nomatch" hint="池内对象无台账行：可能确无已记录事件或覆盖不足——先设备/数据核验（不当作零风险）。" />}
    </section>
    <section className="panel"><h3>事件类型 TOP（按分摊扣分）</h3>
      <div className="table-wrap"><table><thead><tr><th>维度</th><th>事件类型</th><th>分摊扣分</th></tr></thead><tbody>
        {(data.event_types || []).map((e) => <tr key={e.dimension + e.event_type}><td>{e.dimension_name}</td><td className="mono">{e.event_type}</td><td className="mono">{e.allocated_points}</td></tr>)}
      </tbody></table></div>
    </section>
    <section className="panel"><h3>分摊最高的对象（点击进 EV03 核对）</h3>
      <div className="table-wrap"><table><thead><tr><th>车辆</th><th>司机</th><th>安全分</th><th>等级</th><th>可信度</th><th>台账分摊合计</th><th /></tr></thead><tbody>
        {(data.top_objects || []).map((o) => <tr key={o.gpsno}>
          <td className="mono">{o.gpsno}</td><td className="mono">{o.driver_id || "—"}</td><td className="score-cell">{o.safety_score ?? "—"}</td>
          <td>{o.risk_level === "D" ? <Tag tone="red">D（高优先复核）</Tag> : o.risk_level === "C" ? <Tag tone="amber">C</Tag> : <Tag tone="gray">{String(o.risk_level ?? "—")}</Tag>}</td>
          <td>{o.confidence_level === "low" ? <Tag tone="amber">低 · 先核验</Tag> : String(o.confidence_level ?? "—")}</td>
          <td className="mono">{o.allocated_points}</td>
          <td><button className="table-action" onClick={() => { const q = o.driver_id && o.driver_id !== "—" ? `driver_id=${encodeURIComponent(String(o.driver_id))}` : `gpsno=${encodeURIComponent(o.gpsno)}`; location.hash = `ev-fleet?${q}`; }}>查看明细 →</button></td>
        </tr>)}
      </tbody></table></div>
      <p className="login-note" style={{ marginTop: 6 }}>{data.note}</p>
    </section>
  </div>;
}

export function MandatePolicyCard() {
  const [policy, setPolicy] = useState<Record<string, string> | null>(null);
  const [ver, setVer] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [notSet, setNotSet] = useState(false);
  const [busy, setBusy] = useState(false);
  async function reload() {
    try { const r = await getData<Record<string, unknown>>("admin.operation_config", { limit: 50 });
      const row = r.rows.find((x) => String(x.config_id) === "training_mandate_policy");
      if (row) { try { setPolicy(JSON.parse(String(row.value))); } catch { setPolicy(null); } setVer(Number(row.config_version) || 0); setNotSet(false); }
      else { setPolicy({ A: "optional", B: "optional", C: "optional", D: "mandatory" }); setVer(null); setNotSet(true); }
    } catch { setMsg("读取失败：运营配置不可用"); }
  }
  useEffect(() => { reload(); }, []);
  async function save() {
    if (!policy) return; setBusy(true); setMsg(null);
    try { const r = await opsConfigUpdate({ config_id: "training_mandate_policy", value: JSON.stringify(policy) }); setMsg(`已保存 v${r.new_version}：${r.old_value ?? "（初次创建）"} → ${r.new_value}，审计 ${r.audit_id}${r.new_version === 1 ? "（配置即生效，后续分配缺省套用）" : "（配置生效时间见下）"}`); await reload(); }
    catch (e) { setMsg(e instanceof ApiError ? `拒绝：${e.code}` : "网络异常"); }
    setBusy(false);
  }
  return <div className="panel" style={{ marginTop: 10 }}><h3>风险等级 → 强制性培训映射{notSet ? "（尚无配置：下方为建议缺省，保存后生效）" : ver !== null ? `（现行 v${ver}）` : ""}</h3>
    <p className="page-desc" style={{ margin: "4px 0 8px" }}>分配培训时：表单项<b>未显式改动</b>则按此映射自动设定 mandatory；操作者显式改判一律允许并被记录（审计 mandatory_source=manual + policy_expected）；本表在运营配置域，有版本与审计。</p>
    <div className="row">{LEVELS.map((l) => <label key={l} style={{ display: "flex", gap: 4, alignItems: "center" }}><b>{l}</b>
      <select className="btn" style={{ background: "#fff" }} value={policy?.[l] || "optional"} onChange={(e) => setPolicy({ ...(policy || {}), [l]: e.target.value })}><option value="optional">非强制</option><option value="mandatory">强制</option></select></label>)}
      <button className="btn primary" style={{ width: "auto" }} disabled={busy || !policy} onClick={save}>{busy ? "保存中…" : notSet ? "保存并启用映射" : "确认修改并升版"}</button>
    </div>
    {msg && <div className="alert info" style={{ marginTop: 6 }}>{msg}</div>}
  </div>;
}
