import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { startLocalWorkbench } from "../scripts/local-workbench.mjs";
import { openLocalStore } from "../scripts/local-data-store.mjs";

// All business rows come from IE亮剑 CSVs. Tests create only workflow actions/technical accounts.
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
