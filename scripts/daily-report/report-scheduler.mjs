import { randomBytes } from 'node:crypto';
import { publishDailyReport } from './report-store.mjs';

const MAX_ATTEMPTS=3, LEASE_MS=5*60*1000;
const token=()=>randomBytes(16).toString('hex');
const timeParts=now=>Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
export function dailyReportBusinessClock(now=new Date()) {
  const parts=timeParts(now);
  return {date:`${parts.year}-${parts.month}-${parts.day}`,minutes:Number(parts.hour)*60+Number(parts.minute)};
}

export function ensureDailyReportJobs(store,date) {
  const drivers=store.rows('drivers').filter(row=>typeof row.driver_id==='string'&&row.driver_id);
  return store.transaction(()=>{
    const insert=store.db.prepare('INSERT OR IGNORE INTO daily_report_jobs(driver_id,report_date) VALUES(?,?)');
    let created=0;
    for(const driver of drivers) created+=insert.run(driver.driver_id,date).changes;
    return created;
  });
}

export function claimDailyReportJobs(store,date,{now=Date.now(),limit=20,leaseMs=LEASE_MS}={}) {
  if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(leaseMs)||leaseMs<1000) throw new Error('invalid_job_claim');
  return store.transaction(()=>{
    const db=store.db;
    db.prepare("UPDATE daily_report_jobs SET status='failed',finished_at=?,lease_token=NULL,lease_until=NULL,error_message='maximum attempts reached' WHERE report_date=? AND status='running' AND lease_until<=? AND attempts>=?").run(new Date(now).toISOString(),date,now,MAX_ATTEMPTS);
    const due=db.prepare("SELECT id,driver_id,report_date,attempts FROM daily_report_jobs WHERE report_date=? AND attempts<? AND ((status='pending' AND next_at<=?) OR (status='running' AND lease_until<=?)) ORDER BY id LIMIT ?").all(date,MAX_ATTEMPTS,now,now,limit);
    const update=db.prepare("UPDATE daily_report_jobs SET status='running',attempts=attempts+1,lease_token=?,lease_until=?,started_at=?,finished_at=NULL,error_message=NULL WHERE id=?");
    return due.map(row=>{const leaseToken=token();update.run(leaseToken,now+leaseMs,new Date(now).toISOString(),row.id);return {id:row.id,driverId:row.driver_id,reportDate:row.report_date,leaseToken,attempt:row.attempts+1};});
  });
}

export function failDailyReportJob(store,claim,error,{now=Date.now()}={}) {
  const message=String(error?.message||error||'report_generation_failed').slice(0,300);
  return store.transaction(()=>{
    const row=store.db.prepare("SELECT attempts FROM daily_report_jobs WHERE id=? AND status='running' AND lease_token=?").get(claim.id,claim.leaseToken);
    if(!row) return false;
    const exhausted=row.attempts>=MAX_ATTEMPTS;
    store.db.prepare("UPDATE daily_report_jobs SET status=?,next_at=?,finished_at=?,lease_token=NULL,lease_until=NULL,error_message=? WHERE id=? AND lease_token=?").run(exhausted?'failed':'pending',exhausted?0:now+Math.min(60000*2**(row.attempts-1),5*60000),new Date(now).toISOString(),message,claim.id,claim.leaseToken);
    return true;
  });
}

export function listDailyReportJobs(store,{date,limit=50,offset=0,fleetId=null,status=null}={}) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date||'')||!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||status!==null&&!['pending','running','succeeded','failed'].includes(status)) throw new Error('invalid_job_query');
  const db=store.db;
  const scope=fleetId?" AND EXISTS(SELECT 1 FROM objects d WHERE d.table_name='drivers' AND d.record_id=j.driver_id AND json_extract(d.payload,'$.fleet_id')=?)":'';
  const args=fleetId?[date,fleetId]:[date];
  const totals=db.prepare(`SELECT j.status,COUNT(*) n FROM daily_report_jobs j WHERE j.report_date=?${scope} GROUP BY j.status`).all(...args);
  const rows=db.prepare(`SELECT j.id,j.driver_id,j.report_date,j.status,j.attempts,j.started_at,j.finished_at,j.error_message FROM daily_report_jobs j WHERE j.report_date=?${scope}${status?' AND j.status=?':''} ORDER BY j.id LIMIT ? OFFSET ?`).all(...args,...(status?[status]:[]),limit,offset);
  return {date,total:totals.reduce((n,row)=>n+row.n,0),byStatus:Object.fromEntries(totals.map(row=>[row.status,row.n])),rows,limit,offset};
}

export function runDailyReportCycle(store,{now=new Date(),batchSize=20,onJob}={}) {
  const clock=dailyReportBusinessClock(now),started=Date.now();
  const todayDue=clock.minutes>=7*60;
  const created=todayDue?ensureDailyReportJobs(store,clock.date):0;
  const date=store.db.prepare(`SELECT report_date FROM daily_report_jobs
    WHERE (report_date<? OR (report_date=? AND ?))
      AND ((status='pending' AND attempts<? AND next_at<=?) OR (status='running' AND lease_until<=?))
    ORDER BY report_date,id LIMIT 1`).get(clock.date,clock.date,todayDue?1:0,MAX_ATTEMPTS,now.getTime(),now.getTime())?.report_date;
  if(!date) return {date:clock.date,notDue:!todayDue,created,claimed:0,succeeded:0,failed:0,due:0,elapsedMs:Date.now()-started};
  const claims=claimDailyReportJobs(store,date,{now:now.getTime(),limit:batchSize});
  let succeeded=0,failed=0;
  for(const claim of claims){
    try{
      if(onJob) onJob(claim);
      publishDailyReport(store,{driverId:claim.driverId,reportDate:claim.reportDate,actorId:'local_daily_report_worker',jobClaim:claim});
      succeeded++;
    }catch(error){failDailyReportJob(store,claim,error,{now:now.getTime()});failed++;}
  }
  const due=store.db.prepare(`SELECT COUNT(*) n FROM daily_report_jobs
    WHERE (report_date<? OR (report_date=? AND ?)) AND attempts<?
      AND ((status='pending' AND next_at<=?) OR (status='running' AND lease_until<=?))`).get(clock.date,clock.date,todayDue?1:0,MAX_ATTEMPTS,now.getTime(),now.getTime()).n;
  return {date:clock.date,processingDate:date,notDue:false,created,claimed:claims.length,succeeded,failed,due,elapsedMs:Date.now()-started};
}
