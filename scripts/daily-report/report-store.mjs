import { randomBytes } from 'node:crypto';
import { generateDailySafetyReport } from './report-service.mjs';
import { validDay } from './data-reader.mjs';

const id = prefix => `${prefix}-${randomBytes(12).toString('hex')}`;
const parse = row => row ? { id:row.id, reportVersion:row.report_version, publishedAt:row.published_at, report:JSON.parse(row.report_json) } : null;

export function initDailyReportTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS daily_safety_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    driver_id TEXT NOT NULL,
    report_date TEXT NOT NULL,
    report_version INTEGER NOT NULL CHECK(report_version > 0),
    status TEXT NOT NULL CHECK(status IN ('published')),
    is_current INTEGER NOT NULL CHECK(is_current IN (0,1)),
    data_as_of TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    report_json TEXT NOT NULL CHECK(json_valid(report_json)),
    published_at TEXT NOT NULL,
    UNIQUE(driver_id,report_date,report_version)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS daily_report_current_one ON daily_safety_reports(driver_id,report_date) WHERE is_current=1;
  CREATE INDEX IF NOT EXISTS daily_report_driver_history ON daily_safety_reports(driver_id,report_date DESC,report_version DESC);
  CREATE TABLE IF NOT EXISTS driver_safety_goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    driver_id TEXT NOT NULL,
    report_id INTEGER NOT NULL REFERENCES daily_safety_reports(id),
    previous_goal_id INTEGER REFERENCES driver_safety_goals(id),
    goal_type TEXT NOT NULL,
    goal_text TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','dismissed')) DEFAULT 'active',
    feedback_code TEXT CHECK(feedback_code IN ('will_review','need_help','dismissed')),
    feedback_text TEXT,
    updated_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(report_id)
  );
  CREATE INDEX IF NOT EXISTS daily_goal_driver ON driver_safety_goals(driver_id,created_at DESC);
  CREATE TABLE IF NOT EXISTS daily_report_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    driver_id TEXT NOT NULL,
    report_date TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed')) DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_until INTEGER,
    next_at INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    finished_at TEXT,
    error_message TEXT,
    UNIQUE(driver_id,report_date)
  );`);
  const goalColumns=new Set(db.prepare('PRAGMA table_info(driver_safety_goals)').all().map(row=>row.name));
  if (!goalColumns.has('previous_goal_id')) db.exec('ALTER TABLE driver_safety_goals ADD COLUMN previous_goal_id INTEGER REFERENCES driver_safety_goals(id)');
  const columns=new Set(db.prepare('PRAGMA table_info(daily_report_jobs)').all().map(row=>row.name));
  if (!columns.has('lease_token')) db.exec('ALTER TABLE daily_report_jobs ADD COLUMN lease_token TEXT');
  if (!columns.has('lease_until')) db.exec('ALTER TABLE daily_report_jobs ADD COLUMN lease_until INTEGER');
  if (!columns.has('next_at')) db.exec('ALTER TABLE daily_report_jobs ADD COLUMN next_at INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS daily_report_job_due ON daily_report_jobs(report_date,status,next_at,lease_until)');
}

export function publishDailyReport(store,{driverId,reportDate,actorId,revise=false,jobClaim=null}) {
  if (!validDay(reportDate) || typeof driverId!=='string' || typeof actorId!=='string' || !actorId) throw new Error('invalid_report_request');
  const report=generateDailySafetyReport(store,driverId,reportDate);
  return store.transaction(()=>{
    const db=store.db;
    if (jobClaim) {
      const owned=db.prepare("SELECT id FROM daily_report_jobs WHERE id=? AND driver_id=? AND report_date=? AND status='running' AND lease_token=?").get(jobClaim.id,driverId,reportDate,jobClaim.leaseToken);
      if (!owned) throw new Error('stale_daily_report_claim');
    }
    const finishJob=()=>{if(jobClaim) db.prepare("UPDATE daily_report_jobs SET status='succeeded',finished_at=?,lease_token=NULL,lease_until=NULL,next_at=0,error_message=NULL WHERE id=? AND lease_token=?").run(new Date().toISOString(),jobClaim.id,jobClaim.leaseToken);};
    const current=db.prepare('SELECT * FROM daily_safety_reports WHERE driver_id=? AND report_date=? AND is_current=1').get(driverId,reportDate);
    if (current?.source_fingerprint===report.sourceFingerprint) {finishJob();return { ...parse(current), idempotentReplay:true, notificationCount:0 };}
    if (current && !revise) throw new Error('report_revision_required');
    const version=(db.prepare('SELECT MAX(report_version) n FROM daily_safety_reports WHERE driver_id=? AND report_date=?').get(driverId,reportDate).n || 0)+1;
    const at=new Date().toISOString();
    if (current) db.prepare('UPDATE daily_safety_reports SET is_current=0 WHERE id=?').run(current.id);
    const result=db.prepare(`INSERT INTO daily_safety_reports(driver_id,report_date,report_version,status,is_current,data_as_of,source_fingerprint,report_json,published_at)
      VALUES(?,?,?,'published',1,?,?,?,?)`).run(driverId,reportDate,version,report.dataAsOf,report.sourceFingerprint,JSON.stringify(report),at);
    const reportId=Number(result.lastInsertRowid);
    if (report.dailyGoal) db.prepare(`INSERT INTO driver_safety_goals(driver_id,report_id,previous_goal_id,goal_type,goal_text,created_at) VALUES(?,?,?,?,?,?)`).run(driverId,reportId,report.goalTracking?.previousGoalId||null,report.dailyGoal.type,report.dailyGoal.description,at);
    const recipients=store.rows('app_users').filter(user=>user.role==='driver' && user.driver_id===driverId && user.binding_verified && user.account_status==='active');
    for (const user of recipients) store.put('notification_events',{
      notification_id:id('daily-report-note'),target_user_id:user.user_id,target_role:'driver',source_entity_type:'daily_safety_report',source_entity_id:String(reportId),type:'daily_report_ready',
      title:'每日安全简报已生成',body:`${reportDate} 的历史安全简报已可查看。`,content:`${reportDate} 的历史安全简报已可查看。`,
      idempotency_key:`daily_report_ready:${driverId}:${reportDate}:${version}:${user.user_id}`,created_at:at,read_at:null,
    });
    store.put('audit_logs',{audit_id:id('daily-report-audit'),actor_id:actorId,actor_role:jobClaim?'system':'safety_admin',action:'daily_report.publish',entity_type:'daily_safety_report',entity_id:String(reportId),old_status:current?'published':null,new_status:'published',occurred_at:at,detail_json:JSON.stringify({driver_id:driverId,report_date:reportDate,report_version:version,source_fingerprint:report.sourceFingerprint})});
    finishJob();
    return { id:reportId,reportVersion:version,publishedAt:at,report,idempotentReplay:false,notificationCount:recipients.length };
  });
}

export function getDailyReport(store,driverId,{id:reportId,date}={}) {
  const db=store.db;
  let row;
  if (reportId!==undefined) row=db.prepare('SELECT * FROM daily_safety_reports WHERE id=? AND driver_id=? AND status=\'published\'').get(reportId,driverId);
  else if (date) row=db.prepare('SELECT * FROM daily_safety_reports WHERE driver_id=? AND report_date=? AND is_current=1 AND status=\'published\'').get(driverId,date);
  else throw new Error('invalid_report_lookup');
  return parse(row);
}

export function listDailyReports(store,driverId,{limit=20,offset=0}={}) {
  if (!Number.isInteger(limit)||limit<1||limit>50||!Number.isInteger(offset)||offset<0) throw new Error('invalid_pagination');
  const db=store.db;
  const total=db.prepare("SELECT COUNT(*) n FROM daily_safety_reports WHERE driver_id=? AND status='published'").get(driverId).n;
  const rows=db.prepare("SELECT id,report_date,report_version,is_current,published_at,report_json FROM daily_safety_reports WHERE driver_id=? AND status='published' ORDER BY report_date DESC,report_version DESC LIMIT ? OFFSET ?").all(driverId,limit,offset).map(row=>({id:row.id,reportDate:row.report_date,reportVersion:row.report_version,isCurrent:Boolean(row.is_current),publishedAt:row.published_at,title:JSON.parse(row.report_json).title}));
  return {rows,total,limit,offset};
}

export function listSafetyGoals(store,driverId) {
  return store.db.prepare('SELECT id,report_id,previous_goal_id,goal_type,goal_text,status,feedback_code,feedback_text,updated_at,created_at FROM driver_safety_goals WHERE driver_id=? ORDER BY created_at DESC,id DESC LIMIT 100').all(driverId).map(row=>({id:row.id,reportId:row.report_id,previousGoalId:row.previous_goal_id,type:row.goal_type,description:row.goal_text,status:row.status,feedbackCode:row.feedback_code,feedbackText:row.feedback_text,updatedAt:row.updated_at,createdAt:row.created_at}));
}

export function listDailyReportNotifications(store,driverId,userId) {
  const rows=store.db.prepare(`SELECT o.payload FROM objects o JOIN daily_safety_reports r ON r.id=CAST(json_extract(o.payload,'$.source_entity_id') AS INTEGER)
    WHERE o.table_name='notification_events' AND json_extract(o.payload,'$.type')='daily_report_ready'
      AND json_extract(o.payload,'$.target_user_id')=? AND r.driver_id=?
    ORDER BY json_extract(o.payload,'$.created_at') DESC LIMIT 50`).all(userId,driverId).map(row=>JSON.parse(row.payload));
  return {rows:rows.map(row=>({notification_id:row.notification_id,source_entity_id:row.source_entity_id,type:row.type,title:row.title,content:row.content,created_at:row.created_at,read_at:row.read_at}))};
}

export function feedbackSafetyGoal(store,driverId,goalId,{code,text='',actorId=driverId}) {
  if (!['will_review','need_help','dismissed'].includes(code) || typeof text!=='string' || text.length>500) throw new Error('invalid_goal_feedback');
  return store.transaction(()=>{
    const row=store.db.prepare('SELECT * FROM driver_safety_goals WHERE id=? AND driver_id=?').get(goalId,driverId);
    if (!row) return null;
    if (row.feedback_code===code && row.feedback_text===text) return {id:row.id,status:row.status,feedbackCode:code,updatedAt:row.updated_at,idempotentReplay:true};
    const at=new Date().toISOString(),status=code==='dismissed'?'dismissed':'active';
    store.db.prepare('UPDATE driver_safety_goals SET status=?,feedback_code=?,feedback_text=?,updated_at=? WHERE id=?').run(status,code,text,at,goalId);
    store.put('audit_logs',{audit_id:id('daily-goal-audit'),actor_id:actorId,actor_role:'driver',action:'daily_goal.feedback',entity_type:'driver_safety_goal',entity_id:String(goalId),old_status:row.status,new_status:status,occurred_at:at,detail_json:JSON.stringify({feedback_code:code})});
    return {id:goalId,status,feedbackCode:code,updatedAt:at,idempotentReplay:false};
  });
}
