import { useEffect, useRef, useState } from 'react';
import { ApiError, adminDailyReportJobs, adminDailyReportRun, dailyGoalFeedback, dailyReportDetail, dailyReportHistory, dailyReportNotifications, dailyReportToday, dailySafetyGoals, noteRead } from './api';
import type { DailyGoal, DailyHistory, DailyReportJobs, DailyRisk, DailySafetyReport, NoteRow, PublishedDailyReport } from './api';
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

function TrendChart({trend}:{trend:NonNullable<DailySafetyReport['scoreTrend']>}){
  const dates=trend.dates||[]; if(!dates.length) return <p className="meta">无可呈现的观测日。</p>;
  const vals=[...trend.personal,...(trend.fleet||[])].filter(v=>typeof v==='number') as number[];
  if(!vals.length) return <div className="dr-chart"><div className="dr-chart-title">评分趋势对比</div><p className="meta">与当期口径一致的观测分值不足，图表留白不插值。</p><p className="meta">{trend.note}</p></div>;
  // 紧凑自适应：优先以个人分值带为中心 ±8 展开，不足再并入车队线；避免 0-100 全量坐标把平稳曲线压成水平线
  const pOnly=trend.personal.filter(v=>typeof v==='number') as number[];
  const lo0=pOnly.length?Math.min(...pOnly):Math.min(...vals), hi0=pOnly.length?Math.max(...pOnly):Math.max(...vals);
  let min=lo0-8, max=hi0+8;
  if(Math.min(...vals)<min) min=Math.min(...vals)-3; if(Math.max(...vals)>max) max=Math.max(...vals)+3;
  min=Math.max(0,min); max=Math.min(100,max); if(max-min<10){min=Math.max(0,min-5);max=Math.min(100,max+5);}
  const W=320,H=120,P=12;
  const ticks=[min,(min+max)/2,max];
  const x=(i:number)=>P+(W-2*P)*(dates.length===1?0.5:i/(dates.length-1));
  const y=(v:number)=>H-P-((v-min)/((max-min)||1))*(H-2*P);
  const seg=(arr:(number|null)[])=>{const parts:string[]=[];let cur='';arr.forEach((v,i)=>{if(v==null){if(cur)parts.push(cur);cur='';return;}cur+=(cur?' L':'M')+x(i).toFixed(1)+','+y(v).toFixed(1);if(i===arr.length-1||arr[i+1]==null){parts.push(cur);cur='';}});return parts;};
  return <div className="dr-chart"><div className="dr-chart-title">评分趋势对比 <span className="meta">近 {dates.length} 个观测日</span></div>
    <svg viewBox={`0 0 ${W} ${H+16}`} role="img" aria-label={`个人评分 ${trend.personal.filter(v=>v!=null).join('、')||'未取得'}；车队均分 ${trend.fleet.filter(v=>v!=null).join('、')||'未取得'}`}>
      {ticks.map((tv,i)=><g key={i}><line x1={P} x2={W-P} y1={y(tv)} y2={y(tv)} stroke="#eee" strokeDasharray={i===1?"3 3":"0"}/><text x={P} y={y(tv)-3} fontSize="7.5" fill="#9a9a9a">{tv.toFixed(1)}</text></g>)}
      {seg(trend.fleet||[]).map((dd,i)=><path key={'f'+i} d={dd} fill="none" stroke="#67a86b" strokeWidth="1.6"/>)}
      {seg(trend.personal).map((dd,i)=><path key={'p'+i} d={dd} fill="none" stroke="#5b8def" strokeWidth="2"/>)}
      {trend.personal.map((v,i)=>v!=null?<g key={'pc'+i}><circle cx={x(i)} cy={y(v)} r="7" fill="transparent"><title>{`${dates[i]} 个人评分 ${v.toFixed(4)}`}</title></circle><circle cx={x(i)} cy={y(v)} r="2.6" fill="#5b8def"/></g>:null)}
      {(trend.fleet||[]).map((v,i)=>v!=null?<circle key={'fc'+i} cx={x(i)} cy={y(v)} r="5" fill="transparent"><title>{`${dates[i]} 车队均分 ${v.toFixed(1)}（可比 ${trend.fleetComparableCount?.[i]??'—'} 人）`}</title></circle>:null)}
      {dates.map((d,i)=><text key={d} x={x(i)} y={H+2} fontSize="8" textAnchor="middle" fill="#888">{d.slice(5).replace('-','/')}</text>)}
    </svg>
    <div className="dr-legend"><span><i className="dot" style={{background:'#5b8def'}}/>个人评分</span><span><i className="dot" style={{background:'#67a86b'}}/>车队均分</span></div>
    <p className="meta">{trend.note}</p></div>;
}
function ReportView({published,goal,onFeedback,onRead,readDone}:{published:PublishedDailyReport;goal:DailyGoal|null;onFeedback:(code:'will_review'|'need_help'|'dismissed')=>void;onRead:()=>void;readDone:boolean}){
  const r:DailySafetyReport=published.report, main=r.risks[0], n=r.narrative, nm=r.narrativeMeta;
  const adviceFor=(risk:DailyRisk)=> (r.cards.find(c=>c.type==='action')?.description) || '查看对应历史回放证据，并与安全员核对记录。';
  const items=(n?.items||[]).length?n!.items:(r.risks||[]).slice(0,2).map(rk=>({title:`${rk.eventName||rk.eventType} 值得关注`,observation:`已记录 ${rk.observedCount} 条同类回放事件（${(rk.firstObservedAt||'').slice(0,10)} 至 ${(rk.lastObservedAt||'').slice(0,10)}）。`,advice:adviceFor(rk),evidenceRefs:rk.evidenceRefs}));
  return <div className="stack">
    <div className="dr-hero panel">
      <div className="dr-hero-top"><span>{r.reportDate} · 数据截至 {r.metrics.personalScoreDate||'未取得'}</span><span className="dr-badge">{published.reportVersion>1?`第 ${published.reportVersion} 版`:'已生成'}</span></div>
      <h2 className="dr-greeting">{n?.greeting || (main?`今日简报：${main.eventName||main.eventType}值得关注`:'本期待人工核对数据覆盖')}</h2>
      <p className="dr-analysis">{n?.analysis || r.summary}</p>
      <div className="dr-stats">
        <div className="dr-stat"><span>个人安全评分</span><b>{num(r.metrics.personalScore)}</b><small>{r.metrics.personalScoreDate||'日期未取得'} · 可信度 {confidenceLabel(r.metrics.scoreConfidence)}</small></div>
        <div className="dr-stat"><span>车队平均评分</span><b>{num(r.metrics.fleetAverage)}</b><small>{r.metrics.fleetScoredDrivers!==null?`可比司机 ${r.metrics.fleetScoredDrivers} 人`:'fleet 未取得'} · {r.metrics.fleetDate||'—'}</small></div>
      </div>
      <p className="dr-metabadge">{nm?.generatedBy==='ai'?`AI 生成叙述 · 模型 ${nm.model||'—'} · 数字与证据均取自冻结快照${(nm.attempts||1)>1?'（修复 1 次后通过校验）':''}`:(nm?`规则模板叙述（AI 叙述暂不可用：${nm.ai_status}）`:'规则模板叙述 (未标注来源)')}</p>
    </div>
    {r.scoreTrend&&<TrendChart trend={r.scoreTrend}/>}
    <div className="panel dr-risk"><div className="dr-panel-title"><i aria-hidden="true">⚠</i><h3>本期最值得关注的风险</h3></div>
      {items.length===0&&<p>没有可引用的本人回放事件，暂不作个人风险判断（不等于零风险）。</p>}
      {items.map((it,ix)=><div className="dr-risk-item" key={ix}>
        <b>{it.title}</b><p>{it.observation}</p><p className="dr-advice">建议：{it.advice}</p>
        <details className="meta"><summary>为什么推荐这项核对 · 证据 {it.evidenceRefs.length} 条</summary>
          <p>{r.dailyGoal?.recommendationBasis==='source_score_action'?'建议来源=本人评分快照的推荐动作，且与回放事件维度一致。':'建议依据本人已记录的同类历史回放事件；不是事故预测。'}</p>
          {main&&main.evidenceRefs.length>0&&<DriverEvidence kind="event" id={String(main.evidenceRefs[0]).slice(6)} label="核对首条事件证据"/>}
        </details></div>)}
      {r.cards.filter(c=>c.type==='learning_tip').map(card=><p className="meta" key={card.title}>{card.title}：{card.description}</p>)}
    </div>
    <div className="panel dr-goal">
      <div className="dr-panel-title"><i aria-hidden="true">◎</i><h3>今日改善目标</h3></div>
      <p>{n?.goal || r.dailyGoal?.description || '本期无个人目标：等待新的观测数据或安全员指派。'}</p>
      {r.goalTracking&&<p className="meta">上一期（{r.goalTracking.previousReportDate}）目标：{goalStatusLabel(r.goalTracking.previousStatus)} · {r.goalTracking.newEvidence?'出现新的来源证据，尚不能判断成效':'暂无新的个人证据可判断成效'}。已阅读≠行为改善。</p>}
      <button className="dr-cta" onClick={onRead} disabled={readDone}>{readDone?'今日建议已阅读':'我已阅读今日建议'}</button>
      {goal&&<div className="dr-feedback"><span className="meta">目标反馈（只记录意向）：</span><div className="row"><button className="btn" onClick={()=>onFeedback('will_review')}>计划核对</button><button className="btn" onClick={()=>onFeedback('need_help')}>需要协助</button><button className="btn" onClick={()=>onFeedback('dismissed')}>暂不跟进</button></div></div>}
    </div>
    <div className="panel"><h3>数据限制</h3><p className="meta">统计截至 {r.dataAsOf} · 两期对比 {r.metrics.scoreComparisonStatus==='comparable'?'可比':comparisonLabel(r.metrics.scoreComparisonStatus)} · 覆盖 {r.coverage.observedDates.join('、')||'未取得'}</p><ul>{r.dataLimitations.map(item=><li key={item}>{item}</li>)}</ul></div>
  </div>;
}

export function DailyReportPage({enabled}:{enabled:boolean}){
  const [readDone,setReadDone]=useState(false);
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
  return <div className="stack"><div className="dr-head"><div><h2>每日安全简报</h2><p>今日驾驶表现与风险提示 · 历史回放口径</p></div><span className="dr-bell" aria-label={"未读 " + notes.filter(n => !n.read_at).length + " 条"}>{"\u{1F514}"}{notes.filter(n => !n.read_at).length ? " " + notes.filter(n => !n.read_at).length : ""}</span></div>
    <p className="page-desc">停车或休息时阅读。报告由分析智能体基于本人冻结评分与回放事实生成，不是实时监测。</p>
    <div className="dr-tabs" role="tablist"><button role="tab" aria-selected={mode==='report'} className={mode==='report'?'active':''} onClick={()=>{setSelected(today);setMode('report');}}>今日简报</button><button role="tab" aria-selected={mode==='feed'} className={mode==='feed'?'active':''} onClick={()=>setMode('feed')}>安全动态</button><button role="tab" aria-selected={mode==='history'} className={mode==='history'?'active':''} onClick={()=>setMode('history')}>历史简报</button><button className="dr-refresh" onClick={()=>void load()} aria-label="刷新简报">↻</button></div>
    {error?<Banner tone="warn">读取或保存失败：{error instanceof ApiError?error.code:'network'}。请重试。</Banner>:null}
    {message&&<Banner tone="info">{message}</Banner>}
    {loading&&!history?<EmptyState kind="loading" />:null}
    {!today&&history&&<Banner tone="info">今日尚无已发布简报。历史报告可在“历史简报”中查看。</Banner>}
    {notes.some(n=>!n.read_at)&&<div className="panel"><h3>未读简报通知</h3>{notes.filter(n=>!n.read_at).map(n=><div key={n.notification_id} className="task-card"><b>{n.title||'简报已生成'}</b><p>{n.content}</p><button className="btn" onClick={()=>void readNote(n)}>标记已读并查看简报</button></div>)}</div>}
    {mode==='report'&&shown&&<ReportView published={shown} goal={goals.find(g=>g.reportId===shown.id)||null} onFeedback={code=>void feedback(code)} readDone={readDone} onRead={async()=>{const un=notes.find(x=>!x.read_at&&x.source_entity_id===String(shown.id));if(un){try{await noteRead(un.notification_id);setNotes(prev=>prev.map(row=>row.notification_id===un.notification_id?{...row,read_at:new Date().toISOString()}:row));}catch{}}setReadDone(true);}}/>}
    {mode==='feed'&&<div className="panel"><h3>安全动态</h3>{shown?shown.report.cards.length?shown.report.cards.map(card=><div className="task-card" key={`${shown.id}:${card.priority}`}><b>{card.title}</b><p>{card.description}</p><button className="btn" onClick={()=>setMode('report')}>查看简报与证据</button></div>):<p>当前报告没有可引用的个性化动态。</p>:<p>暂无已发布报告。</p>}</div>}
    {mode==='history'&&<div className="panel"><h3>历史简报</h3>{history?.rows.map(row=><div className="task-card" key={row.id}><b>{row.reportDate} · 版本 {row.reportVersion}</b><p>{row.title}</p><p className="meta">发布于 {row.publishedAt}{row.isCurrent?' · 当日当前版本':''}</p><button className="btn" onClick={()=>void open(row.id)}>查看详情</button></div>)}{history?.rows.length===0&&<p>暂无已发布简报。</p>}<div className="row"><button className="btn" disabled={offset===0} onClick={()=>setOffset(v=>Math.max(0,v-20))}>上一页</button><button className="btn" disabled={!history||offset+history.rows.length>=history.total} onClick={()=>setOffset(v=>v+20)}>下一页</button></div></div>}
  </div>;
}

export function AdminDailyReportPanel({localOnly}:{localOnly:boolean}){
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const [driverId,setDriverId]=useState(''),[date,setDate]=useState(today),[revise,setRevise]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState('');
  const [jobs,setJobs]=useState<DailyReportJobs|null>(null),[failedJobs,setFailedJobs]=useState<DailyReportJobs['rows']>([]);
  async function refreshJobs(){const [summary,failed]=await Promise.all([adminDailyReportJobs(date),adminDailyReportJobs(date,'failed')]);setJobs(summary);setFailedJobs(failed.rows);}
  useEffect(()=>{let live=true;const refresh=()=>{if(document.visibilityState==='hidden')return;Promise.all([adminDailyReportJobs(date),adminDailyReportJobs(date,'failed')]).then(([summary,failed])=>{if(live){setJobs(summary);setFailedJobs(failed.rows);}}).catch(()=>{if(live)setJobs(null);});};refresh();const timer=setInterval(refresh,60000);document.addEventListener('visibilitychange',refresh);return()=>{live=false;clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};},[localOnly,date]);
  async function run(){if(busy)return;setBusy(true);setError('');setResult('');try{const saved=await adminDailyReportRun(driverId.trim(),date,revise);setResult(`${saved.report.reportDate} · ${saved.report.driverId} · 版本 ${saved.reportVersion} · ${saved.idempotentReplay?'已有同一来源报告':'已发布'} · 通知 ${saved.notificationCount} 条`);}catch(e){setError(e instanceof ApiError?e.code:'network');}finally{setBusy(false);}}
  return <div className="panel"><h2>每日安全简报</h2><p>本地工作台每天上海时间 07:00 后自动生成来源司机的历史安全简报，关闭司机页面仍会继续。此处可手动生成、查看任务进度；不使用外部模型或实时监测数据。</p>
    {<><div className="row"><label>来源司机 ID <input value={driverId} onChange={e=>setDriverId(e.target.value)} placeholder="例如 DEMO_D0149" /></label><label>报告日期 <input type="date" value={date} max={today} onChange={e=>setDate(e.target.value)} /></label></div><label><input type="checkbox" checked={revise} onChange={e=>setRevise(e.target.checked)} /> 来源变化时允许创建新版本</label><div><button className="btn primary" disabled={busy||!driverId.trim()||!date} onClick={()=>void run()}>{busy?'正在生成…':'生成并发布'}</button></div></>}
    {result&&<Banner tone="info">{result}</Banner>}{error&&<Banner tone="warn">生成失败：{error}</Banner>}
    {<div className="task-card"><h3>{date} 自动任务</h3>{jobs?<><p>总数 {jobs.total} · 已完成 {jobs.byStatus.succeeded||0} · 待处理 {jobs.byStatus.pending||0} · 处理中 {jobs.byStatus.running||0} · 失败 {jobs.byStatus.failed||0}</p>{failedJobs.slice(0,10).map(row=><p className="meta" key={row.id}>{row.driver_id} · 尝试 {row.attempts} 次 · {row.finished_at||'未完成'}：{row.error_message||'生成失败'}</p>)}</>:<p>任务状态读取中或暂不可用。</p>}<button className="btn" onClick={()=>void refreshJobs().catch(()=>setJobs(null))}>刷新任务状态</button></div>}
  </div>;
}
