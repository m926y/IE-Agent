import { useEffect, useRef, useState } from "react";
import { ApiError, driverRiskCenter, taskView, taskSaveDraft, taskStart, taskSubmit } from "./api";
import type { DriverRiskResult, TaskView } from "./api";
import { EmptyState, Tag } from "./ui";
import { DriverEvidence } from "./driver-evidence";
import { notificationText } from "./training-recovery";
import { LearningReportPanel } from "./learning-report";
import { useDriverDraft } from "./driver-navigation";
import { DriverReadError, numberText, trainingStatusNames } from "./driver-shared";

export function DriverRiskPanel() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const [date, updateDate] = useState(today);
  const [eventsOffset, setEventsOffset] = useState(0);
  const [alertsOffset, setAlertsOffset] = useState(0);
  const setDate = (value: string) => { updateDate(value); setEventsOffset(0); setAlertsOffset(0); };
  const [data, setData] = useState<DriverRiskResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true; setData(null); setError(null);
    driverRiskCenter(date, eventsOffset, alertsOffset).then(r => { if (active) setData(r); }).catch(e => { if (active) setError(e); });
    return () => { active = false; };
  }, [date, eventsOffset, alertsOffset, version]);
  const sc = data?.snapshot;
  return <section className="panel" aria-label="个人风险记录">
    <h3>个人风险记录</h3>
    <label>查看日期（北京时间） <input type="date" aria-label="风险日期" value={date} onChange={e => { if (e.target.value) setDate(e.target.value); }} /></label>
    {error ? <DriverReadError error={error} retry={() => setVersion(v => v + 1)} /> : !data ? <EmptyState kind="loading" /> : <>
      <div className="alert warn">历史回放 / {data.date} · 当前未接入实时事件流。无记录不等于零风险。</div>
      <div className="meta">查询时间 {data.queried_at} · 快照截止 {String(sc?.as_of_date || "未取得")}</div>
      {sc ? <p>未来40天预测概率：<b>{sc.forecast_40d_risk_prob == null || !Number.isFinite(Number(sc.forecast_40d_risk_prob)) || String(sc.forecast_40d_risk_prob).trim() === "" ? "—" : numberText(Number(sc.forecast_40d_risk_prob) * 100) + "%"}</b> · 可信度 {String(sc.confidence_level || "未取得")}<br /><span className="meta">这是快照预测，不能视为所选日期的实时风险或已发生事故。版本 {String(sc.source_version || "未取得")}</span></p> : <p>未取得本人评分快照，不显示风险概率。</p>}
      {data.latest_replay_date && data.latest_replay_date !== date && <button className="btn" onClick={() => setDate(data.latest_replay_date!)}>查看最近回放日 {data.latest_replay_date}</button>}
      <h4>回放事件</h4>
      {data.events.length === 0 && <p>本页没有可展示的本人回放事件；数据覆盖情况需核验。</p>}
      {data.events.map(e => <details className="task-card" id={`driver-event-${String(e.event_id)}`} key={String(e.event_id)}><summary>{String(e.event_name || e.event_type)} · {String(e.event_time)}</summary><div className="meta">记录 {String(e.event_id)} · 维度 {String(e.dimension || "—")} · 速度 {numberText(e.speed_kmh)} km/h · 来源版本 {String(e.source_version || "未取得")}</div><p>此条为历史回放数据，事件记录不等于已确认违规或事故。</p><DriverEvidence kind="event" id={String(e.event_id)} /></details>)}
      <div className="row" aria-label="回放分页"><button className="btn" disabled={eventsOffset === 0} onClick={() => setEventsOffset(v => Math.max(0, v - 20))}>回放上一页</button><span>第 {eventsOffset / 20 + 1} 页</span><button className="btn" disabled={!data.pagination.events_has_more} onClick={() => setEventsOffset(v => v + 20)}>回放下一页</button></div>
      <h4>人工告警</h4>
      {data.alerts.length === 0 && <p>本页没有本人告警记录；这与是否存在风险事件是两回事。</p>}
      {data.alerts.map(a => <div className="task-card" key={String(a.alert_id)}><b>{String(a.rule_code)} · {String(a.status)}</b><div className="meta">告警 {String(a.alert_id)} · {String(a.occurred_at)} · {a.is_replay ? "历史回放" : "来源以原始记录为准"}<br />证据 {String(a.evidence_id || "未关联")}</div><DriverEvidence kind="alert" id={String(a.alert_id)} label="查看告警证据" />{data.events.some(e => e.event_id === a.evidence_id) && <a href={`#driver-event-${String(a.evidence_id)}`} onClick={e => { e.preventDefault(); const el = document.getElementById(`driver-event-${String(a.evidence_id)}`); el?.setAttribute("open", ""); el?.scrollIntoView({ behavior: "smooth" }); }}>查看关联事件</a>}</div>)}
      <div className="row" aria-label="告警分页"><button className="btn" disabled={alertsOffset === 0} onClick={() => setAlertsOffset(v => Math.max(0, v - 20))}>告警上一页</button><span>第 {alertsOffset / 20 + 1} 页</span><button className="btn" disabled={!data.pagination.alerts_has_more} onClick={() => setAlertsOffset(v => v + 20)}>告警下一页</button></div>
      {data.truncated && <p className="meta">还有记录未显示，请使用对应列表的下一页；翻页期间如新增数据，记录位置可能变化。</p>}
      <p className="login-note">{data.note}</p>
    </>}
  </section>;
}


export function DriverTrainingCard({ row, reload }: { row: Record<string, unknown>; reload: () => void }) {
  const id = String(row.task_id);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<TaskView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [record, setRecord] = useState(String(row.learning_record || ""));
  const [feedback, setFeedback] = useState(String(row.feedback || ""));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [conflict, setConflict] = useState(false);
  const [conflictRead, setConflictRead] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  const busyRef = useRef(false);
  const saved = useRef({ record, feedback });
  const dirty = useRef(false);
  const sequence = useRef(0);
  function markDirty(value: boolean) { dirty.current = value; setUnsaved(value); }
  const load = async (checkingConflict = false) => {
    const seq = ++sequence.current; setError(null);
    try {
      const r = await taskView(id);
      if (seq !== sequence.current) return;
      setView(r);
      if (checkingConflict) setConflictRead(true);
      saved.current = { record: String(r.task.learning_record ?? ""), feedback: String(r.task.feedback ?? "") };
      if (!dirty.current) { setRecord(saved.current.record); setFeedback(saved.current.feedback); }
    } catch (e) { if (seq === sequence.current) setError(e); }
  };
  useEffect(() => { if (open) load(); return () => { sequence.current++; }; }, [open, id, row.status]);
  const status = String(view?.task.status || row.status);
  const editable = ["assigned", "in_progress", "returned"].includes(status);
  const overdue = editable && row.due_at && Date.parse(String(row.due_at)) < Date.now();
  function discard() { setRecord(saved.current.record); setFeedback(saved.current.feedback); markDirty(false); }
  useDriverDraft(`training:${id}`, { label: `培训任务 ${id}`, get dirty() { return dirty.current; }, get busy() { return busyRef.current; }, save: () => act("save"), discard });
  async function act(action: "start" | "save" | "submit") {
    if (busyRef.current || conflict || !view || error || !editable) return false;
    busyRef.current = true; setBusy(true); setMsg("");
    try {
      let notificationMessage = "";
      let expected = view?.task.updated_at == null ? null : String(view.task.updated_at);
      const extra = { feedback, expected_updated_at: expected };
      if (action === "start") await taskStart(id, expected);
      else if (action === "save") {
        const result = await taskSaveDraft(id, record, extra);
        saved.current = { record, feedback }; markDirty(false);
        setView(v => v ? { ...v, task: { ...v.task, learning_record: record, feedback, updated_at: result.updated_at } } : v);
      }
      else {
        const submitted = await taskSubmit(id, record, feedback, expected);
        saved.current = { record, feedback }; markDirty(false);
        notificationMessage = notificationText(submitted.notification);
      }
      setMsg(action === "submit" ? `已提交，等待人工复核；评分不会因此自动改变。${notificationMessage}` : action === "save" ? "草稿与反馈已保存。" : "已开始学习。");
      reload(); await load();
      return true;
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "network";
      if (code === "task_version_conflict") { setConflict(true); setConflictRead(false); }
      setMsg(code === "task_version_conflict" ? "任务已被其他操作更新，请刷新任务后再保存。你的输入仍保留。" : `操作结果未确认（${code}），输入已保留，请读取最新状态后再决定是否重试。`);
      return false;
    } finally { busyRef.current = false; setBusy(false); }
  }
  return <article className="task-card">
    <div className="t">{String(row.goal || id)} {row.mandatory ? <Tag tone="red">强制</Tag> : null} {overdue ? <Tag tone="red">逾期</Tag> : null}</div>
    <div className="meta">任务 {id} · 截止 {String(row.due_at || "—")} · <Tag tone={row.status === "reviewed" ? "green" : "blue"}>{trainingStatusNames[String(row.status)] || String(row.status)}</Tag></div>
    {row.review_note ? <p>复核意见：{String(row.review_note)} · {String(row.reviewed_at || "—")}</p> : null}
    <p className="meta" role="status">{busy ? "正在处理，请等待回执。" : unsaved ? "有未保存修改；离开前请保存。" : "当前没有未保存修改。"}</p>
    <button className="btn" aria-expanded={open} onClick={() => setOpen(v => !v)}>{open ? "收起课程与记录" : "打开课程与记录"}</button>
    {open && <div className="stack">
      {error ? <DriverReadError error={error} retry={() => void load()} /> : !view ? <EmptyState kind="loading" /> : <>
        <h4>{String(view.course?.title || "课程未取得")}</h4>
        <p className="meta">课程 {String(row.course_id)} · 版本 {String(view.course?.version_no ?? "未取得")} · {view.course_basis === "assignment" ? "分配时留存的版本" : view.course_basis === "first_learning_save" ? "首次保存学习时留存的版本" : "当前课程版本，尚未留存学习快照"} · 状态 {String(view.course?.content_status || "未取得")}</p>
        {view.course_basis !== "current_version" && view.current_course_status !== "approved" && <p className="alert warn">当前课程状态：{view.current_course_status || "未取得"}。这里展示任务留存版本，请按安全员要求继续或调整学习安排。</p>}
        <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.8 }}>{String(view.course?.content || "课程正文不可用。未批准或已停用且无留存版本的课程不会提供正文，请联系安全员。")}</div>
        <p>完成要求：{String(view.course?.completion_requirement || "未取得，请联系安全员")}</p>
        {view.alert ? <div className="alert info">关联告警 {String(view.alert.alert_id)} · 证据 {String(view.alert.evidence_id || "未关联")} · {String(view.alert.occurred_at)}。告警关联不代表已确认违规。<DriverEvidence kind="alert" id={String(view.alert.alert_id)} label="查看任务关联证据" /></div> : <p className="meta">本任务未关联告警，按通用培训处理。</p>}
        {view.reassess && <div className="alert info">复评：{view.reassess.note}{view.reassess.date ? ` 数据截止 ${view.reassess.date}，安全分 ${numberText(view.reassess.row?.safety_score)}。` : ""}</div>}
      </>}
      <label>学习记录<textarea aria-label={`学习记录 ${id}`} value={record} disabled={!editable || busy || !view} maxLength={6000} onChange={e => { markDirty(e.target.value !== saved.current.record || feedback !== saved.current.feedback); setRecord(e.target.value); }} style={{ width: "100%", minHeight: 90 }} /></label>
      <p className="meta">学习记录 {record.length}/6000 字；服务器最多保存6000字。刷新或关闭前请先保存，未保存内容只在当前页面保留。</p>
      <LearningReportPanel taskId={id} onLoaded={() => { reload(); load(); }} />
      <label>反馈<textarea aria-label={`学习反馈 ${id}`} value={feedback} disabled={!editable || busy || !view} maxLength={3000} onChange={e => { markDirty(record !== saved.current.record || e.target.value !== saved.current.feedback); setFeedback(e.target.value); }} style={{ width: "100%", minHeight: 50 }} /></label>
      <p className="meta">反馈 {feedback.length}/3000 字；服务器最多保存3000字。</p>
      {conflict && <div className="alert warn">请先读取最新状态并核对两份内容，重新读取不会自动解决内容冲突。
        <button className="btn" onClick={() => void load(true)}>重新读取任务状态（保留输入）</button>
        {conflictRead && !error && <div className="row"><button className="btn" disabled={!editable} onClick={() => { setConflict(false); setConflictRead(false); }}>已核对，使用我的输入继续编辑</button><button className="btn" onClick={() => { discard(); setConflict(false); setConflictRead(false); }}>采用服务器已保存内容</button></div>}
      </div>}
      {dirty.current && view && <details><summary>查看服务器已保存内容</summary><p style={{ whiteSpace: "pre-wrap" }}>{String(view.task.learning_record || "（空）")}</p><p>反馈：{String(view.task.feedback || "（空）")}</p></details>}
      {editable && <div className="row">{["assigned", "returned"].includes(status) && <button className="btn" disabled={busy || conflict || !view || !!error} onClick={() => act("start")}>开始学习</button>}<button className="btn" disabled={busy || conflict || !view || !!error} onClick={() => act("save")}>保存草稿与反馈</button><button className="btn primary" disabled={busy || conflict || !view || !!error || !record.trim()} onClick={() => { if (window.confirm("提交后等待安全员复核，学习记录暂不能编辑。确认提交？")) act("submit"); }}>提交学习记录</button></div>}
    </div>}
    {msg && <div role="status" className="alert info">{msg}</div>}
  </article>;
}
