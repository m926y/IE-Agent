import {useEffect,useState} from 'react';
import {api,myNotes,noteRead,type NoteRow} from './api';
type Todo={id:string;title:string;vehicle:string;due_at?:string;route:string};
const go=(route:string)=>{if(route.startsWith('driver:'))window.dispatchEvent(new CustomEvent('claw:driver-nav',{detail:route.slice(7)}));else location.hash=route};
type TodoFull=Todo&{kind?:string;urgent?:boolean;is_replay?:boolean;created_at?:string|null;bucket?:string|null};
const KIND_CN:Record<string,string>={risk:'风险处置',training:'培训',review:'评分异议',quality:'数据核验',response:'提醒回应',followup:'处置跟进',offline:'线下培训',handover:'交接班',goal:'司机求助'};
const KIND_MARK:Record<string,string>={risk:'⚠',training:'✎',review:'≡',quality:'◌',response:'↩',followup:'⟳',offline:'▣',handover:'⇄',goal:'✚'};
const bjToday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
/* 排序与紧迫感只用于提示顺序，不改变任何业务时限；逾期=截止日已过期，紧迫=3 天内到期 */
function urgencyOf(t:TodoFull){
  const due=String(t.due_at||'').slice(0,10);
  if(!due) return {rank:3,tone:'',label:'待处理'};
  const today=bjToday();
  if(due<today) return {rank:0,tone:'overdue',label:'已逾期 '+Math.max(1,Math.round((Date.parse(today+'T00:00:00Z')-Date.parse(due+'T00:00:00Z'))/86400000))+' 天'};
  if(due===today) return {rank:1,tone:'today',label:'今天截止'};
  const days=Math.round((Date.parse(due+'T00:00:00Z')-Date.parse(today+'T00:00:00Z'))/86400000);
  if(days<=3) return {rank:2,tone:'soon',label:`还有 ${days} 天`};
  return {rank:2,tone:'',label:'截止 '+due};
}
export function DriverTodos(){
  const [rows,setRows]=useState<TodoFull[]>([]),[error,setError]=useState(''),[ready,setReady]=useState(false);
  const FOLD_KEY='claw_driver_todo_folded',[folded,setFolded]=useState(()=>{try{return localStorage.getItem(FOLD_KEY)==='1'}catch{return false}});
  const setFold=(v:boolean)=>{setFolded(v);try{if(v)localStorage.setItem(FOLD_KEY,'1');else localStorage.removeItem(FOLD_KEY)}catch{}};
  useEffect(()=>{let alive=true;const load=()=>api<{todos:TodoFull[]}>('/api/center/data').then(r=>{if(alive){setRows(r.todos);setError('');setReady(true)}}).catch(()=>{if(alive)setError('待办读取失败，请稍后重试')});void load();const timer=setInterval(load,15000);window.addEventListener('claw:center-refresh',load);return()=>{alive=false;clearInterval(timer);window.removeEventListener('claw:center-refresh',load)}},[]);
  const withMeta=rows.map(t=>({...t,u:urgencyOf(t)})).sort((a,b)=>a.u.rank-b.u.rank||String(a.due_at||'9999').localeCompare(String(b.due_at||'9999')));
  const overdue=withMeta.filter(x=>x.u.tone==='overdue').length, todayDue=withMeta.filter(x=>x.u.tone==='today').length;
  const priority=withMeta.filter(x=>x.u.rank<=1), rest=withMeta.filter(x=>x.u.rank>1);
  const item=(x:TodoFull&{u:ReturnType<typeof urgencyOf>})=><button key={x.id} className={'dt-item'+(x.u.tone?' dt-'+x.u.tone:'')} onClick={()=>go(x.route)}>
      <span className="dt-mark" aria-hidden="true">{KIND_MARK[x.kind||'']||'●'}</span>
      <span className="dt-body"><b>{x.title}</b><small>{[KIND_CN[x.kind||'']||'待办',x.vehicle].filter(Boolean).join(' · ')}{x.is_replay?' · 历史回放':''}</small></span>
      <span className="dt-due">{x.u.label}</span><span className="dt-go" aria-hidden="true">›</span>
    </button>;
  return <div className={'driver-todo'+(folded?' is-folded':'')}>
    <div className="dt-head">
      <div className="dt-count" role="status">
        <b>{rows.length}</b><span>项待办</span>
        {overdue>0&&<em className="dt-chip dt-chip-overdue">逾期 {overdue}</em>}
        {todayDue>0&&<em className="dt-chip dt-chip-today">今天 {todayDue}</em>}
      </div>
      {rows.length>0&&<button type="button" className="dt-fold" aria-label={folded?'展开待办列表':'一键收起待办列表'} aria-expanded={!folded} aria-controls="driver-todo-items" onClick={()=>setFold(!folded)}>{folded?'展开全部':'一键收起'}<i aria-hidden="true">{folded?'⌄':'⌃'}</i></button>}
    </div>
    {error&&<div className="dt-error" role="alert"><span>{error}</span><button className="btn" onClick={()=>{setError('');setReady(false);void api<{todos:TodoFull[]}>('/api/center/data').then(r=>{setRows(r.todos);setReady(true)}).catch(()=>setError('待办读取失败，请稍后重试'))}}>重试</button></div>}
    {!ready&&!error&&<div className="dt-skeleton" aria-hidden="true"><i/><i/><i/></div>}
    {ready&&!rows.length&&!error&&<div className="dt-empty"><span aria-hidden="true">✓</span><p>暂无待办任务</p><small>有新任务或司机会话需要回应时会出现在这里。</small></div>}
    {folded&&rows.length>0?<button type="button" className="dt-collapsed" aria-controls="driver-todo-items" onClick={()=>setFold(false)}>
      <span>已收起 {rows.length} 项{overdue?` · 逾期 ${overdue} 项`:''}{todayDue?` · 今天 ${todayDue} 项`:''}</span>
      <small>收起只是隐藏列表，不延长任何截止时间</small>
    </button>:<div id="driver-todo-items">
      {priority.length>0&&<div className="dt-group"><h4>优先处理 · {priority.length}</h4>{priority.map(item)}</div>}
      {rest.length>0&&<div className="dt-group"><h4>其它待办 · {rest.length}</h4>{rest.map(item)}</div>}
    </div>}
  </div>}

export function DriverNotifications(){const [contacts,setContacts]=useState<{id:string;name:string;role:string;unread:number;last?:{content:string}}[]>([]),[notes,setNotes]=useState<NoteRow[]>([]),[showNotes,setShowNotes]=useState(false),[error,setError]=useState('');useEffect(()=>{let alive=true;const load=async()=>{try{const [c,n]=await Promise.all([api<{contacts:typeof contacts}>('/api/chat/contacts'),myNotes()]);if(alive){setContacts(c.contacts);setNotes(n.rows);setError('')}}catch{if(alive)setError('通知读取失败，请稍后重试')}};void load();const timer=setInterval(load,5000);return()=>{alive=false;clearInterval(timer)}},[]);return <section className="driver-notifications"><h2>通知</h2>{error&&<p role="alert">{error}</p>}{showNotes?<><button className="btn driver-back-icon" aria-label="返回通知" onClick={()=>setShowNotes(false)}>←</button><h3>任务与系统通知</h3>{notes.map(n=><article key={n.notification_id}><h4>{n.title||'通知'}</h4><p>{n.content}</p><small>{new Date(n.created_at).toLocaleString('zh-CN')}</small>{!n.read_at&&<button className="btn" onClick={async()=>{await noteRead(n.notification_id);setNotes((await myNotes()).rows)}}>标为已读</button>}</article>)}{!notes.length&&<p>暂无通知</p>}</>:<div className="driver-contact-list"><button onClick={()=>setShowNotes(true)}><span className="contact-avatar">铃</span><div><strong>任务与系统通知</strong><p>{notes[0]?.content||'暂无新通知'}</p></div>{notes.some(n=>!n.read_at)&&<b>{notes.filter(n=>!n.read_at).length}</b>}</button>{contacts.map(c=><button key={c.id} onClick={()=>window.dispatchEvent(new CustomEvent('claw:message-peer',{detail:c.id}))}><span className="contact-avatar">{c.name.slice(0,1)}</span><div><strong>{c.name}</strong><p>{c.last?.content||'点击开始沟通'}</p></div>{c.unread>0&&<b>{c.unread}</b>}</button>)}</div>}</section>}
