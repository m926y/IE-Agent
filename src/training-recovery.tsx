import { useState } from "react";
import { ApiError, retryTaskNotification } from "./api";
import type { TaskNotificationReceipt } from "./api";

export function notificationText(receipt?: TaskNotificationReceipt): string {
  return !receipt ? "通知状态请在台账核对。" : { recorded: "站内通知已记录，不代表已读或外部渠道送达。", pending: "任务已保存，站内提醒暂未完成，可由安全员按任务编号重试。", no_recipient: "任务已保存，但未取得有效接收账号，请核对账号绑定后重试。", not_needed: "任务已进入后续状态，无需补发此阶段提醒。" }[receipt.state];
}

export function TrainingNotificationRecovery() {
  const [id, setId] = useState(""), [kind, setKind] = useState<"assigned" | "submitted">("assigned"), [busy, setBusy] = useState(false), [msg, setMsg] = useState("");
  async function retry() {
    setBusy(true); setMsg("");
    try { const r = await retryTaskNotification(id.trim(), kind); setMsg(`任务 ${r.task_id}：${notificationText(r.notification)}${r.notification.notification_id ? ` 回执 ${r.notification.notification_id}` : ""}`); }
    catch (e) { setMsg(`未完成（${e instanceof ApiError ? e.code : "network"}），请核对任务编号与车队权限。`); }
    finally { setBusy(false); }
  }
  return <details className="panel"><summary>站内提醒故障恢复</summary><p>仅补记既有任务当前阶段的站内提醒，不重新分配或修改任务。重复重试返回同一回执。</p><label>任务编号<input aria-label="补发提醒任务编号" value={id} maxLength={80} onChange={e => setId(e.target.value)} /></label><label>提醒阶段<select aria-label="补发提醒阶段" value={kind} onChange={e => setKind(e.target.value as "assigned" | "submitted")}><option value="assigned">新分配提醒司机</option><option value="submitted">已提交提醒安全员</option></select></label><button className="btn" disabled={busy || !/^[\w:,.-]{1,80}$/.test(id.trim())} onClick={retry}>补记站内提醒</button>{msg && <div className="alert info" role="status">{msg}</div>}</details>;
}
