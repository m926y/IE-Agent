import { useEffect, useRef, useState } from 'react';
import { ApiError, adminDailyReportJobs, adminDailyReportRun, dailyGoalFeedback, dailyReportDetail, dailyReportHistory, dailyReportNotifications, dailyReportToday, dailySafetyGoals, noteRead } from './api';
import type { DailyGoal, DailyHistory, DailyReportJobs, DailySafetyReport, NoteRow, PublishedDailyReport } from './api';
import { DriverEvidence } from './driver-evidence';
import { Banner, EmptyState } from './ui';

const num=(value:number|null)=>value===null?'未取得':String(value);
const evidenceId=(ref:string)=>ref.startsWith('event:')?ref.slice(6):null;
const comparisonLabel=(status:string)=>({comparable:'可比',missing_score:'缺少有效评分',insufficient_history:'缺少第二期评分',not_comparable:'评分口径不同',verify_data:'评分可信度不足',missing_window:'缺少评分窗口',overlapping_window:'两期评分窗口重叠'}[status]||'数据不足');
const confidenceLabel=(status:string|null)=>status?({high:'高',medium:'中',low:'低'}[status]||status):'未取得';
const goalStatusLabel=(status:string)=>({active:'待核对',dismissed:'暂不跟进'}[status]||status);

export function DailyReportEntry({onOpen}:{onOpen:()=>void}){
  const [title,setTitle]=useState('今日简报尚未生成'),[unread,setUnread]=useState<number|null>(null);
  useEffect(()=>{let live=true;const refresh=()=>{if(document.visibilityState==='hidden')return;Promise.all([dailyReportToday(),dailyReportNotifications()]).then(([report,notes])=>{if(live){setTitle(report?.report.title||'今日简报尚未生成');setUnread(notes.rows.filter(row=>!row.read_at).length);}}).catch(()=>{if(live)setTitle('简报暂不可读取');});};refresh();const timer=setInterval(refresh,60000);document.addEventListener('visibilitychange',refresh);return()=>{live=false;clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};},[]);
  return <div className="panel"><h3>今日安全简报</h3><p>{title}</p><p className="meta">{unread===null?'通知状态读取中':`未读简报通知 ${unread} 条`} · 历史数据分析</p><button className="btn" onClick={onOpen}>查看简报与安全动态</button></div>;
}

function ReportView({published,goal,onFeedback}:{published:PublishedDailyReport;goal:DailyGoal|null;onFeedback:(code:'will_review'|'need_help'|'dismissed')=>void}){
  const r:DailySafetyReport=published.report, main=r.risks[0];
  return <div className="stack">
    <div className="panel score-hero"><div className="l">历史数据分析 · 报告日期 {r.reportDate} · 版本 {published.reportVersion}</div><h2>{r.title}</h2><div className="n">{num(r.metrics.personalScore)}</div><div className="l">个人安全分 · 数据截至 {r.metrics.personalScoreDate||'未取得'} · 可信度 {confidenceLabel(r.metrics.scoreConfidence)}</div></div>
    <div className="panel"><h3>评分与车队对照</h3><p>车队同期均分：<b>{num(r.metrics.fleetAverage)}</b>{r.metrics.fleetScoredDrivers!==null?`（可比司机 ${r.metrics.fleetScoredDrivers} 人）`:''}</p><p>车队截点：{r.metrics.fleetDate||'未取得'} · 两期差值：{num(r.metrics.scoreChange)}（{comparisonLabel(r.metrics.scoreComparisonStatus)}）</p>{r.metrics.scoreEvidenceId&&<DriverEvidence kind="score_history" id={r.metrics.scoreEvidenceId} label="查看本人评分依据" />}</div>
    <div className="panel"><h3>评分趋势</h3><p>{r.metrics.scoreComparisonStatus==='comparable'?`可比两期评分变化：${num(r.metrics.scoreChange)}`:'可比数据不足：现有评分窗口或可信度不支持独立趋势判断。'}</p></div>
    <div className="panel"><h3>回放事件与本期建议</h3>{main?<><p>{main.eventName||main.eventType}：已记录 {main.observedCount} 条。按已观察同类计数排序；不是事故预测或完整近 7 日风险率。</p><p>记录时间：{main.firstObservedAt} 至 {main.lastObservedAt}</p>{r.dailyGoal&&<Banner tone="info">行动建议：{r.dailyGoal.description}</Banner>}<details><summary>为什么推荐这项核对</summary><p>{r.dailyGoal?.recommendationBasis==='source_score_action'?'建议取自本人评分快照的原始推荐动作，且与回放事件维度一致。':'建议依据本人已记录的同类历史回放事件；没有独立的事故预测评分。'}</p><p>按已观察同类事件数排序：{main.observedCount} 条；来源覆盖 {r.coverage.observedDates.join('、')||'未取得'}。</p>{r.dailyGoal?.scoreEvidenceRef&&r.metrics.scoreEvidenceId&&<DriverEvidence kind="score_history" id={r.metrics.scoreEvidenceId} label="核对评分建议来源" />}{main.evidenceRefs.map(ref=>{const id=evidenceId(ref);return id?<DriverEvidence key={ref} kind="event" id={id} label={`核对回放证据 ${id}`} />:null;})}</details></>:<p>目前没有可引用的本人回放事件，暂不作个人风险判断。</p>}{r.cards.filter(card=>card.type==='learning_tip').map(card=><p className="meta" key={card.title}>{card.title}：{card.description}</p>)}</div>
    {r.goalTracking&&<div className="panel"><h3>上一期目标跟踪</h3><p>{r.goalTracking.previousReportDate} 的目标：{goalStatusLabel(r.goalTracking.previousStatus)}{r.goalTracking.previousFeedbackCode?' · 已记录司机反馈':''}</p><p>{r.goalTracking.note}</p><p className="meta">本期评估：待新证据；{r.goalTracking.newEvidence?'有新增来源证据':'没有新增个人证据'}。阅读或反馈不等于行为改善。</p></div>}
    <div className="panel"><h3>数据限制</h3><p>统计截至 {r.dataAsOf} · 来源覆盖 {r.coverage.observedDates.join('、')||'未取得'}</p><ul>{r.dataLimitations.map(item=><li key={item}>{item}</li>)}</ul></div>
    {goal&&<div className="panel"><h3>目标反馈</h3><p>{goal.description}</p><p className="meta">当前状态：{goalStatusLabel(goal.status)}；反馈只记录意向，不代表驾驶行为已改善。</p><div className="row"><button className="btn" onClick={()=>onFeedback('will_review')}>计划核对</button><button className="btn" onClick={()=>onFeedback('need_help')}>需要协助</button><button className="btn" onClick={()=>onFeedback('dismissed')}>暂不跟进</button></div></div>}
  </div>;
}

export function DailyReportPage({enabled}:{enabled:boolean}){
  const [today,setToday]=useState<PublishedDailyReport|null>(null),[selected,setSelected]=useState<PublishedDailyReport|null>(null);
  const [history,setHistory]=useState<DailyHistory|null>(null),[notes,setNotes]=useState<NoteRow[]>([]),[goals,setGoals]=useState<DailyGoal[]>([]);
  const [mode,setMode]=useState<'report'|'feed'|'history'>('report'),[offset,setOffset]=useState(0),[error,setError]=useState<unknown>(null),[loading,setLoading]=useState(true),[message,setMessage]=useState('');
  const currentId=useRef<number|null>(null);
  async function load(){setLoading(true);setError(null);try{
    const [current,h,n,g]=await Promise.all([dailyReportToday(),dailyReportHistory(offset),dailyReportNotifications(),dailySafetyGoals()]);
    setSelected(previous=>!previous||previous.id===currentId.current?current:previous);currentId.current=current?.id||null;
    setToday(current);setHistory(h);setNotes(n.rows);setGoals(g.rows);
  }catch(e){setError(e);}finally{setLoading(false);}}
  useEffect(()=>{if(!enabled)return;void load();const refresh=()=>{if(document.visibilityState==='visible')void load();};const timer=setInterval(refresh,60000);document.addEventListener('visibilitychange',refresh);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};},[enabled,offset]);
  async function open(id:number){setError(null);try{setSelected(await dailyReportDetail(id));setMode('report');}catch(e){setError(e);}}
  async function readNote(note:NoteRow){try{await noteRead(note.notification_id);await open(Number(note.source_entity_id));setNotes(prev=>prev.map(row=>row.notification_id===note.notification_id?{...row,read_at:new Date().toISOString()}:row));}catch(e){setError(e);}}
  async function feedback(code:'will_review'|'need_help'|'dismissed'){const goal=goals.find(g=>g.reportId===selected?.id);if(!goal)return;try{await dailyGoalFeedback(goal.id,code);setMessage('反馈已保存；不代表安全行为已改善。');setGoals((await dailySafetyGoals()).rows);}catch(e){setError(e);}}
  if(!enabled)return <EmptyState kind="noperm" hint="请先完成已核实的司机绑定。" />;
  const shown=selected||today;
  return <div className="stack"><h2>今日安全简报</h2><p className="page-desc">停车或休息时阅读。报告来自 IE亮剑 历史资料，不是实时监测。</p>
    <div className="row"><button className="btn" onClick={()=>{setSelected(today);setMode('report');}}>今日简报</button><button className="btn" onClick={()=>setMode('feed')}>安全动态</button><button className="btn" onClick={()=>setMode('history')}>历史简报</button><button className="btn" onClick={()=>void load()}>刷新</button></div>
    {error?<Banner tone="warn">读取或保存失败：{error instanceof ApiError?error.code:'network'}。请重试。</Banner>:null}
    {message&&<Banner tone="info">{message}</Banner>}
    {loading&&!history?<EmptyState kind="loading" />:null}
    {!today&&history&&<Banner tone="info">今日尚无已发布简报。历史报告可在“历史简报”中查看。</Banner>}
    {notes.some(n=>!n.read_at)&&<div className="panel"><h3>未读简报通知</h3>{notes.filter(n=>!n.read_at).map(n=><div key={n.notification_id} className="task-card"><b>{n.title||'简报已生成'}</b><p>{n.content}</p><button className="btn" onClick={()=>void readNote(n)}>标记已读并查看简报</button></div>)}</div>}
    {mode==='report'&&shown&&<ReportView published={shown} goal={goals.find(g=>g.reportId===shown.id)||null} onFeedback={code=>void feedback(code)} />}
    {mode==='feed'&&<div className="panel"><h3>安全动态</h3>{shown?shown.report.cards.length?shown.report.cards.map(card=><div className="task-card" key={`${shown.id}:${card.priority}`}><b>{card.title}</b><p>{card.description}</p><button className="btn" onClick={()=>setMode('report')}>查看简报与证据</button></div>):<p>当前报告没有可引用的个性化动态。</p>:<p>暂无已发布报告。</p>}</div>}
    {mode==='history'&&<div className="panel"><h3>历史简报</h3>{history?.rows.map(row=><div className="task-card" key={row.id}><b>{row.reportDate} · 版本 {row.reportVersion}</b><p>{row.title}</p><p className="meta">发布于 {row.publishedAt}{row.isCurrent?' · 当日当前版本':''}</p><button className="btn" onClick={()=>void open(row.id)}>查看详情</button></div>)}{history?.rows.length===0&&<p>暂无已发布简报。</p>}<div className="row"><button className="btn" disabled={offset===0} onClick={()=>setOffset(v=>Math.max(0,v-20))}>上一页</button><button className="btn" disabled={!history||offset+history.rows.length>=history.total} onClick={()=>setOffset(v=>v+20)}>下一页</button></div></div>}
  </div>;
}

export function AdminDailyReportPanel({localOnly}:{localOnly:boolean}){
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const [driverId,setDriverId]=useState(''),[date,setDate]=useState(today),[revise,setRevise]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState('');
  const [jobs,setJobs]=useState<DailyReportJobs|null>(null),[failedJobs,setFailedJobs]=useState<DailyReportJobs['rows']>([]);
  async function refreshJobs(){const [summary,failed]=await Promise.all([adminDailyReportJobs(date),adminDailyReportJobs(date,'failed')]);setJobs(summary);setFailedJobs(failed.rows);}
  useEffect(()=>{if(!localOnly)return;let live=true;const refresh=()=>{if(document.visibilityState==='hidden')return;Promise.all([adminDailyReportJobs(date),adminDailyReportJobs(date,'failed')]).then(([summary,failed])=>{if(live){setJobs(summary);setFailedJobs(failed.rows);}}).catch(()=>{if(live)setJobs(null);});};refresh();const timer=setInterval(refresh,60000);document.addEventListener('visibilitychange',refresh);return()=>{live=false;clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};},[localOnly,date]);
  async function run(){if(busy)return;setBusy(true);setError('');setResult('');try{const saved=await adminDailyReportRun(driverId.trim(),date,revise);setResult(`${saved.report.reportDate} · ${saved.report.driverId} · 版本 ${saved.reportVersion} · ${saved.idempotentReplay?'已有同一来源报告':'已发布'} · 通知 ${saved.notificationCount} 条`);}catch(e){setError(e instanceof ApiError?e.code:'network');}finally{setBusy(false);}}
  return <div className="panel"><h2>每日安全简报</h2><p>本地工作台每天上海时间 07:00 后自动生成来源司机的历史安全简报，关闭司机页面仍会继续。此处可手动生成、查看任务进度；不使用外部模型或实时监测数据。</p>
    {!localOnly?<Banner tone="warn">仅本地工作台支持此功能。</Banner>:<><div className="row"><label>来源司机 ID <input value={driverId} onChange={e=>setDriverId(e.target.value)} placeholder="例如 DEMO_D0149" /></label><label>报告日期 <input type="date" value={date} max={today} onChange={e=>setDate(e.target.value)} /></label></div><label><input type="checkbox" checked={revise} onChange={e=>setRevise(e.target.checked)} /> 来源变化时允许创建新版本</label><div><button className="btn primary" disabled={busy||!driverId.trim()||!date} onClick={()=>void run()}>{busy?'正在生成…':'生成并发布'}</button></div></>}
    {result&&<Banner tone="info">{result}</Banner>}{error&&<Banner tone="warn">生成失败：{error}</Banner>}
    {localOnly&&<div className="task-card"><h3>{date} 自动任务</h3>{jobs?<><p>总数 {jobs.total} · 已完成 {jobs.byStatus.succeeded||0} · 待处理 {jobs.byStatus.pending||0} · 处理中 {jobs.byStatus.running||0} · 失败 {jobs.byStatus.failed||0}</p>{failedJobs.slice(0,10).map(row=><p className="meta" key={row.id}>{row.driver_id} · 尝试 {row.attempts} 次 · {row.finished_at||'未完成'}：{row.error_message||'生成失败'}</p>)}</>:<p>任务状态读取中或暂不可用。</p>}<button className="btn" onClick={()=>void refreshJobs().catch(()=>setJobs(null))}>刷新任务状态</button></div>}
  </div>;
}
