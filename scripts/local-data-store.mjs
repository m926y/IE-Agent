import { DatabaseSync } from "node:sqlite";
import { readFile, realpath, mkdir, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { initDailyReportTables } from './daily-report/report-store.mjs';

const allowedRoot = fileURLToPath(new URL("../../IE亮剑/", import.meta.url));
export function parseCsv(text) {
  const rows = []; let row = [], value = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(value); value = ""; }
    else if ((c === '\n' || c === '\r') && !quoted) { if (c === '\r' && text[i + 1] === '\n') i++; row.push(value); if (row.some(v => v !== "")) rows.push(row); row = []; value = ""; }
    else value += c;
  }
  if (quoted) throw new Error("CSV has unclosed quotation");
  if (value || row.length) { row.push(value); rows.push(row); }
  const headers = (rows.shift() || []).map(s => s.replace(/^\uFEFF/, ""));
  return { headers, rows: rows.map(values => { if (values.length !== headers.length) throw new Error("CSV column count mismatch"); return Object.fromEntries(headers.map((h, i) => [h, values[i]])); }) };
}
function within(root, path) { const r = relative(root, path); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); }
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const pk = { drivers: "driver_id", score_snapshots: "score_id", score_history: "score_id", risk_snapshots: "snapshot_id", deduction_ledger: "ledger_id", review_queue: "queue_id", replay_events: "event_id", alerts: "alert_id", interventions: "intervention_id", training_tasks: "task_id", training_courses: "course_id", evaluation_rules: "dimension", operation_config: "config_id", user_bindings: "binding_id", audit_logs: "audit_id", app_users: "user_id", app_sessions: "session_id", notification_events: "notification_id", review_requests: "request_id", driver_profiles: "user_id", knowledge_articles: "article_id", evaluation_rule_drafts: "draft_id", import_runs: "run_id", notification_templates: "template_id" };
const immutable = new Set(["drivers", "score_snapshots", "score_history", "risk_snapshots", "deduction_ledger", "review_queue", "replay_events", "evaluation_rules"]);
export async function openLocalStore({ directory, sourceRoot = allowedRoot } = {}) {
  const allowed = await realpath(allowedRoot), source = await realpath(sourceRoot);
  if (!within(allowed, source)) throw new Error("Only IE亮剑 source files are allowed");
  const importRoot = await realpath(join(source, "outputs/agent_starter/import"));
  if (!within(allowed, importRoot)) throw new Error("Source directory escapes IE亮剑");
  directory = resolve(directory || fileURLToPath(new URL("../.local/", import.meta.url)));
  await mkdir(directory, { recursive: true });
  const dictionary = JSON.parse(await readFile(join(source, "outputs/agent_starter/data_dictionary.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(source, "outputs/agent_starter/manifest.json"), "utf8"));
  const datasets = [], provenance = [];
  for (const [table, spec] of Object.entries(manifest.tables)) {
    if (!Object.hasOwn(pk, table)) throw new Error(`Unknown source table ${table}`);
    const path = await realpath(join(importRoot, table + ".csv"));
    if (!within(allowed, path)) throw new Error("Source file escapes IE亮剑");
    const bytes = await readFile(path), csv = parseCsv(bytes.toString("utf8"));
    if (csv.rows.length !== spec.rows) throw new Error(`Source row count mismatch: ${table}`);
    const types = new Map((dictionary[table] || []).map(x => [x.field, x.suggested_type]));
    const converted = csv.rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => {
      const type = types.get(key);
      if (value === "") return [key, null];
      if (type === "boolean") { if (!["true", "false"].includes(value.toLowerCase())) throw new Error(`Invalid boolean ${table}.${key}`); return [key, value.toLowerCase() === "true"]; }
      if (type === "number") { const n = Number(value); if (!Number.isFinite(n)) throw new Error(`Invalid number ${table}.${key}`); return [key, n]; }
      return [key, value];
    })));
    if (table === "training_courses") for (const row of converted) { row.version_no = 0; row.source_version = "file_sha256:" + hash(bytes); }
    datasets.push({ table, rows: converted });
    provenance.push({ table, file: relative(allowed, path).replaceAll("\\", "/"), rows: converted.length, sha256: hash(bytes) });
  }
  const sourceHash = hash(JSON.stringify(provenance));
  const db = new DatabaseSync(join(directory, "workbench.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS objects (table_name TEXT NOT NULL, record_id TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(table_name,record_id));
    CREATE UNIQUE INDEX IF NOT EXISTS unique_idempotency ON objects(table_name,json_extract(payload,'$.idempotency_key')) WHERE table_name IN ('training_tasks','notification_events','review_requests') AND json_extract(payload,'$.idempotency_key') IS NOT NULL;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox (task_id TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,last_error TEXT,PRIMARY KEY(task_id,kind));
    CREATE TRIGGER IF NOT EXISTS enqueue_assignment AFTER INSERT ON objects WHEN NEW.table_name='training_tasks' AND json_extract(NEW.payload,'$.status')='assigned' BEGIN INSERT OR IGNORE INTO outbox(task_id,kind) VALUES(NEW.record_id,'assigned'); END;
    CREATE TRIGGER IF NOT EXISTS enqueue_submission AFTER UPDATE ON objects WHEN NEW.table_name='training_tasks' AND json_extract(NEW.payload,'$.status')='submitted' AND json_extract(OLD.payload,'$.status') IS NOT 'submitted' BEGIN INSERT OR IGNORE INTO outbox(task_id,kind) VALUES(NEW.record_id,'submitted'); END;
    CREATE TRIGGER IF NOT EXISTS local_task_insert_audit AFTER INSERT ON objects WHEN NEW.table_name='training_tasks' BEGIN
      INSERT INTO objects(table_name,record_id,payload) VALUES('audit_logs','sqlite-task-'||NEW.record_id,json_object('audit_id','sqlite-task-'||NEW.record_id,'actor_id','local_sqlite_transaction','actor_role','system','action','local.training.insert','entity_type','training_task','entity_id',NEW.record_id,'old_status',NULL,'new_status',json_extract(NEW.payload,'$.status'),'occurred_at',strftime('%Y-%m-%dT%H:%M:%fZ','now'))); END;
    CREATE TRIGGER IF NOT EXISTS local_task_update_audit AFTER UPDATE ON objects WHEN NEW.table_name='training_tasks' AND json_extract(NEW.payload,'$.status') IS NOT json_extract(OLD.payload,'$.status') BEGIN
      INSERT INTO objects(table_name,record_id,payload) VALUES('audit_logs','sqlite-transition-'||NEW.record_id||'-'||json_extract(NEW.payload,'$.updated_at'),json_object('audit_id','sqlite-transition-'||NEW.record_id||'-'||json_extract(NEW.payload,'$.updated_at'),'actor_id','local_sqlite_transaction','actor_role','system','action','local.training.transition','entity_type','training_task','entity_id',NEW.record_id,'old_status',json_extract(OLD.payload,'$.status'),'new_status',json_extract(NEW.payload,'$.status'),'occurred_at',strftime('%Y-%m-%dT%H:%M:%fZ','now'))); END;`);
  const get = (table, id) => { const r = db.prepare("SELECT payload FROM objects WHERE table_name=? AND record_id=?").get(table, String(id)); return r ? JSON.parse(r.payload) : null; };
  const rows = table => db.prepare("SELECT payload FROM objects WHERE table_name=? ORDER BY record_id").all(table).map(x => JSON.parse(x.payload));
  function transaction(fn) { db.exec("BEGIN IMMEDIATE"); try { const result = fn(); db.exec("COMMIT"); return result; } catch (e) { db.exec("ROLLBACK"); throw e; } }
  function put(table, row, upsert = false) {
    const id = row[pk[table]];
    if (id == null || id === "") throw new Error(`Missing primary key ${table}`);
    db.prepare(`INSERT INTO objects(table_name,record_id,payload) VALUES(?,?,?) ${upsert ? "ON CONFLICT(table_name,record_id) DO UPDATE SET payload=excluded.payload" : ""}`).run(table, String(id), JSON.stringify(row));
    return row;
  }
  const previous = db.prepare("SELECT value FROM metadata WHERE key='source_hash'").get()?.value;
  if (previous && previous !== sourceHash) { db.close(); throw new Error("Source files changed. Use a new local database directory; existing state was not overwritten."); }
  initDailyReportTables(db);
  // Additive local upgrade: existing business rows and the training outbox remain intact.
  db.exec(`CREATE TABLE IF NOT EXISTS review_outbox (
    request_id TEXT NOT NULL,kind TEXT NOT NULL,target_user_id TEXT,content TEXT,
    status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,last_error TEXT,
    PRIMARY KEY(request_id,kind));
    CREATE TRIGGER IF NOT EXISTS enqueue_review_request AFTER INSERT ON objects WHEN NEW.table_name='review_requests' BEGIN
      INSERT OR IGNORE INTO review_outbox(request_id,kind,target_user_id) VALUES(NEW.record_id,'submitted',json_extract(NEW.payload,'$.reminder_target_user_id'));
      INSERT INTO objects(table_name,record_id,payload) VALUES('audit_logs','sqlite-review-'||NEW.record_id,json_object('audit_id','sqlite-review-'||NEW.record_id,'actor_id','local_sqlite_transaction','actor_role','system','action','local.review.insert','entity_type','review_request','entity_id',NEW.record_id,'new_status',json_extract(NEW.payload,'$.status'),'occurred_at',strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    END;
    CREATE TRIGGER IF NOT EXISTS enqueue_review_answer AFTER UPDATE ON objects WHEN NEW.table_name='review_requests' AND json_extract(NEW.payload,'$.status') IN ('answered','closed') AND json_extract(OLD.payload,'$.status') IS NOT json_extract(NEW.payload,'$.status') BEGIN
      INSERT OR IGNORE INTO review_outbox(request_id,kind,target_user_id,content) VALUES(NEW.record_id,json_extract(NEW.payload,'$.status'),json_extract(NEW.payload,'$.reminder_target_user_id'),json_extract(NEW.payload,'$.reminder_text'));
    END;
    CREATE TRIGGER IF NOT EXISTS local_review_update_audit AFTER UPDATE ON objects WHEN NEW.table_name='review_requests' AND json_extract(NEW.payload,'$.status') IS NOT json_extract(OLD.payload,'$.status') BEGIN
      INSERT INTO objects(table_name,record_id,payload) SELECT 'audit_logs',audit_id,json_object('audit_id',audit_id,'actor_id','local_sqlite_transaction','actor_role','system','action','local.review.transition','entity_type','review_request','entity_id',NEW.record_id,'old_status',json_extract(OLD.payload,'$.status'),'new_status',json_extract(NEW.payload,'$.status'),'occurred_at',strftime('%Y-%m-%dT%H:%M:%fZ','now')) FROM (SELECT 'sqlite-review-transition-'||lower(hex(randomblob(16))) AS audit_id);
    END;`);
  // Restore reminders for pre-upgrade open requests, without rewriting requests or approvals.
  db.exec(`INSERT OR IGNORE INTO review_outbox(request_id,kind,target_user_id)
    SELECT record_id,'submitted',json_extract(payload,'$.reminder_target_user_id') FROM objects
    WHERE table_name='review_requests' AND json_extract(payload,'$.status') IN ('submitted','checking','awaiting_data_owner');`);
  let accounts;
  if (!previous) {
    const drivers = datasets.find(x => x.table === "drivers").rows;
    const eventDriver = datasets.find(x => x.table === "replay_events").rows.find(x => x.driver_id)?.driver_id;
    const first = drivers.find(x => x.driver_id === eventDriver) || drivers[0], second = drivers.find(x => x.driver_id !== first.driver_id);
    const definitions = [{ username: "local_admin", role: "safety_admin", driver: null }, { username: "local_driver", role: "driver", driver: first }, { username: "local_other", role: "driver", driver: second }];
    accounts = definitions.map(x => ({ username: x.username, password: randomBytes(18).toString("hex"), role: x.role, driver_id: x.driver?.driver_id || null }));
    await writeFile(join(directory, "accounts.json"), JSON.stringify(accounts, null, 2), { mode: 0o600 });
    transaction(() => {
      for (const d of datasets) for (const row of d.rows) put(d.table, row);
      definitions.forEach((x, i) => {
        const salt = randomBytes(16), key = scryptSync(accounts[i].password, salt, 64, { N: 16384, r: 8, p: 1 });
        put("app_users", { user_id: x.username, username: x.username, password_hash: `scrypt$16384$8$1$${salt.toString("hex")}$${key.toString("hex")}`, display_name: x.driver?.display_name || "本地联调管理员", role: x.role, fleet_scope: x.role === "safety_admin" ? "*" : x.driver.fleet_id, driver_id: x.driver?.driver_id || null, binding_verified: Boolean(x.driver), binding_note: "IE亮剑来源演示映射，仅用于本地联调，非真实身份核验", account_status: "active" });
      });
      db.prepare("INSERT INTO metadata(key,value) VALUES('source_hash',?)").run(sourceHash);
    });
  } else accounts = JSON.parse(await readFile(join(directory, "accounts.json"), "utf8"));
  await writeFile(join(directory, "source-manifest.json"), JSON.stringify({ source_root: allowed, source_hash: sourceHash, imported: provenance, technical_accounts: "Generated locally; driver mappings come from IE亮剑 drivers.csv. No invented risk/score/course records." }, null, 2));
  function drainOutbox({ force = false } = {}) {
    const due = db.prepare("SELECT * FROM outbox WHERE status='pending' AND next_at<=? ORDER BY task_id,kind LIMIT 100").all(force ? Number.MAX_SAFE_INTEGER : Date.now());
    let failure;
    for (const item of due) { try { transaction(() => {
      const task = get("training_tasks", item.task_id);
      if (!task || (item.kind === "assigned" ? task.status !== "assigned" : task.status !== "submitted")) { db.prepare("UPDATE outbox SET status='not_needed' WHERE task_id=? AND kind=?").run(item.task_id, item.kind); return; }
      const users = rows("app_users").filter(x => x.account_status === "active");
      const fleet = get("drivers", task.driver_id)?.fleet_id;
      const target = item.kind === "assigned" ? users.find(x => x.role === "driver" && x.driver_id === task.driver_id && x.binding_verified) : users.filter(x => x.role === "safety_admin" && (!x.fleet_scope || x.fleet_scope === "*" || x.fleet_scope === fleet)).sort((a,b) => Number(b.user_id === task.created_by)-Number(a.user_id === task.created_by))[0];
      if (!target) { db.prepare("UPDATE outbox SET attempts=attempts+1,next_at=?,last_error='no_recipient' WHERE task_id=? AND kind=?").run(Date.now()+30000,item.task_id,item.kind); return; }
      const idem = `notif:${item.kind === "assigned" ? "taskas" : "tasksub"}:${item.task_id}`;
      const existing = rows("notification_events").find(x => x.idempotency_key === idem);
      if (existing && existing.target_user_id !== target.user_id) { db.prepare("UPDATE outbox SET attempts=attempts+1,next_at=?,last_error='recipient_changed' WHERE task_id=? AND kind=?").run(Date.now()+30000,item.task_id,item.kind); return; }
      if (!existing) {
        const text = item.kind === "assigned" ? task.course_snapshot?.assignment_notice?.text || `培训任务 ${task.task_id}，请查看课程与完成要求。` : `培训任务 ${task.task_id} 已提交，请进行人工复核。`;
        put("notification_events", { notification_id: "local-noti-"+randomBytes(8).toString("hex"), target_user_id: target.user_id, target_role: target.role, source_entity_type: "training_task", source_entity_id: task.task_id, type: item.kind === "assigned" ? "task_assigned" : "task_submitted", title: "培训任务进展", body: text, content: text, idempotency_key: idem, read_at: null, created_at: new Date().toISOString() });
      }
      put("audit_logs", { audit_id: "local-outbox-"+randomBytes(8).toString("hex"), actor_id: "local_outbox_worker", actor_role: "system", action: "local.notification_recorded", entity_type: "training_task", entity_id: task.task_id, occurred_at: new Date().toISOString() });
      db.prepare("UPDATE outbox SET status='recorded',attempts=attempts+1,last_error=NULL WHERE task_id=? AND kind=?").run(item.task_id,item.kind);
    }); } catch (error) {
      db.prepare("UPDATE outbox SET attempts=attempts+1,next_at=?,last_error='delivery_failed' WHERE task_id=? AND kind=?").run(Date.now()+30000,item.task_id,item.kind);
      failure ||= error;
    } }
    try { drainReviewOutbox(force); } catch (error) { failure ||= error; }
    if (failure) throw failure;
    return db.prepare("SELECT * FROM outbox ORDER BY task_id,kind").all();
  }
  function drainReviewOutbox(force) {
    const due = db.prepare("SELECT * FROM review_outbox WHERE status='pending' AND next_at<=? ORDER BY request_id,kind LIMIT 100").all(force ? Number.MAX_SAFE_INTEGER : Date.now());
    let failure;
    for (const item of due) {
      // Resolve an initially missing recipient once, then persist that identity before delivery.
      // Later account/scope changes leave the reminder pending rather than redirecting it.
      const request = get("review_requests", item.request_id), fleet = request && get("drivers", request.driver_id)?.fleet_id;
      const eligible = x => x.account_status === "active" && (item.kind === "submitted"
        ? x.role === "safety_admin" && fleet && ["*",fleet].includes(x.fleet_scope)
        : x.role === "driver" && x.driver_id === request?.driver_id && x.binding_verified);
      if (!item.target_user_id) {
        const candidate = rows("app_users").find(eligible);
        if (candidate) {
          db.prepare("UPDATE review_outbox SET target_user_id=? WHERE request_id=? AND kind=? AND target_user_id IS NULL").run(candidate.user_id,item.request_id,item.kind);
          item.target_user_id = candidate.user_id;
        }
      }
      try { transaction(() => {
        const row = get("review_requests",item.request_id);
        const valid = row && (item.kind === "submitted" ? ["submitted","checking","awaiting_data_owner"].includes(row.status) : row.status === item.kind);
        if (!valid) { db.prepare("UPDATE review_outbox SET status='not_needed' WHERE request_id=? AND kind=?").run(item.request_id,item.kind); return; }
        const target = item.target_user_id && get("app_users",item.target_user_id);
        if (!target || !eligible(target)) {
          db.prepare("UPDATE review_outbox SET attempts=attempts+1,next_at=?,last_error=? WHERE request_id=? AND kind=?").run(Date.now()+30000,target ? 'recipient_unavailable' : 'no_recipient',item.request_id,item.kind); return;
        }
        const idem = item.kind === "submitted" ? `notif:rr:${item.request_id}` : `notif:rra:${item.request_id}:${item.kind}`;
        const existing = rows("notification_events").find(x=>x.idempotency_key===idem);
        if (existing && existing.target_user_id !== target.user_id) {
          db.prepare("UPDATE review_outbox SET attempts=attempts+1,next_at=?,last_error='recipient_changed' WHERE request_id=? AND kind=?").run(Date.now()+30000,item.request_id,item.kind); return;
        }
        if (!existing) {
          const text = item.content || (item.kind === "submitted" ? `复核申请 ${item.request_id} 待处理，请查看申请原文。` : `复核申请 ${item.request_id} 状态：${item.kind}，请查看已保存答复。`);
          put("notification_events",{notification_id:'local-review-noti-'+randomBytes(8).toString('hex'),target_user_id:target.user_id,target_role:target.role,source_entity_type:'review_request',source_entity_id:item.request_id,type:item.kind==='submitted'?'rr_submitted':'rr_answered',title:'复核申请进展',body:text.slice(0,500),content:text.slice(0,500),idempotency_key:idem,read_at:null,created_at:new Date().toISOString()});
        }
        put("audit_logs",{audit_id:'local-review-outbox-'+randomBytes(8).toString('hex'),actor_id:'local_outbox_worker',actor_role:'system',action:'local.review.notification_recorded',entity_type:'review_request',entity_id:item.request_id,occurred_at:new Date().toISOString()});
        db.prepare("UPDATE review_outbox SET status='recorded',attempts=attempts+1,last_error=NULL WHERE request_id=? AND kind=?").run(item.request_id,item.kind);
      }); } catch (error) {
        db.prepare("UPDATE review_outbox SET attempts=attempts+1,next_at=?,last_error='delivery_failed' WHERE request_id=? AND kind=?").run(Date.now()+30000,item.request_id,item.kind);
        failure ||= error;
      }
    }
    if (failure) throw failure;
  }
  return { db, get, rows, put, transaction, drainOutbox, accounts, provenance, directory, sourceHash, immutable, pk, close: () => db.close() };
}

function splitTop(text) {
  const result=[]; let start=0, depth=0, quoted=false;
  for(let i=0;i<text.length;i++){ if(text[i]==='"') quoted=!quoted; if(!quoted){ if(text[i]==='(')depth++; if(text[i]===')')depth--; if(text[i]===','&&depth===0){result.push(text.slice(start,i));start=i+1;} } }
  result.push(text.slice(start)); return result;
}
export function compileFilters(params) {
  const bind=[];
  const field = key => { if(!/^[a-z_][a-z0-9_]*$/.test(key)) throw new Error("Invalid filter field"); return `json_extract(payload,'$.${key}')`; };
  const filter = (key, value) => {
    if(key==='and'||key==='or') { if(!value.startsWith('(')||!value.endsWith(')'))throw new Error("Invalid group"); return '('+splitTop(value.slice(1,-1)).map(term=>{const i=term.indexOf('.');return filter(term.slice(0,i),term.slice(i+1));}).join(key==='and'?' AND ':' OR ')+')'; }
    const col=field(key), match=/^(not\.)?(eq|neq|gt|gte|lt|lte|is|in|like|ilike)\.(.*)$/.exec(value);
    if(!match)throw new Error("Unsupported local filter");
    const [,neg,op,raw]=match;
    const parse = v => v==='true'?1:v==='false'?0:v.replace(/^"|"$/g,'');
    let sql;
    if(op==='is') { if(raw!=='null')throw new Error("Only is.null supported"); sql=col+' IS NULL'; }
    else if(op==='in') { const values=splitTop(raw.slice(1,-1)).map(parse); if(!raw.startsWith('(')||!raw.endsWith(')'))throw new Error("Invalid in"); bind.push(...values); sql=col+' IN ('+values.map(()=>'?').join(',')+')'; }
    else { bind.push(op==='like'||op==='ilike'?raw.replaceAll('*','%'):parse(raw)); const operators={eq:'=',neq:'!=',gt:'>',gte:'>=',lt:'<',lte:'<=',like:'LIKE',ilike:'LIKE'}; sql=col+' '+operators[op]+' ?'; }
    return neg?'NOT ('+sql+')':sql;
  };
  const clauses=[];
  for(const [key,value] of params) { if(['select','order','limit','offset','on_conflict'].includes(key))continue; clauses.push(filter(key,value)); }
  return { sql: clauses.length?' AND '+clauses.join(' AND '):'', bind };
}
