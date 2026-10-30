import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLocalStore } from '../scripts/local-data-store.mjs';
import { startLocalWorkbench } from '../scripts/local-workbench.mjs';
import { publishDailyReport } from '../scripts/daily-report/report-store.mjs';
import { claimDailyReportJobs, dailyReportBusinessClock, ensureDailyReportJobs, failDailyReportJob, listDailyReportJobs, runDailyReportCycle } from '../scripts/daily-report/report-scheduler.mjs';

test('daily report stage 3 schedules, recovers and publishes 500 source drivers',async t=>{
  const root=fileURLToPath(new URL('../.source-tests/',import.meta.url));await mkdir(root,{recursive:true});
  const directory=await mkdtemp(join(root,'daily-report-scheduler-'));
  const store=await openLocalStore({directory});
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  const before=new Date('2026-10-29T22:59:00Z'),due=new Date('2026-10-29T23:00:00Z'),date='2026-10-30';

  await t.test('business clock waits until 07:00 Shanghai and creates one job per real driver',()=>{
    assert.deepEqual(dailyReportBusinessClock(before),{date,minutes:419});
    assert.equal(runDailyReportCycle(store,{now:before}).notDue,true);
    assert.equal(listDailyReportJobs(store,{date}).total,0);
    assert.equal(ensureDailyReportJobs(store,date),500);
    assert.equal(ensureDailyReportJobs(store,date),0);
    assert.equal(listDailyReportJobs(store,{date}).byStatus.pending,500);
  });

  await t.test('expired claim is fenced and a replacement publishes once',()=>{
    const first=claimDailyReportJobs(store,date,{now:due.getTime(),limit:1,leaseMs:1000})[0];
    const second=claimDailyReportJobs(store,date,{now:due.getTime()+1001,limit:1})[0];
    assert.equal(second.id,first.id);assert.notEqual(second.leaseToken,first.leaseToken);
    assert.throws(()=>publishDailyReport(store,{driverId:first.driverId,reportDate:date,actorId:'local_daily_report_worker',jobClaim:first}),/stale_daily_report_claim/);
    assert.equal(failDailyReportJob(store,first,new Error('old worker')) ,false);
    const result=publishDailyReport(store,{driverId:second.driverId,reportDate:date,actorId:'local_daily_report_worker',jobClaim:second});
    assert.equal(result.reportVersion,1);
    assert.equal(store.db.prepare('SELECT status FROM daily_report_jobs WHERE id=?').get(first.id).status,'succeeded');
  });

  await t.test('failed generation remains retryable and a database failure rolls back report plus notification',()=>{
    const claimed=claimDailyReportJobs(store,date,{now:due.getTime(),limit:1})[0];
    assert.equal(failDailyReportJob(store,claimed,new Error('isolated generation failure'),{now:due.getTime()}),true);
    const pending=store.db.prepare('SELECT status,attempts,next_at,error_message FROM daily_report_jobs WHERE id=?').get(claimed.id);
    assert.equal(pending.status,'pending');assert.equal(pending.attempts,1);assert.ok(pending.next_at>due.getTime());
    const retry=claimDailyReportJobs(store,date,{now:pending.next_at,limit:1})[0];
    assert.equal(retry.id,claimed.id);
    const boundId=store.get('app_users','local_driver').driver_id;
    const bound=store.db.prepare('SELECT id FROM daily_report_jobs WHERE driver_id=? AND report_date=?').get(boundId,date);
    if(bound.id!==retry.id){
      publishDailyReport(store,{driverId:retry.driverId,reportDate:date,actorId:'local_daily_report_worker',jobClaim:retry});
      store.db.prepare("UPDATE daily_report_jobs SET next_at=? WHERE status='pending' AND id<>?").run(pending.next_at+60*60*1000,bound.id);
    }
    const claim=bound.id===retry.id?retry:claimDailyReportJobs(store,date,{now:pending.next_at,limit:1})[0];
    assert.ok(claim);
    assert.equal(claim.id,bound.id);
    store.db.exec("CREATE TRIGGER daily_report_fail_stage3 BEFORE INSERT ON objects WHEN NEW.table_name='notification_events' AND json_extract(NEW.payload,'$.type')='daily_report_ready' BEGIN SELECT RAISE(ABORT,'isolated notification failure'); END;");
    assert.throws(()=>publishDailyReport(store,{driverId:boundId,reportDate:date,actorId:'local_daily_report_worker',jobClaim:claim}),/isolated notification failure/);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM daily_safety_reports WHERE driver_id=?').get(boundId).n,0);
    assert.equal(store.db.prepare('SELECT status FROM daily_report_jobs WHERE id=?').get(claim.id).status,'running');
    store.db.exec('DROP TRIGGER daily_report_fail_stage3');
    const result=publishDailyReport(store,{driverId:boundId,reportDate:date,actorId:'local_daily_report_worker',jobClaim:claim});
    assert.equal(result.notificationCount,1);
    store.db.prepare("UPDATE daily_report_jobs SET next_at=0 WHERE status='pending'").run();
  });

  await t.test('all 500 source jobs complete with one version and no duplicate notices',()=>{
    const started=Date.now();let rounds=0,claimed=0,failed=0;
    for(;rounds<30;rounds++){
      const result=runDailyReportCycle(store,{now:new Date(due.getTime()+10*60*1000),batchSize:20});
      claimed+=result.claimed;failed+=result.failed;
      if(result.due===0)break;
    }
    const elapsedMs=Date.now()-started;
    const jobs=listDailyReportJobs(store,{date});
    assert.equal(jobs.total,500);assert.equal(jobs.byStatus.succeeded,500);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM daily_safety_reports').get().n,500);
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM objects WHERE table_name='notification_events' AND json_extract(payload,'$.type')='daily_report_ready'").get().n,2);
    const replay=runDailyReportCycle(store,{now:new Date(due.getTime()+10*60*1000)});
    assert.equal(replay.claimed,0);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM daily_safety_reports').get().n,500);
    assert.equal(failed,0);
    console.log(JSON.stringify({stage:'daily-report-500',drivers:500,rounds:rounds+1,claimed,failed,elapsedMs}));
  });
});

test('background worker resumes stale jobs after restart without a driver page',async t=>{
  const root=fileURLToPath(new URL('../.source-tests/',import.meta.url));await mkdir(root,{recursive:true});
  const directory=await mkdtemp(join(root,'daily-report-restart-'));
  const date='2026-10-29',due=new Date('2026-10-28T23:00:00Z');
  const first=await openLocalStore({directory});
  ensureDailyReportJobs(first,date);
  const stale=claimDailyReportJobs(first,date,{now:due.getTime(),limit:1,leaseMs:1000})[0];
  first.close();
  const work=await startLocalWorkbench({directory,enableDailyReports:true,pauseOutbox:true,dailyReportClock:()=>new Date('2026-10-29T22:00:00Z')});
  t.after(async()=>{await work.stop();await rm(directory,{recursive:true,force:true});});
  let status;
  for(let i=0;i<100;i++){
    status=work.store.db.prepare('SELECT status FROM daily_report_jobs WHERE id=?').get(stale.id).status;
    if(status==='succeeded')break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(status,'succeeded');
  assert.equal(listDailyReportJobs(work.store,{date:'2026-10-30'}).total,0);
  const account=work.store.accounts.find(x=>x.username==='local_admin');
  const login=await fetch(work.base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(account)});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const jobs=await fetch(work.base+`/api/admin/daily-reports/jobs?date=${date}`,{headers:{cookie}});
  assert.equal(jobs.status,200);assert.equal((await jobs.json()).total,500);
  const adminRow=work.store.get('app_users','local_admin');
  const fleetId=work.store.rows('drivers')[0].fleet_id;
  work.store.put('app_users',{...adminRow,fleet_scope:fleetId},true);
  const scoped=await fetch(work.base+`/api/admin/daily-reports/jobs?date=${date}`,{headers:{cookie}});
  assert.equal(scoped.status,200);
  assert.equal((await scoped.json()).total,work.store.rows('drivers').filter(row=>row.fleet_id===fleetId).length);
  const failures=await fetch(work.base+`/api/admin/daily-reports/jobs?date=${date}&status=failed`,{headers:{cookie}});
  assert.equal(failures.status,200);assert.deepEqual((await failures.json()).rows,[]);
  assert.equal((await fetch(work.base+`/api/admin/daily-reports/jobs?date=${date}&status=unknown`,{headers:{cookie}})).status,400);
  const forbidden=await fetch(work.base+`/api/driver/reports/${stale.id}`,{headers:{cookie}});
  assert.equal(forbidden.status,403);
});

test('failed report jobs stop after the bounded retry budget',async t=>{
  const root=fileURLToPath(new URL('../.source-tests/',import.meta.url));await mkdir(root,{recursive:true});
  const directory=await mkdtemp(join(root,'daily-report-retries-'));
  const store=await openLocalStore({directory});
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  const date='2026-10-30',driverId=store.rows('drivers')[0].driver_id;
  store.db.prepare('INSERT INTO daily_report_jobs(driver_id,report_date) VALUES(?,?)').run(driverId,date);
  let now=Date.parse('2026-10-29T23:00:00Z');
  for(let attempt=1;attempt<=3;attempt++){
    const claim=claimDailyReportJobs(store,date,{now,limit:1})[0];
    assert.equal(claim.attempt,attempt);
    assert.equal(failDailyReportJob(store,claim,new Error('isolated validation failure'),{now}),true);
    const row=store.db.prepare('SELECT status,next_at,attempts FROM daily_report_jobs WHERE id=?').get(claim.id);
    assert.equal(row.status,attempt===3?'failed':'pending');
    now=row.next_at;
  }
  assert.equal(claimDailyReportJobs(store,date,{now:now+60*60*1000,limit:1}).length,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM daily_safety_reports').get().n,0);
});
