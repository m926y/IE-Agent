import { useEffect, useState } from 'react';
import { api, ApiError } from './api';

export type AgentArtifact={id:string;title:string;period:{start:string;end:string};summary:{count:number;average:number;d_count:number;low_count:number};downloads:{format:string;url:string}[]};
export type AgentPlan={id:string;kind:string;state:string;count:number;selected_count?:number;expires_at:string;course_title?:string;due_at?:string;title?:string;note?:string;rows:Record<string,unknown>[];skipped?:{vehicle:string;reason:string}[];role_counts?:Record<string,number>;result?:AgentExecution};
type OneTimeCredential={username:string;display_name?:string;role:string;initial_password:string;vehicle?:string};
type AgentExecution={ok:boolean;kind:string;count:number;requested?:number;credentials_id?:string;course_id?:string;partial?:boolean;stopped_at?:{username:string;reason:string};skipped?:{vehicle:string;reason:string}[];one_time_credentials?:OneTimeCredential[];note?:string;idempotent_replay?:boolean};
export function agentError(e:unknown){const code=e instanceof ApiError?e.code:'';return ({agent_forbidden:'当前账号无权使用该功能',agent_global_admin_required:'批量操作需要全部车队权限的安全管理员',agent_confirmation_required:'请先检查操作清单再确认',agent_plan_expired:'清单已过期，请重新生成',agent_score_version_changed:'评分版本已更新，请重新生成清单',agent_service_unavailable:'当前部署未配置报告及批量事务服务',agent_no_data_for_date:'该日期没有真实评分，请选择有数据的周期',agent_no_eligible_targets:'没有可执行对象，请先查看排除原因',course_not_approved:'课程尚未通过审核，不能分配',course_changed:'课程版本或审核状态已变化，请重新生成清单',driver_binding_changed:'司机绑定已变更，请重新生成清单',training_already_assigned:'已有相同课程的进行中任务，请重新预览',vehicle_already_bound:'车辆已被其他账号绑定，整批操作未执行，请重新检查',vehicle_mapping_changed:'车辆映射已变更，请重新上传预览',username_exists:'用户名已存在，请修改表格后重新上传',credentials_expired_or_consumed:'初始密码文件已下载或超过一小时有效期',credentials_not_stored:'云端不留存初始口令文件：本轮结果已一次性显示，错过请到「账号与角色」重置密码',account_create_failed:'账号创建失败，请核对已有账号后重新生成清单',training_details_required:'请先确定具体课程、接收对象和截止日期',course_draft_invalid:'课程草稿内容不完整，请重新生成',agent_scope_changed:'当前账号的车队范围已变化，本清单不可执行',forbidden_plan_owner:'只能执行本人创建的清单',agent_local_routes:'该清单来自本地完整数据工作台的接口，请在对应入口执行',agent_transaction_failed:'保存失败，整批操作已回滚，请重试'} as Record<string,string>)[code]||('操作未完成'+(code?'：'+code:''));}
function saveBlob(blob:Blob,name:string){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
async function download(url:string,name:string){const r=await fetch(url,{credentials:'same-origin',cache:'no-store'});if(!r.ok){let code='download_failed';try{code=(await r.json()).error||code;}catch{}throw new Error(code);}saveBlob(await r.blob(),name);}
export function AgentReportCard({artifact}:{artifact:AgentArtifact}){const [error,setError]=useState('');return <div className="agent-report-card"><b>周报文件</b><div className="meta">{artifact.period.start}—{artifact.period.end} · {artifact.summary.count} 辆车</div><div className="agent-mini-metrics"><span>均分 <strong>{artifact.summary.average??'—'}</strong></span><span>D级 <strong>{artifact.summary.d_count}</strong></span><span>低可信 <strong>{artifact.summary.low_count}</strong></span></div><div className="row"><a className="btn" href={artifact.downloads.find(d=>d.format==='html')?.url+'&preview=1'} target="_blank" rel="noopener noreferrer">预览周报</a>{artifact.downloads.map(d=><button className="btn" key={d.format} onClick={()=>{setError('');download(d.url,artifact.title+'.'+d.format).catch(()=>setError('下载失败或当前登录已失效，请重新生成报告'));}}>下载 {d.format==='md'?'Markdown':'HTML'}</button>)}</div>{error&&<div role="alert">{error}</div>}</div>;}
export function AgentActionCard({initial}:{initial:AgentPlan}){
  const [plan,setPlan]=useState(initial),[busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<AgentExecution|undefined>(initial.result),[downloaded,setDownloaded]=useState(false);
  useEffect(()=>{api<AgentPlan>('/api/agent/plan?id='+encodeURIComponent(initial.id)).then(r=>{setPlan(r);setResult(r.result);}).catch(e=>setError(agentError(e)));},[initial.id]);
  const title=plan.kind==='accounts'?'批量创建账号':plan.kind==='course'?'创建培训课程草稿':'创建培训任务';
  const [credsSeen,setCredsSeen]=useState(false);
  async function execute(){setBusy(true);setError('');try{const r=await api<AgentExecution>('/api/agent/execute',{method:'POST',body:JSON.stringify({plan_id:plan.id,confirm:true})});setResult(r);setPlan(p=>({...p,state:'complete'}));window.dispatchEvent(new CustomEvent('claw:agent-applied',{detail:{kind:r.kind}}));}catch(e){setError(agentError(e));}finally{setBusy(false);}}
  return <div className="agent-action-card"><b>{title}</b><div className="meta">{plan.course_title||plan.title||''}{plan.due_at?' · 截止 '+plan.due_at:''}</div><p>{result?`已完成 ${result.count} 项${result.idempotent_replay?'（重复请求复用结果）':''}`:`待执行 ${plan.count} 项${plan.selected_count!==undefined?' / 选中 '+plan.selected_count+' 辆车':''}`}</p>
    {plan.role_counts&&<p className="meta">司机 {plan.role_counts.driver} · 队长 {plan.role_counts.team_leader} · 安全管理员 {plan.role_counts.safety_admin}</p>}
    <details><summary>查看完整清单（{plan.rows?.length||0}项）</summary><div className="agent-plan-rows">{(plan.rows||[]).map((r,i)=><div key={i}>{Object.entries(r).map(([k,v])=><span key={k}>{({username:'账号',display_name:'显示名',role:'角色',vehicle:'对应车辆',mandatory:'强制',title:'标题',content:'内容',dimension:'维度',completion_requirement:'完成条件'} as Record<string,string>)[k]||k}：{String(v)}； </span>)}</div>)}</div></details>
    {!!plan.skipped?.length&&<details><summary>未纳入执行：{plan.skipped.length} 辆</summary>{plan.skipped.map((r,i)=><div className="meta" key={i}>{r.vehicle}：{r.reason}</div>)}</details>}
    {!result&&<><p className="meta">{plan.note||'确认后写入业务数据，操作留痕；重复请求不会重复创建。'}</p><button className="btn primary" disabled={busy||plan.count===0||plan.state==='complete'} onClick={execute}>{busy?'正在执行…':`确认${title}（${plan.count}项）`}</button></>}
    {result?.course_id&&<div className="meta">课程 {result.course_id} 已保存为待审核草稿：须在课程中心提交审核并通过后才能分配，AI与清单确认都不会自动批准。</div>}
    {!!result?.skipped?.length&&<details><summary>本轮未创建：{result.skipped.length} 个对象</summary>{result.skipped.map((r,i)=><div className="meta" key={i}>{r.vehicle}：{r.reason}</div>)}</details>}
    {result?.partial&&<div className="alert warn" role="alert">云端逐条写入、无跨行事务：已创建 {result.count}/{result.requested} 项后中断{result.stopped_at?`（${result.stopped_at.username}：${result.stopped_at.reason}）`:''}。请核对账号管理后重新生成清单，不要重复确认同一批次。</div>}
    {!!result?.one_time_credentials?.length&&<AgentCredentials items={result.one_time_credentials}/>}
    {result?.credentials_id&&<><p className="meta">初始密码文件仅操作人可下载一次，一小时内有效；新司机账号尚未绑定车辆。</p><button className="btn" disabled={downloaded} onClick={()=>{download('/api/agent/credentials?id='+encodeURIComponent(result.credentials_id!), '账号初始密码.csv').then(()=>setDownloaded(true)).catch(e=>setError(e.message==='credentials_expired_or_consumed'?'密码文件已下载或过期':'下载未完成，请重试'));}}>{downloaded?'密码文件已下载':'下载一次性初始密码文件'}</button></>}
    {error&&<div className="alert warn" role="alert">{error}</div>}
  </div>;
}

/* R60：初始口令只在确认执行的那次响应里出现（云端不留存口令文件），故由浏览器即时渲染并允许本地另存一份。 */
const ROLE_CN:Record<string,string>={driver:'司机',team_leader:'队长',safety_admin:'安全管理员',safety_officer:'安全员'};
export function AgentCredentials({items}:{items:OneTimeCredential[]}){
  function save(){const head=['用户名','显示名','角色','初始密码（首次登录须修改）','对应车辆'];const rows=[head,...items.map(c=>[c.username,c.display_name||'',ROLE_CN[c.role]||c.role,c.initial_password,c.vehicle||'未绑定'])];saveBlob(new Blob([rows.map(r=>r.map(v=>'"'+String(v??'').replace(/"/g,'""')+'"').join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),'账号初始密码.csv');}
  return <div className="agent-credentials">
    <div className="meta"><b>初始口令（仅此一次显示，服务端不留存）</b> · 首次登录须修改</div>
    <div className="agent-plan-rows">{items.map((c,i)=><div key={c.username||i}><span>{c.username}</span><span>{c.display_name||''}</span><span>{ROLE_CN[c.role]||c.role}</span><span>{c.initial_password}</span><span>{c.vehicle||'未绑定'}</span></div>)}</div>
    <button className="btn" onClick={save}>下载一次性口令表</button>
    <p className="meta">关闭本卡片或刷新后无法再次取得；遗漏的账号请到「账号与角色」重置密码。云端不生成服务器端口令文件。</p>
  </div>;
}


// Parse values only. Formulas/macros are never executed; backend validates all rows again.
export function csvCells(text:string){const rows:string[][]=[];let row:string[]=[],cell='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(cell);cell='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell='';}else cell+=c;}if(quoted)throw new Error('CSV引号不完整');if(cell||row.length){row.push(cell);rows.push(row);}return rows;}
export function accountRows(cells:unknown[][]){
  const clean=cells.filter(r=>r.some(c=>c!==null&&c!==undefined&&String(c).trim()!==''));if(clean.length<2||clean.length>201)throw new Error('请上传1–200行账号数据，另加一行表头');
  const names:Record<string,string>={'用户名':'username','账号':'username','username':'username','显示名':'display_name','姓名':'display_name','display_name':'display_name','角色':'role','role':'role','对应车辆':'vehicle','车辆':'vehicle','车辆编号':'vehicle','vehicle':'vehicle'};
  const headers=clean[0].map(c=>names[String(c??'').replace(/^\ufeff/,'').trim().toLowerCase()]);if(![3,4].includes(headers.length)||new Set(headers).size!==headers.length||headers.some(h=>!h)||!['username','display_name','role'].every(h=>headers.includes(h)))throw new Error('表头须包含：用户名、显示名、角色；可添加对应车辆，不要上传密码列。');
  const roles:Record<string,string>={'司机':'driver','安全员':'safety_officer','安全管理员':'safety_admin','队长':'team_leader'};
  return clean.slice(1).map(r=>{if(r.slice(headers.length).some(v=>v!=null&&String(v).trim()!==''))throw new Error('存在多余列，请使用账号模板');const o=Object.fromEntries(headers.map((h,i)=>[h,String(r[i]??'').trim()]));o.role=roles[o.role]||o.role||'driver';return o;});
}
export function AgentAccountUpload({onPlan,disabled}:{onPlan:(p:AgentPlan)=>void;disabled?:boolean}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function fileRead(file:File){setBusy(true);setError('');try{if(file.size>2*1024*1024)throw new Error('账号表须小于2MB');let cells:unknown[][];if(/\.xlsx$/i.test(file.name)){const {readSheet}=await import('read-excel-file/universal');cells=await readSheet(file);}else if(/\.csv$/i.test(file.name))cells=csvCells(await file.text());else throw new Error('请使用.xlsx或UTF-8 CSV文件');const rows=accountRows(cells);const r=await api<AgentPlan&{valid:boolean;errors?:{row:number;reason:string}[]}>('/api/agent/accounts/preview',{method:'POST',body:JSON.stringify({rows})});if(!r.valid)throw new Error(r.errors?.map(x=>`第${x.row}行：${x.reason}`).join('；')||'校验未通过');onPlan(r);}catch(e){setError(e instanceof ApiError?agentError(e):e instanceof Error?e.message:'文件读取失败');}finally{setBusy(false);}}
  return <div className="agent-upload"><div className="row"><label className="btn">{busy?'校验中…':'上传Excel账号表'}<input type="file" accept=".xlsx,.csv" disabled={busy||disabled} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void fileRead(file);}} style={{display:'none'}}/></label><button className="btn" disabled={busy} onClick={async()=>{const {accountTemplateBytes}=await import('./account-template');const b=accountTemplateBytes();saveBlob(new Blob([new Uint8Array(b).buffer],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),'账号导入模板.xlsx');}}>下载Excel模板</button></div>{error&&<div className="alert warn" role="alert">{error}</div>}</div>;
}

export function AgentAccountImportPanel(){const [plan,setPlan]=useState<AgentPlan|null>(null);return <section className="panel stack"><h3>Excel批量添加账号</h3><AgentAccountUpload onPlan={setPlan}/>{plan&&<AgentActionCard key={plan.id} initial={plan}/>}</section>;}
