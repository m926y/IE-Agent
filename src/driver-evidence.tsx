import { useEffect, useState } from "react";
import { ApiError, driverEvidence } from "./api";
import type { DriverEvidenceKind, DriverEvidenceResult } from "./api";
import { EmptyState } from "./ui";

const labels: Record<string, string> = { score_id: "评价记录", event_id: "事件记录", alert_id: "告警记录", queue_id: "队列记录", evidence_id: "关联证据", rule_code: "告警规则", event_time: "事件时间", occurred_at: "发生时间", event_type: "事件类别", event_name: "事件名称", speed_kmh: "速度 km/h", dimension: "维度", replay_date: "回放日期", is_replay: "历史回放标记", source_version: "来源版本", as_of_date: "数据截止日", window_start: "窗口起点", safety_score: "安全分", risk_level: "等级", confidence_level: "可信度", status: "处理状态", forecast_40d_risk_prob: "未来40天预测概率", primary_risk_dimension: "主要维度", history_contribution: "历史维度扣分", fatigue_distraction_contribution: "疲劳分心扣分", driving_stability_contribution: "驾驶稳定性扣分", road_rule_contribution: "道路规则扣分", management_contribution: "管理配合扣分", imu_evidence_contribution: "IMU证据扣分" };
function RecordFields({ record }: { record: Record<string, unknown> }) {
  return <dl style={{ margin: "8px 0", overflowWrap: "anywhere" }}>{Object.entries(record).filter(([key]) => key in labels).map(([key, value]) => <div key={key} style={{ marginBottom: 6 }}><dt className="meta">{labels[key]}</dt><dd style={{ marginLeft: 0 }}>{value == null || value === "" ? "未取得" : typeof value === "boolean" ? value ? "是" : "否" : String(value)}</dd></div>)}</dl>;
}

export function DriverEvidence({ kind, id, label = "查看原始证据", initialOpen = false }: { kind: DriverEvidenceKind; id: string; label?: string; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen), [offset, setOffset] = useState(0), [retry, setRetry] = useState(0);
  const [data, setData] = useState<DriverEvidenceResult | null>(null), [error, setError] = useState<unknown>(null);
  useEffect(() => { if (!open || !id) return; let active = true; setData(null); setError(null); driverEvidence(kind, id, offset).then(r => { if (active) setData(r); }).catch(e => { if (active) setError(e); }); return () => { active = false; }; }, [kind, id, open, offset, retry]);
  return id ? <div style={{ marginTop: 8 }}><button className="btn" aria-expanded={open} onClick={() => { setOpen(v => !v); setOffset(0); }}>{open ? "收起证据" : label}</button>
    {open && <section className="panel" aria-label="本人证据详情" style={{ marginTop: 8 }}>
      {error ? <EmptyState kind={error instanceof ApiError && [403, 404].includes(error.status) ? "noperm" : "error"} hint="证据未取得或暂不可读，不将缺失解释为零风险。" onRetry={() => setRetry(v => v + 1)} /> : !data ? <EmptyState kind="loading" /> : <>
        <h4>原始记录与来源</h4><RecordFields record={data.record} />
        {kind === "alert" && <><h4>告警关联证据</h4>{data.linked ? <RecordFields record={data.linked} /> : <p>未取得受支持且归属一致的原始证据。关联ID保留，不猜测来源。</p>}</>}
        {["score", "score_history"].includes(kind) && <><h4>对应评价日期的扣分台账</h4>{data.ledger.length === 0 && <p>{data.ledger_status === "unavailable" ? "缺少车辆或评价日期，无法定位台账。" : "本页无可展示台账，无台账不等于零风险。"}</p>}{data.ledger.map(r => <div className="task-card" key={String(r.ledger_id)}><b>{String(r.event_type || "类别未取得")} · {String(r.dimension || "维度未取得")}</b><p>事件数 {String(r.event_count ?? "未取得")} · 分摊扣分 {String(r.allocated_points ?? "未取得")}</p><p className="meta" style={{ overflowWrap: "anywhere" }}>记录 {String(r.ledger_id)} · 数据截止 {String(r.as_of_date || "未取得")} · 来源版本 {String(r.source_version || "未取得")} · 分摊规则 {String(r.allocation_rule || "未取得")}</p></div>)}<div className="row"><button className="btn" disabled={offset === 0} onClick={() => setOffset(v => Math.max(0, v - 20))}>台账上一页</button><span>第 {offset / 20 + 1} 页</span><button className="btn" disabled={!data.has_more} onClick={() => setOffset(v => v + 20)}>台账下一页</button></div></>}
        <p className="login-note">{data.limitations}</p><div className="meta">本次核验时间 {data.queried_at}</div>
      </>}
    </section>}
  </div> : null;
}
