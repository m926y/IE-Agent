import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { startLocalWorkbench } from "../scripts/local-workbench.mjs";
import { openLocalStore } from "../scripts/local-data-store.mjs";
import { finiteNumber, fleetStatistics } from "../server/driver-actions.mjs";

// All business rows come from IE亮剑 CSVs. Tests create only workflow actions/technical accounts.
test("round nine authorized read-only action projections", async t => {
  const parent=fileURLToPath(new URL('../.source-tests/',import.meta.url));await mkdir(parent,{recursive:true});
  const work=await startLocalWorkbench({directory:await mkdtemp(join(parent,'round-nine-')),pauseOutbox:true});
  t.after(()=>work.stop());
  async function login(name){const a=work.store.accounts.find(x=>x.username===name);const r=await fetch(work.base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(a)});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];}
  const driver=await login('local_driver'),other=await login('local_other'),admin=await login('local_admin');
  async function req(path,cookie=driver,method='GET',body){const r=await fetch(work.base+path,{method,headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,data:await r.json()};}
  const account=work.store.get('app_users','local_driver'),ownHistory=work.store.rows('score_history').filter(x=>x.driver_id===account.driver_id).sort((a,b)=>b.as_of_date.localeCompare(a.as_of_date));
  const score=work.store.rows('score_snapshots').find(x=>x.driver_id===account.driver_id),course=work.store.rows('training_courses')[0];
  const facts=JSON.stringify(['drivers','score_snapshots','score_history','replay_events','deduction_ledger'].map(x=>work.store.rows(x)));
  let taskId;
  await t.test('clean action counts and timeline expose only own explicit facts, never management audits',async()=>{
    const audits=JSON.stringify(work.store.rows('audit_logs'));
    work.faults.beforeRead=({table,query})=>{if(table==='audit_logs')throw Error('Management audit must never feed driver timeline');if(['training_tasks','interventions','review_requests','score_history','replay_events','alerts','score_snapshots'].includes(table))assert.equal(query.get('driver_id'),`eq.${account.driver_id}`);};
    let r;try{r=await req('/api/driver/action-center?driver_id=other');}finally{delete work.faults.beforeRead;}
    assert.equal(r.status,200);assert.equal(r.data.counts.training_pending,0);assert.equal(r.data.counts.review_open,0);assert.equal(r.data.as_of_date,score.as_of_date);
    assert.ok(r.data.timeline.every(x=>x.source_kind==='score_history'||x.source_kind==='event'));
    const ownIds=new Set([...ownHistory,...work.store.rows('replay_events').filter(x=>x.driver_id===account.driver_id)].map(x=>x.score_id||x.event_id));
    assert.ok(r.data.timeline.every(x=>ownIds.has(x.source_id)));
    assert.doesNotMatch(JSON.stringify(r.data),/actor_id|audit_id|created_by|draft_text|password|driver_id/);
    assert.equal(JSON.stringify(work.store.rows('audit_logs')),audits);
  });
  await t.test('stable cursor pages cover all real nodes, reject malformed input and remain identity scoped',async()=>{
    const expected=(await req('/api/driver/action-center?limit=50')).data.timeline.map(x=>x.event_id),seen=[];
    let cursor;do{const r=await req('/api/driver/action-center?limit=1'+(cursor?'&cursor='+encodeURIComponent(cursor):''));assert.equal(r.status,200);seen.push(...r.data.timeline.map(x=>x.event_id));cursor=r.data.pagination.next_cursor;}while(cursor);
    assert.deepEqual(seen,expected);assert.equal(new Set(seen).size,seen.length);
    const first=await req('/api/driver/action-center?limit=1');
    assert.equal((await req('/api/driver/action-center?cursor='+first.data.pagination.next_cursor,other)).data.error,'action_center_changed');
    for(const query of ['limit=0','limit=-1','limit=51','limit=abc','cursor=***'])assert.equal((await req('/api/driver/action-center?'+query)).status,400);
  });
  await t.test('score comparison uses actual owned periods, windows, versions and missing numeric semantics',async()=>{
    const r=await req('/api/driver/score-comparison');assert.equal(r.status,200);
    assert.equal(r.data.after.score_id,ownHistory[0].score_id);assert.equal(r.data.before.as_of_date,ownHistory.find(x=>x.as_of_date<ownHistory[0].as_of_date).as_of_date);
    assert.equal(r.data.after.window_start,ownHistory[0].window_start);assert.equal(r.data.after.source_version,ownHistory[0].source_version);
    assert.match(r.data.limitations,/暴露量/);
    if(r.data.difference!==null)assert.equal(r.data.difference,Number((finiteNumber(r.data.after.safety_score)-finiteNumber(r.data.before.safety_score)).toFixed(4)));
    const foreign=work.store.rows('score_history').find(x=>x.driver_id!==account.driver_id);
    assert.equal((await req(`/api/driver/score-comparison?before_id=${foreign.score_id}&after_id=${ownHistory[0].score_id}`)).status,404);
    assert.equal((await req(`/api/driver/score-comparison?before_id=${ownHistory[0].score_id}&after_id=${ownHistory.at(-1).score_id}`)).status,400);
    assert.equal((await req('/api/driver/score-comparison?before_id=missing')).status,400);
    for(const value of [null,undefined,'',' ',false,true,Infinity,'NaN',{},[]])assert.equal(finiteNumber(value),null);
    assert.equal(finiteNumber(0),0);
    assert.doesNotMatch(JSON.stringify(r.data),/driver_id|gpsno/);
  });
  await t.test('full pending totals exceed the timeline page; changes invalidate old cursors',async()=>{
    for(const next of ['pending_review','approved'])assert.equal((await req('/api/admin/course-review',admin,'POST',{course_id:course.course_id,new_status:next,note:'隔离第九轮流程测试，非专业审批证明'})).status,200);
    for(let i=0;i<25;i++){const result=await req('/api/admin/training-assign',admin,'POST',{course_id:course.course_id,driver_id:account.driver_id,goal:course.completion_requirement,idempotency_key:'r9-count-'+i});assert.equal(result.status,200);taskId=result.data.task_id;}
    const first=await req('/api/driver/action-center?limit=1');assert.equal(first.data.counts.training_pending,25);assert.equal(first.data.timeline.length,1);
    const created=await req('/api/review-requests',driver,'POST',{score_id:score.score_id,reason_code:'score_explanation',description:'隔离第九轮核验本人真实评分'});assert.equal(created.status,201);
    assert.equal((await req('/api/driver/action-center?cursor='+first.data.pagination.next_cursor)).data.error,'action_center_changed');
    const refreshed=(await req('/api/driver/action-center?limit=50')).data;
    assert.equal(refreshed.counts.review_open,1);
    assert.ok(refreshed.timeline.filter(x=>x.source_kind==='training_task').every(x=>x.related.length===0));
    assert.ok(refreshed.timeline.some(x=>x.event_type==='assigned'&&x.source_version===work.store.get('training_tasks',taskId).course_snapshot.source_version));
  });
  await t.test('task nodes reflect recorded lifecycle only, and reviewed tasks still wait for new own data',async()=>{
    assert.equal((await req(`/api/training-tasks/${taskId}/start`,driver,'POST',{})).status,200);
    assert.equal((await req(`/api/training-tasks/${taskId}/submit`,driver,'POST',{learning_record:course.completion_requirement})).status,200);
    assert.equal((await req(`/api/training-tasks/${taskId}/review`,admin,'POST',{decision:'returned',reason:'隔离流程检查：请补充来源课程复盘'})).status,200);
    const returned=(await req('/api/driver/action-center?limit=50')).data;
    assert.ok(returned.timeline.some(x=>x.source_id===taskId&&x.event_type==='returned'));assert.ok(returned.timeline.some(x=>x.source_id===taskId&&x.event_type==='started'));
    assert.equal((await req(`/api/training-tasks/${taskId}/submit`,driver,'POST',{learning_record:course.content})).status,200);
    assert.equal((await req(`/api/training-tasks/${taskId}/review`,admin,'POST',{decision:'approved',reason:'隔离流程动作，不代表专业结论'})).status,200);
    const result=(await req('/api/driver/action-center?limit=50')).data;
    assert.ok(result.timeline.some(x=>x.source_id===taskId&&x.event_type==='reviewed'));
    assert.ok(!result.timeline.some(x=>x.source_id===taskId&&x.event_type==='returned'),'overwritten historical return must not be reconstructed');
    const detail=await req(`/api/training-tasks/${taskId}`);assert.equal(detail.data.reassess.status,'awaiting_data');assert.deepEqual(detail.data.timeline,[]);
    assert.equal((await req(`/api/training-tasks/${taskId}`,other)).status,404);
  });
  await t.test('sent-only communication detail and exact alert relationships are reauthorized on every read',async()=>{
    const q=work.store.rows('review_queue').find(x=>x.confidence_level==='low'&&work.store.rows('drivers').some(d=>d.gpsno===x.gpsno&&d.driver_id!==work.store.get('app_users','local_other').driver_id));
    const person=work.store.rows('drivers').find(x=>x.gpsno===q.gpsno);
    work.store.put('app_users',{...account,driver_id:person.driver_id,fleet_scope:person.fleet_id},true);
    const alert=await req('/api/alerts/confirm',admin,'POST',{gpsno:q.gpsno,rule_code:'data_verification',evidence_id:q.queue_id,occurred_at:q.as_of_date});assert.equal(alert.status,201);
    assert.equal((await req(`/api/alerts/${alert.data.alert_id}/status`,admin,'PATCH',{status:'confirmed'})).status,200);
    const draft=await req(`/api/alerts/${alert.data.alert_id}/intervention`,admin,'POST',{draft_text:'隔离第九轮：请核验来源低可信记录，不作违规结论'});assert.equal(draft.status,201);
    const path='/api/driver/intervention?id='+draft.data.intervention_id;
    assert.equal((await req(path)).status,404);
    assert.ok(!(await req('/api/driver/action-center?limit=50')).data.timeline.some(x=>x.source_kind==='intervention'));
    assert.equal((await req(`/api/interventions/${draft.data.intervention_id}/send`,admin,'POST',{})).status,200);
    const detail=await req(path);assert.equal(detail.status,200);assert.equal(detail.data.alert_id,alert.data.alert_id);assert.equal(detail.data.sent_text,'隔离第九轮：请核验来源低可信记录，不作违规结论');
    assert.doesNotMatch(JSON.stringify(detail.data),/draft_text|created_by|driver_id/);assert.equal((await req(path,other)).status,404);
    const center=(await req('/api/driver/action-center?limit=50')).data;assert.equal(center.next_step.code,'verify_data');
    assert.ok(center.timeline.filter(x=>x.source_kind==='intervention').every(x=>x.related.length===1&&x.related[0].source_id===alert.data.alert_id));
    work.store.put('app_users',account,true);
  });
  await t.test('all new endpoints reject unverified, unbound and other roles; backend faults never become empty success',async()=>{
    const paths=['/api/driver/action-center','/api/driver/score-comparison','/api/driver/intervention?id=missing'];
    for(const patch of [{binding_verified:false},{driver_id:null,binding_verified:false}]){work.store.put('app_users',{...account,...patch},true);for(const path of paths)assert.equal((await req(path)).status,patch.driver_id===null?409:403);}
    work.store.put('app_users',account,true);
    for(const path of paths)assert.equal((await req(path,admin)).status,403);
    work.faults.beforeRead=({table})=>{if(table==='training_tasks'||table==='score_history')throw Error('Isolated read outage');};
    try{assert.equal((await req('/api/driver/action-center')).status,503);assert.equal((await req('/api/driver/score-comparison')).status,503);}finally{delete work.faults.beforeRead;}
  });
  await t.test('fleet aggregates use source-backed finite unique same-basis samples and remain anonymous',async()=>{
    const response=await req('/api/driver/fleet-summary');assert.equal(response.status,200);
    const fleet=work.store.rows('drivers').find(x=>x.driver_id===account.driver_id).fleet_id;
    const ids=new Set(work.store.rows('drivers').filter(x=>x.fleet_id===fleet).map(x=>x.driver_id));
    const rows=work.store.rows('score_snapshots').filter(x=>ids.has(x.driver_id)&&x.as_of_date===score.as_of_date);
    const valid=rows.filter(x=>['usable','usable_with_review','manual_review'].includes(x.score_status)&&typeof x.safety_score==='number'&&Number.isFinite(x.safety_score));
    assert.equal(new Set(valid.map(x=>x.driver_id)).size,valid.length,'current source has unique driver snapshots');
    assert.equal(response.data.data_status,'ok');assert.equal(response.data.average,Math.round(valid.reduce((sum,row)=>sum+row.safety_score,0)/valid.length*10)/10);assert.equal(response.data.valid_count,valid.length);assert.ok(response.data.sample_definition);
    assert.doesNotMatch(JSON.stringify(response.data),/driver_id|gpsno|display_name|rank/);
    assert.equal(fleetStatistics(rows.slice(0,1)).average,null);assert.equal(fleetStatistics(rows.slice(0,1)).distribution,null);
    // Duplicate real records are ambiguous, not double-counted as extra drivers.
    const unique=rows.slice(0,10),duplicated=fleetStatistics([...unique,unique[0]]);assert.equal(duplicated.data_status,'insufficient_sample');
    assert.equal(JSON.stringify(['drivers','score_snapshots','score_history','replay_events','deduction_ledger'].map(x=>work.store.rows(x))),facts);
  });
});

test("IE亮剑 source-only acceptance with real SQLite persistence", async t => {
  const parent=fileURLToPath(new URL("../.source-tests/",import.meta.url));await mkdir(parent,{recursive:true});
  const directory=await mkdtemp(join(parent,"acceptance-"));
  let work=await startLocalWorkbench({directory,pauseOutbox:true});
  t.after(async()=>{if(work)await work.stop();});
  async function login(name){const a=work.store.accounts.find(x=>x.username===name);const r=await fetch(work.base+"/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(a)});assert.equal(r.status,200);return r.headers.get("set-cookie").split(";")[0];}
  let admin=await login("local_admin"),driver=await login("local_driver"),other=await login("local_other");
  async function req(path,cookie=driver,method="GET",body){const r=await fetch(work.base+path,{method,headers:{cookie,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,data:await r.json()};}
  const driverId=work.store.accounts.find(x=>x.username==='local_driver').driver_id;
  const sourceScore=work.store.rows("score_snapshots").find(x=>x.driver_id===driverId),sourceCourse=work.store.rows("training_courses")[0];
  const initialFacts=JSON.stringify(work.store.rows("score_snapshots"));
  let taskId;
  await t.test("imports exact local files with hashes and counts, leaving source course drafts unapproved",async()=>{
    assert.equal(work.store.rows("drivers").length,500);assert.equal(work.store.rows("score_history").length,4000);assert.equal(work.store.rows("deduction_ledger").length,6267);assert.equal(work.store.rows("replay_events").length,883);
    assert.equal(work.store.rows("training_tasks").length,0);assert.ok(work.store.rows("training_courses").every(x=>x.content_status==='demo_draft_requires_team_review'));
    const r=await req("/api/data/my.score");assert.equal(r.status,200);assert.equal(r.data.rows[0].score_id,sourceScore.score_id);assert.equal(r.data.rows[0].safety_score,sourceScore.safety_score);
    assert.equal((await req("/api/me")).data.user.driverId,driverId);
    for(const p of work.store.provenance){const path=fileURLToPath(new URL('../../IE亮剑/'+p.file,import.meta.url));assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'),p.sha256);}
  });
  await t.test("own risk and score evidence match source records and other-driver attempts are refused",async()=>{
    const event=work.store.rows("replay_events").find(x=>x.driver_id===driverId);
    const r=await req(`/api/driver/risk-center?date=${event.replay_date}&limit=20`);assert.equal(r.status,200);assert.ok(r.data.events.some(x=>x.event_id===event.event_id));
    const ev=await req(`/api/driver/evidence?kind=score&id=${sourceScore.score_id}`);assert.equal(ev.status,200);assert.equal(ev.data.record.safety_score,sourceScore.safety_score);
    assert.equal((await req(`/api/driver/evidence?kind=score&id=${sourceScore.score_id}`,other)).status,404);
    assert.equal((await req('/api/ai/chat',driver,'POST',{messages:[]})).data.error,'local_source_only');
    assert.equal((await req('/api/admin/course-draft',admin,'POST',{content:sourceCourse.content})).status,403);
  });
  const assignment={course_id:sourceCourse.course_id,driver_id:driverId,goal:sourceCourse.completion_requirement,idempotency_key:"local-source-acceptance"};
  await t.test("draft course cannot be assigned; controlled review is only a temporary test workflow",async()=>{
    assert.equal((await req('/api/admin/training-assign',admin,'POST',assignment)).data.error,'course_not_approved');
    for(const next of ['pending_review','approved'])assert.equal((await req('/api/admin/course-review',admin,'POST',{course_id:sourceCourse.course_id,new_status:next,note:'本地隔离验收中的流程动作，不代表专业审核完成'})).status,200);
    assert.equal(work.store.get('training_courses',sourceCourse.course_id).content,sourceCourse.content);
  });
  await t.test("real SQLite uniqueness prevents concurrent duplicate assignments, and outbox is atomic with task creation",async()=>{
    work.faults.notifications=true;
    const results=await Promise.all([req('/api/admin/training-assign',admin,'POST',assignment),req('/api/admin/training-assign',admin,'POST',assignment)]);
    assert.ok(results.some(r=>r.status===200));assert.ok(results.every(r=>[200,409].includes(r.status)));
    const tasks=work.store.rows('training_tasks');assert.equal(tasks.length,1);taskId=tasks[0].task_id;
    assert.equal(tasks[0].course_snapshot.content,sourceCourse.content);
    assert.equal(work.store.db.prepare('SELECT COUNT(*) n FROM outbox WHERE task_id=?').get(taskId).n,1);
    assert.equal(work.store.rows('audit_logs').filter(x=>x.entity_id===taskId&&x.action==='local.training.insert').length,1);
    assert.equal(work.store.rows('notification_events').length,0);
  });
  await t.test("restart retains pending outbox; recovery creates exactly one real database notification",async()=>{
    await work.stop();work=null;work=await startLocalWorkbench({directory,pauseOutbox:true});
    admin=await login('local_admin');driver=await login('local_driver');other=await login('local_other');
    const before=work.store.db.prepare('SELECT status FROM outbox WHERE task_id=?').get(taskId);assert.equal(before.status,'pending');
    work.store.drainOutbox({force:true});work.store.drainOutbox({force:true});
    assert.equal(work.store.rows('notification_events').filter(x=>x.source_entity_id===taskId).length,1);
    assert.equal(work.store.db.prepare('SELECT status FROM outbox WHERE task_id=?').get(taskId).status,'recorded');
  });
  await t.test("stale drafts are rejected and unsupported external quiz content is removed",async()=>{
    const path=`/api/training-tasks/${taskId}`,v=(await req(path)).data;
    assert.equal(v.self_check,undefined);assert.equal(v.learning_progress,undefined);
    assert.equal((await req(path+'/draft',driver,'PATCH',{self_check:[1,1],learning_record:sourceCourse.completion_requirement})).status,410);
    const saved=await req(path+'/draft',driver,'PATCH',{learning_record:sourceCourse.completion_requirement,feedback:sourceCourse.content,expected_updated_at:v.task.updated_at});assert.equal(saved.status,200);
    assert.equal((await req(path+'/draft',driver,'PATCH',{learning_record:sourceCourse.content,expected_updated_at:v.task.updated_at})).status,409);
    assert.equal((await req(path,other)).status,404);
    const submitted=await req(path+'/submit',driver,'POST',{learning_record:sourceCourse.completion_requirement,feedback:sourceCourse.content,expected_updated_at:saved.data.updated_at});assert.equal(submitted.status,200);
  });
  await t.test("study summary and staff review use only source course and actual workflow facts",async()=>{
    const r=await req(`/api/driver/learning-report?task_id=${taskId}`);assert.equal(r.status,200);assert.equal(r.data.course.title,sourceCourse.title);assert.equal(r.data.learning_record,sourceCourse.completion_requirement);assert.equal(r.data.feedback,sourceCourse.content);
    assert.equal((await req(`/api/driver/learning-report?task_id=${taskId}`,other)).status,404);
    assert.equal((await req(`/api/training-tasks/${taskId}/review`,admin,'POST',{decision:'returned',reason:sourceCourse.completion_requirement})).status,200);
    const v=(await req(`/api/training-tasks/${taskId}`)).data;assert.equal(v.task.status,'returned');
    assert.equal((await req(`/api/training-tasks/${taskId}/submit`,driver,'POST',{learning_record:sourceCourse.completion_requirement,expected_updated_at:v.task.updated_at})).status,200);
    assert.equal((await req(`/api/training-tasks/${taskId}/review`,admin,'POST',{decision:'approved',reason:sourceCourse.completion_requirement})).status,200);
    const report=await req(`/api/driver/learning-report?task_id=${taskId}`);assert.equal(report.data.review_note,sourceCourse.completion_requirement);
    assert.equal(JSON.stringify(work.store.rows('score_snapshots')),initialFacts);
  });
  await t.test("outbox transaction rolls back on database insert failure, then recovers without loss",async()=>{
    work.faults.notifications=true;
    const r=await req('/api/admin/training-assign',admin,'POST',{...assignment,idempotency_key:'local-source-rollback'});assert.equal(r.status,200);const id=r.data.task_id;
    work.store.db.exec("CREATE TRIGGER test_failure BEFORE INSERT ON objects WHEN NEW.table_name='notification_events' BEGIN SELECT RAISE(ABORT,'intentional technical failure'); END;");
    assert.throws(()=>work.store.drainOutbox({force:true}));
    assert.equal(work.store.db.prepare('SELECT status FROM outbox WHERE task_id=?').get(id).status,'pending');
    work.store.db.exec('DROP TRIGGER test_failure');work.store.drainOutbox({force:true});
    assert.equal(work.store.rows('notification_events').filter(x=>x.source_entity_id===id).length,1);
  });
  await t.test("rejects source directories outside IE亮剑",async()=>{
    await assert.rejects(()=>openLocalStore({directory:join(directory,'rejected'),sourceRoot:rootOutside()}),/Only IE亮剑/);
  });
  await t.test("normal background worker automatically recovers durable reminders after restart",async()=>{
    work.faults.notifications=true;
    const r=await req('/api/admin/training-assign',admin,'POST',{...assignment,idempotency_key:'local-auto-worker'});assert.equal(r.status,200);const id=r.data.task_id;
    assert.equal(work.store.db.prepare('SELECT status FROM outbox WHERE task_id=?').get(id).status,'pending');
    await work.stop();work=null;work=await startLocalWorkbench({directory});
    for(let i=0;i<60&&work.store.db.prepare('SELECT status FROM outbox WHERE task_id=?').get(id).status!=='recorded';i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(work.store.db.prepare('SELECT status FROM outbox WHERE task_id=?').get(id).status,'recorded');
    assert.equal(work.store.rows('notification_events').filter(x=>x.source_entity_id===id).length,1);
  });
  await t.test("source files retain identical hashes after all workflow writes",async()=>{
    for(const p of work.store.provenance){const path=fileURLToPath(new URL('../../IE亮剑/'+p.file,import.meta.url));assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'),p.sha256);}
  });
  function rootOutside(){return fileURLToPath(new URL('../',import.meta.url));}
});

test("round seven identity, intervention races and durable review reminders", async t => {
  const parent=fileURLToPath(new URL('../.source-tests/',import.meta.url));await mkdir(parent,{recursive:true});
  const directory=await mkdtemp(join(parent,'round-seven-'));
  let work=await startLocalWorkbench({directory,pauseOutbox:true});
  t.after(async()=>{if(work)await work.stop();});
  const original=work.store.get('app_users','local_driver');
  const originalAdmin=work.store.get('app_users','local_admin');
  const score=work.store.rows('score_snapshots').find(x=>x.driver_id===original.driver_id);
  const sourceHashes=work.store.provenance;
  async function login(name){const a=work.store.accounts.find(x=>x.username===name);const r=await fetch(work.base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(a)});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];}
  let driver=await login('local_driver'),admin=await login('local_admin'),other=await login('local_other');
  async function req(path,cookie=driver,method='GET',body){const r=await fetch(work.base+path,{method,headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,data:await r.json()};}
  const proposal={score_id:score.score_id,reason_code:'score_explanation',description:'隔离验收：核对本人来源评分的说明，不代表真实司机申诉',idempotency_key:'r7-source-review'};
  let requestId;
  await t.test('concurrent review retries create one request and one transactional reminder',async()=>{
    work.faults.notifications=true;
    const results=await Promise.all([req('/api/review-requests',driver,'POST',proposal),req('/api/review-requests',driver,'POST',proposal)]);
    assert.deepEqual(results.map(x=>x.status).sort(),[200,201]);
    requestId=results[0].data.request_id;
    assert.ok(results.every(x=>x.data.request_id===requestId&&x.data.notification.state==='pending'));
    assert.equal(work.store.rows('review_requests').length,1);
    assert.equal(work.store.db.prepare('SELECT COUNT(*) n FROM review_outbox WHERE request_id=?').get(requestId).n,1);
    assert.equal(work.store.rows('audit_logs').filter(x=>x.entity_id===requestId&&x.action==='local.review.insert').length,1);
    const rebound=await req('/api/review-requests',driver,'POST',{...proposal,description:proposal.description+' 修改'});
    assert.equal(rebound.status,409);assert.equal(rebound.data.error,'review_request_idempotency_conflict');
    const otherScore=work.store.rows('score_snapshots').find(x=>x.driver_id===work.store.get('app_users','local_other').driver_id);
    const collision=await req('/api/review-requests',other,'POST',{...proposal,score_id:otherScore.score_id});
    assert.equal(collision.status,409);assert.notEqual(collision.data.request_id,requestId);
  });
  await t.test('unverified and missing bindings reject personal reads and writes without mutations',async()=>{
    const endpoints=[
      ['/api/review-requests','POST',proposal],['/api/review-requests/'+requestId,'GET'],
      ['/api/data/my.score','GET'],['/api/data/my.review_requests','GET'],['/api/data/my.notifications','GET'],
      ['/api/driver/risk-center','GET'],['/api/driver/evidence?kind=score&id='+score.score_id,'GET'],
      ['/api/driver/learning-report?task_id=missing','GET'],['/api/training-tasks/missing','GET'],
      ['/api/training-tasks/missing/start','POST',{}],['/api/training-tasks/missing/draft','PATCH',{}],['/api/training-tasks/missing/submit','POST',{}],
      ['/api/interventions/missing/read','POST',{}],['/api/interventions/missing/reply','POST',{reply_text:'隔离权限测试'}],
      ['/api/notes','GET'],['/api/notes/summary','GET'],['/api/notes/missing/read','POST',{}]
    ];
    const before=JSON.stringify(['review_requests','interventions','training_tasks','notification_events'].map(x=>work.store.rows(x)));
    for(const [patch,status,error] of [[{binding_verified:false},403,'binding_not_verified'],[{driver_id:null,binding_verified:false},409,'binding_required']]){
      work.store.put('app_users',{...original,...patch},true);
      for(const [path,method,body] of endpoints){const r=await req(path,driver,method,body);assert.equal(r.status,status,path);assert.equal(r.data.error,error,path);}
    }
    work.store.put('app_users',original,true);
    assert.equal(JSON.stringify(['review_requests','interventions','training_tasks','notification_events'].map(x=>work.store.rows(x))),before);
    // Account-owned preferences remain available to an unbound driver, independent of business identity.
    work.store.put('app_users',{...original,driver_id:null,binding_verified:false},true);
    assert.equal((await req('/api/me/profile')).status,200);
    work.store.put('app_users',original,true);
    assert.equal((await req('/api/review-requests/'+requestId,other)).status,404);
    assert.equal((await req('/api/review-requests',admin,'POST',proposal)).status,403);
    work.store.put('app_users',{...original,account_status:'disabled'},true);
    assert.equal((await req('/api/review-requests',driver,'POST',proposal)).status,401);
    work.store.put('app_users',original,true);
    const session=work.store.rows('app_sessions').find(x=>x.user_id==='local_driver');
    work.store.put('app_sessions',{...session,expires_at:'2000-01-01T00:00:00.000Z'},true);
    assert.equal((await req('/api/review-requests',driver,'POST',proposal)).status,401);
    driver=await login('local_driver');
  });
  await t.test('review reminders survive restart, rollback and recipient changes without redirection',async()=>{
    await work.stop();work=null;work=await startLocalWorkbench({directory,pauseOutbox:true});
    driver=await login('local_driver');admin=await login('local_admin');other=await login('local_other');
    work.store.put('app_users',{...originalAdmin,account_status:'disabled'},true);
    const alternate=work.store.get('app_users','local_other');
    work.store.put('app_users',{...alternate,role:'safety_admin',fleet_scope:'*'},true);
    work.store.drainOutbox({force:true});
    assert.equal(work.store.db.prepare('SELECT status FROM review_outbox WHERE request_id=?').get(requestId).status,'pending');
    assert.equal(work.store.rows('notification_events').filter(x=>x.source_entity_id===requestId).length,0);
    work.store.put('app_users',originalAdmin,true);
    work.store.put('app_users',alternate,true);
    work.store.db.exec("CREATE TRIGGER r7_notification_failure BEFORE INSERT ON objects WHEN NEW.table_name='notification_events' BEGIN SELECT RAISE(ABORT,'isolated notification failure'); END;");
    assert.throws(()=>work.store.drainOutbox({force:true}));
    assert.equal(work.store.db.prepare('SELECT status FROM review_outbox WHERE request_id=?').get(requestId).status,'pending');
    work.store.db.exec('DROP TRIGGER r7_notification_failure');
    work.store.drainOutbox({force:true});work.store.drainOutbox({force:true});
    assert.equal(work.store.rows('notification_events').filter(x=>x.source_entity_id===requestId).length,1);
    const replay=await req('/api/review-requests',driver,'POST',proposal);assert.equal(replay.status,200);assert.equal(replay.data.notification.state,'recorded');
    const notification=work.store.rows('notification_events').find(x=>x.source_entity_id===requestId);
    assert.equal((await req('/api/notes/'+notification.notification_id+'/read',driver,'POST',{})).status,404);
  });
  await t.test('review administrators are scoped, competing answers preserve the winner and its durable notice',async()=>{
    // Source has a single fleet; a technical empty scope tests refusal without inventing a fleet.
    work.store.put('app_users',{...originalAdmin,fleet_scope:'__no_authorized_fleet__'},true);
    assert.equal((await req('/api/review-requests/'+requestId,admin)).status,404);
    assert.equal((await req('/api/review-requests/'+requestId+'/advance',admin,'POST',{status:'checking'})).status,404);
    work.store.put('app_users',originalAdmin,true);
    assert.equal((await req('/api/review-requests/'+requestId+'/advance',admin,'POST',{status:'answered',response_note:'隔离流程核验，不代表专业审核',template_ref:'missing-template'})).status,409);
    assert.equal(work.store.get('review_requests',requestId).status,'submitted');
    const results=await Promise.all(['隔离审核动作一','隔离审核动作二'].map(response_note=>req('/api/review-requests/'+requestId+'/advance',admin,'POST',{status:'answered',response_note})));
    assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
    const saved=work.store.get('review_requests',requestId);
    assert.equal(saved.status,'answered');
    assert.equal(results.find(x=>x.status===200).data.notification.state,'pending');
    assert.equal(work.store.db.prepare("SELECT COUNT(*) n FROM review_outbox WHERE request_id=? AND kind='answered'").get(requestId).n,1);
    work.store.put('app_users',{...original,binding_verified:false},true);work.store.drainOutbox({force:true});
    assert.equal(work.store.db.prepare("SELECT status FROM review_outbox WHERE request_id=? AND kind='answered'").get(requestId).status,'pending');
    work.store.put('app_users',original,true);
    work.store.db.prepare("UPDATE review_outbox SET next_at=0 WHERE request_id=? AND kind='answered'").run(requestId);
    await work.stop();work=null;work=await startLocalWorkbench({directory});
    for(let i=0;i<80&&work.store.db.prepare("SELECT status FROM review_outbox WHERE request_id=? AND kind='answered'").get(requestId).status!=='recorded';i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(work.store.db.prepare("SELECT status FROM review_outbox WHERE request_id=? AND kind='answered'").get(requestId).status,'recorded');
    assert.equal(work.store.get('review_requests',requestId).review_note,saved.review_note);
    driver=await login('local_driver');admin=await login('local_admin');other=await login('local_other');
    const notice=work.store.rows('notification_events').find(x=>x.idempotency_key===`notif:rra:${requestId}:answered`);
    assert.equal(notice.target_user_id,'local_driver');
    const reads=await Promise.all([req('/api/notes/'+notice.notification_id+'/read',driver,'POST',{}),req('/api/notes/'+notice.notification_id+'/read',driver,'POST',{})]);
    assert.ok(reads.every(x=>x.status===200&&x.data.read_at===reads[0].data.read_at));
  });
  let messageIndex=0;
  async function sourceMessage(){
    const queues=work.store.rows('review_queue').filter(x=>x.confidence_level==='low'&&work.store.rows('drivers').some(d=>d.gpsno===x.gpsno));
    const queue=queues[messageIndex++];assert.ok(queue,'source supports distinct low-confidence workflow cases');
    const person=work.store.rows('drivers').find(x=>x.gpsno===queue.gpsno);
    work.store.put('app_users',{...original,driver_id:person.driver_id,fleet_scope:person.fleet_id},true);
    work.store.put('app_users',{...originalAdmin,fleet_scope:person.fleet_id},true);
    const created=await req('/api/alerts/confirm',admin,'POST',{gpsno:queue.gpsno,rule_code:'data_verification',evidence_id:queue.queue_id,occurred_at:queue.as_of_date});
    assert.equal(created.status,201,JSON.stringify(created.data));
    assert.equal((await req('/api/alerts/'+created.data.alert_id+'/status',admin,'PATCH',{status:'confirmed'})).status,200);
    const draft=await req('/api/alerts/'+created.data.alert_id+'/intervention',admin,'POST',{draft_text:'隔离测试：请核验来源记录的数据覆盖，不作违规结论'});
    assert.equal(draft.status,201,JSON.stringify(draft.data));
    return draft.data.intervention_id;
  }
  await t.test('source-backed intervention flow enforces capability, verified identity and ownership',async()=>{
    const id=await sourceMessage();
    assert.equal((await req('/api/interventions/'+id+'/draft',driver,'PATCH',{draft_text:'不能修改安全员消息'})).status,403);
    assert.equal((await req('/api/interventions/'+id+'/draft',admin,'PATCH',{draft_text:'隔离测试：来源低可信，待数据核验'})).status,200);
    assert.equal((await req('/api/interventions/'+id+'/send',admin,'POST',{})).status,200);
    const bound=work.store.get('app_users','local_driver');
    work.store.put('app_users',{...bound,binding_verified:false},true);
    for(const suffix of ['read','reply'])assert.equal((await req('/api/interventions/'+id+'/'+suffix,driver,'POST',{reply_text:'隔离反馈'})).data.error,'binding_not_verified');
    work.store.put('app_users',bound,true);
    const outsider=work.store.get('app_users','local_other');
    if(outsider.driver_id===bound.driver_id)work.store.put('app_users',{...outsider,driver_id:work.store.rows('drivers').find(x=>x.driver_id!==bound.driver_id).driver_id},true);
    assert.equal((await req('/api/interventions/'+id+'/reply',admin,'POST',{reply_text:'管理员不能代司机回复'})).status,403);
    assert.equal((await req('/api/interventions/'+id+'/reply',other,'POST',{reply_text:'其他司机'})).status,404);
    let release,entered;
    const gate=new Promise(r=>{release=r;}),hit=new Promise(r=>{entered=r;});
    work.faults.beforeMutation=async x=>{if(x.table==='interventions'&&x.body.status==='read'){entered();await gate;}};
    const reading=req('/api/interventions/'+id+'/read',driver,'POST',{});
    let timeout;
    try {
      await Promise.race([hit,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('read barrier timed out')),3000);})]);
      const reply=await req('/api/interventions/'+id+'/reply',driver,'POST',{reply_text:'隔离司机反馈：请求进一步解释'});assert.equal(reply.status,200);
    } finally {clearTimeout(timeout);release();delete work.faults.beforeMutation;}
    const read=await reading;assert.equal(read.status,200);assert.equal(read.data.idempotent_replay,true);
    const saved=work.store.get('interventions',id);assert.equal(saved.status,'replied');assert.equal(saved.reply_text,'隔离司机反馈：请求进一步解释');assert.equal(read.data.read_at,saved.read_at);
  });
  await t.test('competing driver replies return the single saved reply without duplicate transition audits',async()=>{
    const id=await sourceMessage();assert.equal((await req('/api/interventions/'+id+'/send',admin,'POST',{})).status,200);
    const results=await Promise.all(['隔离回复一','隔离回复二'].map(reply_text=>req('/api/interventions/'+id+'/reply',driver,'POST',{reply_text})));
    const saved=work.store.get('interventions',id);
    assert.ok(results.every(x=>x.status===200&&x.data.reply_text===saved.reply_text&&x.data.replied_at===saved.replied_at));
    assert.equal(results.filter(x=>!x.data.idempotent_replay).length,1);
    assert.equal(work.store.rows('audit_logs').filter(x=>x.entity_id===id&&x.action==='intervention.reply').length,1);
    work.store.put('app_users',{...originalAdmin,fleet_scope:'__no_authorized_fleet__'},true);
    assert.equal((await req('/api/interventions/'+id+'/send',admin,'POST',{})).status,404);
    work.store.put('app_users',originalAdmin,true);
  });
  await t.test('additive upgrade preserves existing records and reminder enqueue failure rolls back the request',async()=>{
    work.store.put('app_users',original,true);
    const created=await req('/api/review-requests',driver,'POST',{...proposal,idempotency_key:'r7-existing-request',description:'隔离升级核验：保存已有申请'});
    assert.equal(created.status,201);
    const preserved=JSON.stringify(work.store.rows('review_requests'));
    work.store.db.exec('DROP TRIGGER enqueue_review_request; DROP TRIGGER enqueue_review_answer; DROP TRIGGER local_review_update_audit; DROP TABLE review_outbox;');
    await work.stop();work=null;work=await startLocalWorkbench({directory,pauseOutbox:true});
    driver=await login('local_driver');admin=await login('local_admin');
    assert.equal(JSON.stringify(work.store.rows('review_requests')),preserved);
    assert.equal(work.store.db.prepare("SELECT status FROM review_outbox WHERE request_id=? AND kind='submitted'").get(created.data.request_id).status,'pending');
    const audits=work.store.rows('audit_logs').length;
    work.store.db.exec("CREATE TRIGGER r7_enqueue_failure BEFORE INSERT ON review_outbox BEGIN SELECT RAISE(ABORT,'isolated enqueue failure'); END;");
    const rejected=await req('/api/review-requests',driver,'POST',{...proposal,idempotency_key:'r7-rollback-request',description:'隔离事务回滚核验'});
    assert.equal(rejected.status,503);
    assert.equal(JSON.stringify(work.store.rows('review_requests')),preserved);
    assert.equal(work.store.rows('audit_logs').length,audits);
    work.store.db.exec('DROP TRIGGER r7_enqueue_failure');
    const healthy=await req('/api/review-requests',driver,'POST',{...proposal,idempotency_key:'r7-healthy-reminder',description:'隔离核验：其他提醒不受单项失败阻塞'});
    assert.equal(healthy.status,201);
    work.store.db.exec(`CREATE TRIGGER r7_single_delivery_failure BEFORE INSERT ON objects WHEN NEW.table_name='notification_events' AND json_extract(NEW.payload,'$.source_entity_id')='${created.data.request_id}' BEGIN SELECT RAISE(ABORT,'isolated single delivery failure'); END;`);
    assert.throws(()=>work.store.drainOutbox({force:true}));
    assert.equal(work.store.db.prepare("SELECT last_error FROM review_outbox WHERE request_id=? AND kind='submitted'").get(created.data.request_id).last_error,'delivery_failed');
    assert.equal(work.store.db.prepare("SELECT status FROM review_outbox WHERE request_id=? AND kind='submitted'").get(healthy.data.request_id).status,'recorded');
    work.store.db.exec('DROP TRIGGER r7_single_delivery_failure');
    work.store.drainOutbox({force:true});
    assert.equal(work.store.db.prepare("SELECT status FROM review_outbox WHERE request_id=? AND kind='submitted'").get(created.data.request_id).status,'recorded');
  });
  await t.test('round seven retains source hashes and introduces no score or course approvals',async()=>{
    for(const p of sourceHashes){const path=fileURLToPath(new URL('../../IE亮剑/'+p.file,import.meta.url));assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'),p.sha256);}
    assert.ok(work.store.rows('training_courses').every(x=>x.content_status==='demo_draft_requires_team_review'));
    assert.equal(work.store.rows('training_tasks').length,0);
    assert.deepEqual(work.store.get('score_snapshots',score.score_id),score);
  });
});
