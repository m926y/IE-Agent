import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalWorkbench } from '../scripts/local-workbench.mjs';

test('daily report stage 2 persists and isolates published reports',async t=>{
  const root=fileURLToPath(new URL('../.source-tests/',import.meta.url));await mkdir(root,{recursive:true});
  const directory=await mkdtemp(join(root,'daily-report-http-'));
  let work=await startLocalWorkbench({directory,pauseOutbox:true});
  t.after(async()=>{await work.stop();await rm(directory,{recursive:true,force:true});});
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  async function login(name){const account=work.store.accounts.find(x=>x.username===name);const r=await fetch(work.base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(account)});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];}
  let admin=await login('local_admin'),driver=await login('local_driver'),other=await login('local_other');
  async function req(path,cookie=driver,method='GET',body){const r=await fetch(work.base+path,{method,headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
  const driverId=work.store.get('app_users','local_driver').driver_id;
  const otherId=work.store.get('app_users','local_other').driver_id;

  await t.test('admin manual publish is atomic and idempotent; reports are owner-scoped',async()=>{
    assert.equal((await req('/api/admin/daily-reports/run',driver,'POST',{driver_id:driverId,report_date:today})).status,403);
    const adminAccount=work.store.get('app_users','local_admin');
    work.store.put('app_users',{...adminAccount,fleet_scope:'OTHER_FLEET'},true);
    assert.equal((await req('/api/admin/daily-reports/run',admin,'POST',{driver_id:driverId,report_date:today})).status,404);
    work.store.put('app_users',adminAccount,true);
    assert.deepEqual(await req('/api/driver/reports/today'),{status:200,data:null});
    const made=await req('/api/admin/daily-reports/run',admin,'POST',{driver_id:driverId,report_date:today});
    assert.equal(made.status,200);assert.equal(made.data.report.driverId,driverId);assert.equal(made.data.report.reportDate,today);assert.equal(made.data.reportVersion,1);assert.equal(made.data.notificationCount,1);
    const again=await req('/api/admin/daily-reports/run',admin,'POST',{driver_id:driverId,report_date:today});
    assert.equal(again.status,200);assert.equal(again.data.id,made.data.id);assert.equal(again.data.idempotentReplay,true);
    assert.equal(work.store.db.prepare('SELECT COUNT(*) n FROM daily_safety_reports').get().n,1);
    const mine=await req('/api/driver/reports/today?driver_id='+otherId);assert.equal(mine.status,200);assert.equal(mine.data.id,made.data.id);
    assert.equal((await req(`/api/driver/reports/${made.data.id}`,other)).status,404);
    assert.equal((await req('/api/driver/reports/history',other)).data.total,0);
    const notes=await req('/api/driver/notifications');assert.equal(notes.data.rows.length,1);
    assert.equal(notes.data.rows[0].source_entity_id,String(made.data.id));
    assert.equal((await req('/api/driver/notifications',other)).data.rows.length,0);
    const ownAccount=work.store.get('app_users','local_driver');
    work.store.put('app_users',{...ownAccount,driver_id:otherId},true);
    assert.deepEqual((await req('/api/driver/reports/history')).data.rows,[]);
    assert.deepEqual((await req('/api/driver/notifications')).data.rows,[]);
    work.store.put('app_users',{...ownAccount,binding_verified:false},true);
    assert.equal((await req('/api/driver/reports/history')).status,403);
    work.store.put('app_users',ownAccount,true);
    const marked=await req(`/api/notes/${notes.data.rows[0].notification_id}/read`,driver,'POST',{});assert.equal(marked.status,200);
    assert.ok((await req('/api/driver/notifications')).data.rows[0].read_at);
    const goals=(await req('/api/driver/safety-goals')).data.rows;
    if(goals.length){const feedback=await req(`/api/driver/safety-goals/${goals[0].id}/feedback`,driver,'POST',{code:'will_review',text:'已查看证据'});assert.equal(feedback.status,200);assert.equal(feedback.data.status,'active');assert.equal((await req(`/api/driver/safety-goals/${goals[0].id}/feedback`,other,'POST',{code:'dismissed'})).status,404);}
  });

  await t.test('notification failure rolls back the report and a retry succeeds',async()=>{
    work.store.db.exec("CREATE TRIGGER daily_report_notification_fail BEFORE INSERT ON objects WHEN NEW.table_name='notification_events' AND json_extract(NEW.payload,'$.type')='daily_report_ready' BEGIN SELECT RAISE(ABORT,'isolated notification failure'); END;");
    const failed=await req('/api/admin/daily-reports/run',admin,'POST',{driver_id:otherId,report_date:today});
    assert.notEqual(failed.status,200);
    assert.equal(work.store.db.prepare('SELECT COUNT(*) n FROM daily_safety_reports WHERE driver_id=?').get(otherId).n,0);
    work.store.db.exec('DROP TRIGGER daily_report_notification_fail');
    const made=await req('/api/admin/daily-reports/run',admin,'POST',{driver_id:otherId,report_date:today});
    assert.equal(made.status,200);assert.equal(made.data.notificationCount,1);
    assert.equal((await req('/api/driver/reports/today',other)).data.report.driverId,otherId);
    assert.equal((await req(`/api/driver/reports/${made.data.id}`,driver)).status,404);
  });

  await t.test('restart preserves reports, feedback and notification state',async()=>{
    await work.stop();work=await startLocalWorkbench({directory,pauseOutbox:true});
    admin=await login('local_admin');driver=await login('local_driver');other=await login('local_other');
    assert.equal((await req('/api/driver/reports/history')).data.total,1);
    assert.equal((await req('/api/driver/reports/history',other)).data.total,1);
    assert.ok((await req('/api/driver/notifications')).data.rows[0].read_at);
    const goals=(await req('/api/driver/safety-goals')).data.rows;
    if(goals.length) assert.equal(goals[0].feedbackCode,'will_review');
    assert.ok(work.store.rows('training_courses').every(x=>x.content_status==='demo_draft_requires_team_review'));
  });

  await t.test('source change requires explicit revision and preserves the old version',async()=>{
    const old=(await req('/api/driver/reports/today')).data;
    const source=work.store.rows('training_courses')[0];
    work.store.put('training_courses',{...source,content_status:'approved',updated_at:'2026-08-01T00:00:00Z'},true);
    const refused=await req('/api/admin/daily-reports/run',admin,'POST',{driver_id:driverId,report_date:today});
    assert.equal(refused.status,409);
    assert.equal((await req('/api/driver/reports/today')).data.id,old.id);
    const revised=await req('/api/admin/daily-reports/run',admin,'POST',{driver_id:driverId,report_date:today,revise:true});
    assert.equal(revised.status,200);assert.equal(revised.data.reportVersion,2);
    assert.notEqual(revised.data.id,old.id);
    assert.equal((await req('/api/driver/reports/history')).data.total,2);
    assert.deepEqual((await req(`/api/driver/reports/${old.id}`)).data,old);
    assert.equal((await req('/api/driver/reports/today')).data.id,revised.data.id);
    assert.equal((await req('/api/driver/notifications')).data.rows.length,2);
    assert.equal((await req('/api/admin/daily-reports/run',admin,'POST',{driver_id:driverId,report_date:today,revise:true})).data.idempotentReplay,true);
  });
});
