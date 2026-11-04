import type {CaseActionData,CaseActionOptions} from './risk-actions';
import {createContext,useContext,useEffect,useState} from 'react';
import type {ReactNode} from 'react';
import {api,ApiError} from './api';
import type {MeUser} from './api';
import './risk-monitor.css';

type Replay={config:{episode_gap_seconds:number;prompt_merge_seconds:number;red_response_seconds:number};id:string;date:string;clock:string;status:string;speed:number;parking:number;can_control:boolean;vehicles:string[];error?:string};
type Evidence={event_id:string;event_time:string;received_at:string;event_type:number;event_name:string;speed:number|null};
type RiskCase={merged_cases?:{id:string;status:string;first_event_time:string;last_event_time:string}[];alarm_records?:{event_id:string;event_time:string;event_name:string;case_id:string}[];historical_duty?:{display_name:string;source:string}|null;action_state?:CaseActionData;action_options?:CaseActionOptions;training_eligible:boolean;version:string;can_handle:boolean;id:string;replay_session_id:string;vehicle:string;gpsno:string;driver_id:string|null;target_user_id:string|null;title:string;message:string;level:string;shadow:number;status:string;first_event_time:string;last_event_time:string;event_count:number;episode_count:number;feedback?:string;intervention?:string;review_note?:string;ack_at?:string;escalated_at?:string;parking:boolean;session_status:string;course_id?:string;review_decision?:string;windows:Record<string,number>;baseline_status:string;video_status:string;delivery?:{status:string;received_at?:string;read_at?:string};evidence:Evidence[]};
type ReplayEvent={event_id:string;replay_session_id:string;gpsno:string;event_time:string;event_name:string;event_type:number;speed:number|null;warning:{case_id:string;level:string;shadow:boolean;title:string}|null};
const readableTime=(value:string)=>value?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value))+'（北京时间）':'—';
type Live={case_group_total?:number;event_total?:number;events?:ReplayEvent[];offset:number;sessions:Replay[];cases:RiskCase[];stats:{total:number;red:number;orange:number;pending:number;shadow:number};limited:boolean;notice:string};
const RiskContext=createContext<{live:Live|null;error:string;refresh:()=>Promise<void>}>({live:null,error:'',refresh:async()=>{}});
const levels:Record<string,string>={red:'红色 · 优先核实',orange:'橙色 · 重点关注',tip:'安全提示',gray:'灰色 · 数据质量'};
const states:Record<string,string>={pending_review:'待复核',confirmed:'已确认',closed:'已关闭',playing:'播放中',paused:'已暂停',completed:'播放结束',stopped:'已结束'};
function errorText(e:unknown){const c=e instanceof ApiError?e.code:'network';return ({risk_session_already_active:'已有未结束的回放，请先结束旧回放。',risk_no_events_for_date:'该日期所选车辆没有历史事件。',risk_local_data_required:'此功能需要启动本地完整数据服务。',risk_review_and_action_required:'关闭前请完成复核并记录处置措施。',risk_driver_feedback_required:'关闭前需要司机停车后反馈。',risk_confirm_first:'请先确认风险，再记录干预。',risk_parking_required:'请先暂停回放并启用演示停车信号，再由司机反馈。',risk_session_ended:'本次回放已结束，请新建回放。',risk_review_note_required:'请填写核查依据或处置意见。',risk_binding_required:'当前账号尚未核实车辆绑定。',risk_actions_pending:'仍有未完成的处置跟进或培训任务，请落实并复核后关闭。',risk_action_binding_changed:'司机绑定已变化，请重新核验后发送。',risk_forbidden:'当前账号无操作权限。',risk_date_invalid:'请选择有效日期。'} as Record<string,string>)[c]||`未完成（${c}）`;}
export function RiskMonitorProvider({user,children}:{user:MeUser;children:ReactNode}){
 const [live,setLive]=useState<Live|null>(null),[error,setError]=useState('');
 async function refresh(){try{setLive(await api<Live>('/api/risk/live'));setError('')}catch(e){setError(errorText(e))}}
 useEffect(()=>{let active=true,busy=false;const load=async()=>{if(busy)return;busy=true;try{const r=await api<Live>('/api/risk/live');if(active){setLive(r);setError('')}}catch(e){if(active)setError(errorText(e))}finally{busy=false}};void load();const timer=setInterval(load,2000);return()=>{active=false;clearInterval(timer)}},[user.userId,user.driverId,user.bindingVerified]);
 return <RiskContext.Provider value={{live,error,refresh}}>{children}</RiskContext.Provider>
}
export function RiskAlertBar({driver=false}:{driver?:boolean}){
 const {live,error}=useContext(RiskContext);
 if(error)return <div className="risk-status-error">风险消息连接异常 · {error}</div>;
 if(!live?.sessions.length)return null;
 const open=live.cases.filter(c=>c.status!=='closed'),c=open[0],running=live.sessions.find(s=>s.status==='playing')||live.sessions[0];
 if(driver)return <aside className={`risk-global risk-${c?.level||'gray'}`} aria-label="司机风险预警" aria-live="polite"><b>历史回放 · {running.clock.slice(11,19)}</b><span>{c?c.message:'暂无新的风险提醒'}</span><small>请在安全停车后查看与反馈</small></aside>;
 return <aside className={`risk-global risk-${live.stats.red?'red':live.stats.orange?'orange':'tip'}`} aria-label="管理端风险消息栏" aria-live="polite"><div><b>历史回放预警</b><span>待复核 {live.stats.pending} · 红色 {live.stats.red}</span></div><span>{c?`${c.vehicle} · ${c.title}${c.escalated_at?' · 响应超时':''}`:'时钟就绪，等待历史事件触发'}</span><a href={"#/rm-replay"}>查看历史回放 →</a></aside>
}
export function DriverLiveRisks(){
 const {live,error,refresh}=useContext(RiskContext),[text,setText]=useState<Record<string,string>>({}),[msg,setMsg]=useState(''),[busy,setBusy]=useState(false);
 async function feedback(c:RiskCase){setBusy(true);try{await api('/api/risk/feedback',{method:'POST',body:JSON.stringify({case_id:c.id,feedback:text[c.id]})});setMsg('反馈已保存，等待管理员复查。');await refresh()}catch(e){setMsg(errorText(e))}finally{setBusy(false)}}
 return <section className="stack"><h3>回放风险预警</h3>{error&&<p role="alert">{error}</p>}{!live?.cases.length&&<p className="meta">暂无本人绑定车辆已触发的回放预警。</p>}{live?.cases.map(c=><article key={c.id} className={`panel risk-driver-card risk-${c.level}`}><h4>{c.title}</h4><p>{c.message}</p><small>历史回放 {new Date(c.last_event_time).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})} · {states[c.status]}</small>{c.parking&&c.session_status!=='playing'?<><p className="meta">停车后可提交处理情况。</p>{c.intervention&&<p>管理员处置：{c.intervention}</p>}{c.status!=='closed'&&<><textarea aria-label={`停车后反馈 ${c.id}`} placeholder="如：已休息、设备异常、存在误报；说明具体情况" value={text[c.id]??c.feedback??''} onChange={e=>setText(v=>({...v,[c.id]:e.target.value}))}/><button className="btn" disabled={busy||!text[c.id]?.trim()} onClick={()=>void feedback(c)}>提交停车后反馈</button></>}{c.feedback&&<p>已记录：{c.feedback}</p>}</>:<p className="meta">停车前仅展示简短提醒，不要求操作或确认。</p>}</article>)}{msg&&<p role="status">{msg}</p>}</section>
}
