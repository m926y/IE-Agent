// Crazy Logi-AI 2.0 驾驶安全管理工作台 — QW Pages dynamic entrypoint.
// 单文件服务端：认证、授权、数据库访问、审计。零运行时依赖（仅 Node 22 内置模块 + fetch）。
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { actionCenter, scoreComparison, fleetStatistics, readAll } from "./server/driver-actions.mjs";
import { readDriverFacts, validDay } from "./server/daily-report/data-reader.mjs";
import { computeDriverSnapshot } from "./server/daily-report/safety-analyzer.mjs";
import { organizeDailyReport } from "./server/daily-report/report-agent.mjs";
import { validateDailySafetyReport } from "./server/daily-report/report-validator.mjs";
import { allowedNumberStrings, verifyNarrative, personalizerMessages } from "./server/daily-report/report-personalizer.mjs";

const scrypt = promisify(scryptCb);

const host = process.env.HOST;
const port = Number(process.env.PORT);
if (!host) throw new Error("HOST is required");
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be an integer");

const IS_PROD = process.env.NODE_ENV === "production";
// 仅当本页已发布平台 SSO 策略并由属主显式设置该开关时，才允许信任 mule_page_sso Cookie。
const SSO_TRUST = process.env.SSO_PROTECTED === "1";

// ---------- Section: static serving (template contract) ----------
const clientRoot = fileURLToPath(new URL("./dist/", import.meta.url));
const clientRootPrefix = clientRoot.endsWith(sep) ? clientRoot : `${clientRoot}${sep}`;
const indexPath = resolve(clientRoot, "index.html");

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function sendRaw(response, status, body, contentType) {
  response.writeHead(status, { "content-type": contentType, "x-content-type-options": "nosniff" });
  response.end(body);
}

function isInsideClientRoot(path) {
  return path === clientRoot || path.startsWith(clientRootPrefix);
}

async function existingFile(path) {
  try {
    const details = await stat(path);
    return details.isFile() ? path : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

async function resolveClientFile(pathname) {
  let decodedPath;
  try { decodedPath = decodeURIComponent(pathname); } catch { return null; }
  const relativePath = decodedPath.replace(/^\/+/, "") || "index.html";
  const candidate = resolve(clientRoot, relativePath);
  if (!isInsideClientRoot(candidate)) return null;
  const file = await existingFile(candidate);
  if (file) return file;
  return extname(decodedPath) ? null : existingFile(indexPath);
}

// ---------- Section: helpers ----------
function sha256hex(input) { return createHash("sha256").update(input).digest("hex"); }
function newId(prefix) { return `${prefix}-${randomBytes(8).toString("hex")}`; }
function nowIso() { return new Date().toISOString(); }

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function sendJson(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

const bodyCache = new WeakMap();
async function peekBody(request) { if (bodyCache.has(request)) return bodyCache.get(request); const b = await readBodyRaw(request); bodyCache.set(request, b); return b; }
async function readBody(request, limitBytes = 64 * 1024) { return peekBody(request); }
function readBodyRaw(request, limitBytes = 64 * 1024) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunku) => {
      size += chunku.length;
      if (size > limitBytes) { rejectPromise(new HttpError(413, "payload_too_large")); request.destroy(); return; }
      chunks.push(chunku);
    });
    request.on("end", () => {
      if (chunks.length === 0) return resolvePromise({});
      try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { rejectPromise(new HttpError(400, "bad_json")); }
    });
    request.on("error", rejectPromise);
  });
}

// ---------- Section: database access (Supabase-compatible REST; lazy; dual-mode) ----------
const BROKER_URL = "http://127.0.0.1:9001";
const BROKER_PLACEHOLDER_KEY = "qwenwork-runtime-broker";
const SAFE_DATABASE_OPERATIONS = new Set([
  "list_users", "get_user_by_name", "get_user_by_id", "touch_login",
  "create_session", "get_session", "delete_session",
  "get_binding_by_platform_user", "insert_audit", "list_audit",
  "list_resource", "count_resource", "insert_resource",
  "get_user_by_id", "user_edit", "drv_exists", "bind_active_check", "bind_rows", "bind_insert", "bind_close", "bind_patch_row", "bind_delete_row", "bind_conflict_q", "search_read", "erd_list",
  "course_list", "audits_q", "audits_get", "course_insert", "course_patch", "ops_insert", "ops_list", "ts_course", "ts_facts", "pp_rows", "tpl_probe", "tpl_list", "tpl_insert", "tpl_patch", "erd_get", "erd_insert", "erd_patch", "er_current", "kn_list", "kn_get", "kn_insert", "kn_patch",
  "insert_import_run", "get_import_run", "update_import_run", "upsert_resource",
  "get_task_row", "patch_task_row", "insert_task_notify", "count_task_notifs",
  "get_rr_row", "patch_rr_row", "insert_rr_row", "get_own_score_row", "get_own_ledger_row",
  "ai_audit_insert", "ai_audit_get",
  "patch_alert_fields", "count_alerts", "count_notes", "count_tasks", "count_my_notes",
  "get_course_row", "patch_course_status", "get_config_row", "patch_config_row", "count_ops_rows", "get_binding_target",
  // R37 新增四功能的数据库操作标签（司机资料/根因聚合/规则生效链/等级映射）
  "dp_get", "dp_patch", "dp_insert", "rc_led", "rc_er", "er_dims", "er_current2", "er_patch_effect", "erd_get2", "erd_get3", "ma_lvl",
  // R40 每日简报（宿主 PostgreSQL 版）
  "dsr_q", "dsr_i", "dsr_u", "drj_q", "drj_i", "drj_u", "dsg_q", "dsg_i", "dsg_u", "dau_q", "dne_q", "get_binding_target", "insert_task_row",
  "get_alert_row", "patch_alert_status", "insert_alert_row", "get_alert_evidence", "count_risk_rows", "create_intervention", "patch_intervention", "get_intervention_row", "insert_notification", "get_notification_by_key", "read_own_intervention", "reply_own_intervention", "send_intervention",
  "list_import_by_key", "get_binding_user", "count_driver_conflict", "insert_binding_row", "close_binding_rows", "patch_binding_fields", "get_driver_profile",
]);

function resolveDbTarget() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  const instanceId = process.env.SUPABASE_INSTANCE_ID;
  const set = [url, key, instanceId].filter(Boolean).length;
  if (set === 3) return { url: url.replace(/\/+$/, ""), key, headers: { "X-Instance-ID": instanceId } };
  if (set === 0) return { url: BROKER_URL, key: BROKER_PLACEHOLDER_KEY, headers: {} };
  throw new HttpError(503, "database_unavailable");
}

async function dbRequest(op, method, path, { query, body, headers } = {}) {
  if (!SAFE_DATABASE_OPERATIONS.has(op) && op !== "task_learning_get") throw new HttpError(500, "internal_error");
  let target;
  try { target = resolveDbTarget(); } catch (error) {
    return handleDbError(op, error, null);
  }
  const qs = query && Object.keys(query).length
    ? `?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`
    : "";
  let response;
  try {
    response = await fetch(`${target.url}/rest/v1/${path.replace(/^\/+/, "")}${qs}`, {
      method,
      headers: {
        apikey: target.key,
        Authorization: `Bearer ${target.key}`,
        "content-type": "application/json",
        ...target.headers,
        ...(headers || {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    return handleDbError(op, error, null);
  }
  if (!response.ok) {
    let code = "";
    try { const j = await response.json(); code = String(j?.code || j?.error || j?.message || "").slice(0, 32); } catch { /* ignore body */ }
    if (op === "task_learning_get" && ["42703", "PGRST204"].includes(code)) throw new HttpError(503, "learning_migration_required");
    if (response.status === 409 || code === "23505" || code === "23P01") throw new HttpError(409, "db_conflict");
    console.error("DB_DETAIL", op, response.status, code, (response.headers.get("content-type") || ""));
    try { const tb = await response.clone().text(); tb && console.error("DB_BODY", tb.slice(0, 260)); } catch {}
    return handleDbError(op, new Error("db_status"), { status: response.status, code });
  }
  if (method === "HEAD") return null;
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  return { data, rangeHeader: response.headers.get("content-range") };
}

function handleDbError(op, error, extra) {
  // 只输出白名单诊断，绝不输出 URL、key 或原始上游信息
  const status = extra?.status;
  const label = `category=db_error operation=${/^[a-z_]{1,40}$/.test(op) ? op : "unknown"}${status ? ` status=${status}` : ""}${extra?.code ? ` code=${extra.code.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 24)}` : ""}`;
  console.error(`db failure ${label}`);
  throw new HttpError(status === 404 ? 404 : 503, "database_unavailable");
}

function parseCount(rangeHeader) {
  if (!rangeHeader) return null;
  const total = rangeHeader.split("/")[1];
  return total && total !== "*" ? Number(total) : null;
}

// ---------- Section: identity (platform SSO cookie + local app sessions) ----------
const SSO_COOKIE = "mule_page_sso";
const SESSION_COOKIE = "claw_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function parseCookies(request) {
  const out = {};
  for (const part of String(request.headers.cookie || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function singleHost(value) {
  if (Array.isArray(value)) return "";
  const h = String(value || "").toLowerCase();
  if (!h || h !== h.trim() || h.includes(",")) return "";
  return h;
}

function isDnsHost(h) {
  if (!h || h.length > 253) return false;
  const labels = h.split(".");
  return labels.length >= 2 && labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

function pageRequestHost(request) {
  const h = singleHost(request.headers.host);
  if (!h.endsWith(".fcapp.run")) return h;
  const fwd = singleHost(request.headers["x-forwarded-host"]);
  return isDnsHost(fwd) ? fwd : h;
}

function ssoUser(request) {
  if (!SSO_TRUST) return null; // 页面未发布 SSO 策略时 Cookie 可伪造，绝不信任
  const token = parseCookies(request)[SSO_COOKIE] || "";
  if (!token) return null;
  const payload = token.split(".")[1];
  if (!payload) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  if (typeof claims?.userId !== "string" || !claims.userId) return null;
  if (!Number.isInteger(claims.exp) || claims.exp * 1000 <= Date.now()) return null;
  if (claims.domain && (typeof claims.domain !== "string" || claims.domain.toLowerCase() !== pageRequestHost(request))) return null;
  return {
    id: claims.userId,
    name: typeof claims.userName === "string" ? claims.userName : "",
    provider: typeof claims.provider === "string" ? claims.provider : "",
  };
}

async function verifyPassword(password, stored) {
  // 存储格式 scrypt$N$r$p$saltHex$keyHex
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltHex, keyHex] = parts;
  const N = Number(nStr), r = Number(rStr), p = Number(pStr);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const expect = Buffer.from(keyHex, "hex");
  let got;
  try { got = await scrypt(password, Buffer.from(saltHex, "hex"), expect.length, { N, r, p, maxmem: 256 * 1024 * 1024 }); }
  catch { return false; }
  return got.length === expect.length && timingSafeEqual(got, expect);
}

const loginAttempts = new Map(); // username -> {count, resetAt}
function rateCheck(key) {
  const nowTs = Date.now();
  const rec = loginAttempts.get(key);
  if (!rec || rec.resetAt <= nowTs) return true;
  return rec.count < 10;
}
function rateHit(key) {
  const nowTs = Date.now();
  const rec = loginAttempts.get(key);
  if (!rec || rec.resetAt <= nowTs) loginAttempts.set(key, { count: 1, resetAt: nowTs + 5 * 60 * 1000 });
  else rec.count += 1;
}

const USER_PUBLIC_COLS = "user_id,username,display_name,role,fleet_scope,default_fleet_id,driver_id,binding_verified,binding_note,account_status,last_login_at";

async function loadLocalSessionUser(request) {
  const token = parseCookies(request)[SESSION_COOKIE] || "";
  if (!token || token.length < 32) return null;
  const { data } = await dbRequest("get_session", "GET", "app_sessions", {
    query: { session_id: `eq.${sha256hex(token)}`, select: "user_id,expires_at" },
  });
  const row = Array.isArray(data) ? data[0] : null;
  if (!row || Date.parse(row.expires_at) <= Date.now()) {
    if (row) await dbRequest("delete_session", "DELETE", "app_sessions", { query: { session_id: `eq.${sha256hex(token)}` } }).catch(() => {});
    return null;
  }
  const { data: users } = await dbRequest("get_user_by_id", "GET", "app_users", {
    query: { user_id: `eq.${row.user_id}`, select: USER_PUBLIC_COLS },
  });
  const u = Array.isArray(users) ? users[0] : null;
  if (!u || u.account_status !== "active") return null;
  return u;
}

async function authenticate(request) {
  const local = await loadLocalSessionUser(request);
  if (local) return { kind: "local", user: local, sso: null };
  const sso = ssoUser(request);
  if (sso) {
    const { data } = await dbRequest("get_binding_by_platform_user", "GET", "user_bindings", {
      query: { platform_user_id: `eq.${sso.id}`, account_status: `eq.active`, select: "binding_id,user_id,role,driver_id,fleet_id,identity_status" },
    });
    const b = Array.isArray(data) ? data[0] : null;
    if (b) {
      const user = b.user_id
        ? (await dbRequest("get_user_by_id", "GET", "app_users", { query: { user_id: `eq.${b.user_id}`, select: USER_PUBLIC_COLS } }))?.data?.[0]
        : null;
      if (user && user.account_status === "active") {
        return { kind: "sso", user: { ...user, driver_id: b.driver_id ?? user.driver_id, binding_verified: b.identity_status === "已核实" }, sso };
      }
      if (b.role === "safety_admin" && !user) {
        return { kind: "sso", user: { user_id: `sso:${sso.id}`, display_name: sso.name || "平台账号", role: "safety_admin", fleet_scope: "*", driver_id: null, binding_verified: false, account_status: "active" }, sso };
    }
    return { kind: "sso_unbound", user: null, sso };
    }
    return { kind: "sso_unbound", user: null, sso };
  }
  return null;
}

// ---------- Section: capability matrix + resource whitelist ----------
// 算法事实表：任何运行期接口均只读；仅允许"管理员+版本化导入"路径写入（导入流程后续轮次实现）。
const FACT_TABLES = new Set([
  "drivers", "risk_snapshots", "score_snapshots", "score_history", "deduction_ledger",
  "review_queue", "replay_events", "evaluation_rules", "training_courses", "operation_config",
]);

const ROLE_CAPABILITIES = {
  safety_admin: new Set([
    "view.fleet_overview", "view.driver_detail", "view.replay", "view.alerts",
    "handle.alert", "send.intervention", "assign.training", "review.training_feedback", "manage.rule_drafts", "manage.knowledge", "global.search",
    "review.score_challenge", "import.data", "manage.accounts", "manage.bindings",
    "manage.operation_config", "review.content", "view.audit", "ai.explain_own_scope",
  ]),
  team_leader: new Set(["view.fleet_overview", "view.driver_detail", "view.alerts", "handle.alert", "ai.explain_own_scope"]),
  driver: new Set([
    "view.my_score", "ack.my_alert", "reply.my_intervention", "view.my_training",
    "submit.my_training_feedback", "submit.score_challenge", "manage.my_profile", "ai.explain_own_scope", "global.search",
  ]),
};

// 资源白名单：name → 表、可SELECT列、角色允许范围、排序。服务端每次查询强制行级过滤。
const RESOURCE_DEFS = {
  "admin.drivers": { table: "drivers", order: "driver_id.asc",
    cols: "driver_id,gpsno,display_name,fleet_id,identity_status,mapping_start,mapping_end,source_version",
    roles: ["safety_admin", "team_leader"], cap: "view.driver_detail", filters: ["driver_id", "gpsno", "fleet_id", "identity_status"] },
  "admin.score_snapshots": { table: "score_snapshots", order: "safety_score.asc",
    cols: "score_id,gpsno,driver_id,safety_score,rank,risk_level,score_change_7d,confidence_score,confidence_level,score_status,as_of_date,window_start,top_reason_1,top_reason_2,top_reason_3,primary_risk_dimension,recommended_action,review_cycle,behavior_safety_score,confidence_adjusted_floor,forecast_40d_risk_prob,review_queue,immediate_alert,source_version,history_contribution,fatigue_distraction_contribution,driving_stability_contribution,road_rule_contribution,management_contribution,imu_evidence_contribution",
    roles: ["safety_admin", "team_leader"], cap: "view.driver_detail",
    filters: ["confidence_level", "risk_level", "as_of_date", "driver_id", "gpsno", "score_status", "primary_risk_dimension"] },
  "admin.risk_snapshots": { table: "risk_snapshots", order: "risk_rank.asc",
    cols: "snapshot_id,gpsno,risk_prob,risk_rank,as_of_date,horizon_days,source_version",
    roles: ["safety_admin", "team_leader"], cap: "view.fleet_overview", filters: ["gpsno", "as_of_date"] },
  "admin.review_queue": { table: "review_queue", order: "safety_score.asc",
    cols: "queue_id,gpsno,safety_score,risk_level,forecast_40d_risk_prob,review_queue,action_deadline,confidence_level,top_reason_1,as_of_date,source_version",
    roles: ["safety_admin", "team_leader"], cap: "view.fleet_overview", filters: ["gpsno", "confidence_level", "risk_level", "review_queue", "as_of_date"] },
  "admin.replay_events": { table: "replay_events", order: "event_time.asc",
    cols: "event_id,gpsno,driver_id,event_time,event_type,event_name,speed_kmh,dimension,replay_date,is_replay,source_version",
    roles: ["safety_admin", "team_leader"], cap: "view.replay", filters: ["gpsno", "replay_date"] },
  "admin.deduction_ledger": { table: "deduction_ledger", order: "ledger_id.asc",
    cols: "ledger_id,gpsno,event_type,dimension,event_count,decayed_severity,allocated_points,dimension_points,allocation_rule,as_of_date,source_version",
    roles: ["safety_admin", "team_leader"], cap: "view.driver_detail", filters: ["gpsno", "dimension"] },
  "admin.score_history": { table: "score_history", order: "as_of_date.asc",
    cols: "score_id,gpsno,driver_id,as_of_date,safety_score,rank,risk_level,confidence_score,confidence_level,score_status,history_contribution,fatigue_distraction_contribution,driving_stability_contribution,road_rule_contribution,management_contribution,imu_evidence_contribution,source_version",
    roles: ["safety_admin", "team_leader"], cap: "view.driver_detail", filters: ["gpsno", "driver_id", "as_of_date"] },
  "admin.trainings": { table: "training_tasks", order: "updated_at.desc",
    cols: "task_id,driver_id,alert_id,course_id,goal,mandatory,due_at,status,submitted_at,reviewed_at,created_by,updated_at",
    roles: ["safety_admin", "team_leader"], cap: "assign.training", filters: ["alert_id", "status", "driver_id", "task_id"] },
  "admin.notifications": { table: "notification_events", order: "created_at.desc",
    cols: "notification_id,target_user_id,source_entity_type,source_entity_id,type,title,content,read_at,created_at",
    roles: ["safety_admin"], cap: "send.intervention", filters: ["source_entity_id", "target_user_id", "type"] },
  "admin.interventions": { table: "interventions", order: "updated_at.desc",
    cols: "intervention_id,alert_id,driver_id,status,draft_text,sent_text,sent_at,read_at,reply_text,replied_at,created_by,updated_at",
    roles: ["safety_admin"], cap: "send.intervention", filters: ["alert_id", "driver_id", "status"] },
  "admin.alerts": { table: "alerts", order: "occurred_at.desc",
    cols: "alert_id,gpsno,driver_id,rule_code,evidence_id,occurred_at,status,is_replay,owner_user_id,due_at,close_reason,updated_at",
    roles: ["safety_admin", "team_leader"], cap: "view.alerts", filters: ["status", "gpsno", "rule_code"] },
  "admin.review_requests": { table: "review_requests", order: "created_at.desc",
    cols: "request_id,driver_id,target_type,score_id,evidence_id,reason_code,description,status,reviewer_id,created_at,handled_at",
    roles: ["safety_admin"], cap: "review.score_challenge" },
  "admin.training_courses": { table: "training_courses", order: "course_id.asc",
    cols: "course_id,title,dimension,content,completion_requirement,content_status,version_no,source_version,updated_at",
    roles: ["safety_admin", "team_leader", "driver"], cap: null },
  "admin.evaluation_rules": { table: "evaluation_rules", order: "dimension.asc",
    cols: "dimension,dimension_name,weight,window_days,score_method,editable,source_version",
    roles: ["safety_admin", "team_leader"], cap: null },
  "admin.operation_config": { table: "operation_config", order: "config_id.asc",
    cols: "config_id,value,unit,config_version,updated_by,updated_at,effective_at",
    roles: ["safety_admin"], cap: "manage.operation_config" },
  "admin.accounts": { table: "app_users", order: "user_id.asc",
    cols: USER_PUBLIC_COLS, roles: ["safety_admin"], cap: "manage.accounts" },
  "admin.bindings": { table: "user_bindings", order: "binding_id.asc",
    cols: "binding_id,platform_user_id,user_id,role,driver_id,fleet_id,account_status,identity_status,effective_start,effective_end,note,updated_at",
    roles: ["safety_admin"], cap: "manage.bindings" },
  "admin.import_runs": { table: "import_runs", order: "created_at.desc",
    cols: "run_id,filename,target_table,source_version,check_status,row_total,accepted_count,rejected_count,dup_pk_count,type_error_count,unknown_columns,actor_id,created_at,committed_at,created_audit_id,commit_audit_id",
    roles: ["safety_admin"], cap: "import.data" },
  "admin.audit": { table: "audit_logs", order: "occurred_at.desc",
    cols: "audit_id,actor_id,actor_role,action,entity_type,entity_id,old_status,new_status,request_id,occurred_at",
    roles: ["safety_admin"], cap: "view.audit", filters: ["entity_id", "entity_type", "actor_id"] },
  "admin.knowledge": { table: "knowledge_articles", order: "article_id.asc",
    cols: "article_id,version_no,title,dimension,review_status,reviewed_by,reviewed_at,created_by,updated_at",
    roles: ["safety_admin"], cap: "review.content" },
  "my.alerts": { table: "alerts", order: "occurred_at.desc",
    cols: "alert_id,gpsno,rule_code,evidence_id,occurred_at,status,is_replay",
    roles: ["driver"], cap: "ack.my_alert", injectDriver: "driver_id" },
  "my.interventions": { table: "interventions", order: "updated_at.desc",
    cols: "intervention_id,alert_id,status,sent_text,sent_at,read_at,reply_text,replied_at",
    roles: ["driver"], cap: "reply.my_intervention", injectDriver: "driver_id" },
  "my.trainings": { table: "training_tasks", order: "due_at.asc",
    cols: "task_id,course_id,alert_id,goal,mandatory,due_at,status,started_at,submitted_at,learning_record,feedback,review_note,reviewed_at",
    roles: ["driver"], cap: "view.my_training", injectDriver: "driver_id" },
  "my.score": { table: "score_snapshots", order: "as_of_date.desc",
    cols: "score_id,safety_score,rank,risk_level,score_change_7d,confidence_level,as_of_date,window_start,top_reason_1,top_reason_2,top_reason_3,primary_risk_dimension,recommended_action,behavior_safety_score,confidence_adjusted_floor,forecast_40d_risk_prob,source_version,history_contribution,fatigue_distraction_contribution,driving_stability_contribution,road_rule_contribution,management_contribution,imu_evidence_contribution",
    roles: ["driver"], cap: "view.my_score", injectDriver: "driver_id" },
  "my.score_history": { table: "score_history", order: "as_of_date.desc,score_id.desc",
    cols: "score_id,as_of_date,safety_score,risk_level,confidence_level,history_contribution,fatigue_distraction_contribution,driving_stability_contribution,road_rule_contribution,management_contribution,imu_evidence_contribution,source_version",
    roles: ["driver"], cap: "view.my_score", injectDriver: "driver_id" },
  "my.review_requests": { table: "review_requests", order: "created_at.desc",
    cols: "request_id,score_id,evidence_id,reason_code,description,status,review_note,reviewer_id,created_at,updated_at",
    roles: ["driver"], cap: "submit.score_challenge", injectDriver: "driver_id" },
  "my.notifications": { table: "notification_events", order: "created_at.desc",
    cols: "notification_id,source_entity_id,type,title,body,read_at,created_at",
    roles: ["driver"], cap: null, injectUser: "target_user_id" },
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const FLEET_GPS_TABLES = new Set(["drivers", "review_queue", "risk_snapshots", "score_snapshots", "score_history", "deduction_ledger", "replay_events", "alerts"]);
const FLEET_DRV_TABLES = new Set(["training_tasks", "review_requests", "interventions"]);
let fleetScopeCache = { scope: null, gps: null, drv: null, at: 0 };
async function fleetScopeSets(scope) {
  if (fleetScopeCache.scope === scope && Date.now() - fleetScopeCache.at < 60000) return fleetScopeCache;
  const rows = await listRows("ops_list", "drivers", { select: "driver_id,gpsno", fleet_id: `eq.${scope}`, limit: 2000 });
  fleetScopeCache = { scope, gps: rows.map((x) => x.gpsno), drv: rows.map((x) => x.driver_id), at: Date.now() };
  return fleetScopeCache;
}
async function assertInScope(principal, keys) {
  const u = principal?.user || {}; const scope = String(u.fleet_scope || "*");
  if (!["safety_admin", "team_leader"].includes(u.role) || scope === "*") return;
  const s = await fleetScopeSets(scope);
  if (keys.alertId) { const al = await listRows("get_alert_row", "alerts", { alert_id: `eq.${keys.alertId}`, select: "gpsno,driver_id", limit: 1 }); const a = al[0]; if (!a || (!s.gps.includes(String(a.gpsno)) && !s.drv.includes(String(a.driver_id || "")))) { try { await appendAudit(principal, "scope_refused.write", "fleet_object", String(keys.alertId), null, "refused_scope_404", principal.requestId); } catch {} throw new HttpError(404, "not_found"); } return; }
  if (keys.taskId) { const tk = await listRows("get_task_row", "training_tasks", { task_id: `eq.${keys.taskId}`, select: "driver_id", limit: 1 }); const x = tk[0]; if (!x || !s.drv.includes(String(x.driver_id))) { try { await appendAudit(principal, "scope_refused.write", "fleet_object", String(keys.taskId), null, "refused_scope_404", principal.requestId); } catch {} throw new HttpError(404, "not_found"); } return; }
  if (keys.gpsno && !s.gps.includes(String(keys.gpsno))) { try { await appendAudit(principal, "scope_refused.write", "fleet_object", String(keys.alertId || keys.gpsno), null, "refused_scope", principal.requestId); } catch {} throw new HttpError(404, "not_found_or_stale"); }
  if (keys.driverId && !s.drv.includes(String(keys.driverId))) { try { await appendAudit(principal, "scope_refused.write", "fleet_object", String(keys.taskId || keys.driverId), null, "refused_scope", principal.requestId); } catch {} throw new HttpError(404, "not_found_or_stale"); }
}
async function applyFleetScope(user, def, query) {
  const scope = String(user.fleet_scope || "*");
  if (!["safety_admin", "team_leader"].includes(user.role) || scope === "*") return null;
  return { __noFleetDimension: def.table }; // 课程/知识/审计/配置等非车队维度资源：不受队列表约束但也不泄露行数据
}
async function listResource(principal, resName, url) {
  const def = RESOURCE_DEFS[resName];
  if (!def) throw new HttpError(404, "not_found");
  const user = requireUser(principal);
  if (!def.roles.includes(user.role)) throw new HttpError(403, "forbidden");
  if (def.cap && !ROLE_CAPABILITIES[user.role]?.has(def.cap)) throw new HttpError(403, "forbidden");
  const query = { select: def.cols, order: def.order };
  // 行级权限：司机仅本人；注入优先于任何客户端过滤参数
  if (def.injectDriver) {
    requireVerifiedDriver(principal);
    query.driver_id = `eq.${user.driver_id}`;
  }
  if (def.injectUser) query[def.injectUser] = `eq.${user.user_id}`;
  if (def.injectUser && user.role === "driver") requireVerifiedDriver(principal);
  const limit = Math.min(Number(url.searchParams.get("limit")) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
  query.limit = limit;
  query.offset = offset;
  if (url.searchParams.get("status")) query.status = `eq.${url.searchParams.get("status")}`;
  for (const [k, v] of url.searchParams) {
    if (!def.filters || k === "status" || !def.filters.includes(k)) continue; // 列名仅接受服务端白名单；值一律字符串 eq/in 绑定
    const val = String(v).slice(0, 64);
    if (!/^[\w.,:;\-\u4e00-\u9fff ]+$/.test(val)) continue;
    query[k] = val.includes(",") ? `in.(${val.split(",").map((x) => x.trim()).join(",")})` : `eq.${val}`;
  }
  if (url.searchParams.get("fleet_id") && user.role === "safety_admin" && !def.injectDriver) {
    if (String(user.fleet_scope || "*") !== "*" && String(url.searchParams.get("fleet_id")) !== String(user.fleet_scope)) throw new HttpError(403, "out_of_fleet_scope"); // 受限管理员不得借参数扩权
    query.fleet_id = `eq.${url.searchParams.get("fleet_id")}`;
  }
  if (def.table === "training_courses" && user.role === "driver") query.content_status = `eq.${COURSE_APPROVED}`; // 司机仅可见已审核课程
  if (def.table === "app_users" && user.role === "safety_admin" && String(user.fleet_scope || "*") !== "*") {
    const scope = String(user.fleet_scope);
    const s = await fleetScopeSets(scope);
    const allAcc = await dbRequest("list_resource", "GET", "app_users", { query: { select: "user_id,driver_id,fleet_scope", limit: 500 } });
    const keep = (allAcc.data || []).filter((x) => x.user_id === user.user_id || (x.driver_id && s.drv.includes(String(x.driver_id))) || String(x.fleet_scope || "") === scope).map((x) => x.user_id);
    if (!keep.includes(user.user_id)) keep.push(user.user_id);
    query.user_id = keep.length ? `in.(${keep.join(",")})` : `eq.${user.user_id}`; // 可信会话内内存过滤，绝不下发超长 in-list
  }
  const scopeNote = await applyFleetScope(user, def, query);
  if (url.searchParams.get("fleet_id") && scopeNote && scopeNote.__selfScoped) {
    // 受限管理员显式传他队 fleet_id：拒绝扩权
    if (String(url.searchParams.get("fleet_id")) !== String(user.fleet_scope)) throw new HttpError(403, "out_of_fleet_scope");
  }
  const result = await dbRequest("list_resource", "GET", def.table, {
    query, headers: { Prefer: "count=exact" },
  });
  return { table: def.table, rows: result.data ?? [], total: parseCount(result.rangeHeader), limit, offset };
}

function requireUser(principal, capability = null) {
  const u = principal?.user;
  if (!u) throw new HttpError(401, "unauthenticated");
  if (u.account_status && u.account_status !== "active") throw new HttpError(403, "account_disabled");
  if (capability && !ROLE_CAPABILITIES[u.role]?.has(capability)) throw new HttpError(403, "forbidden");
  return u;
}

async function appendAudit(actor, action, entityType, entityId, oldStatus, newStatus, requestId, evidenceRefs, detail) {
  const auditId = newId("aud");
  const row = {
    audit_id: auditId, actor_id: actor?.user?.user_id || "anonymous", actor_role: actor?.user?.role || "-",
    action, entity_type: entityType, entity_id: entityId || "", old_status: oldStatus || null, new_status: newStatus || null,
    occurred_at: nowIso(), request_id: requestId || null,
  };
  if (evidenceRefs) row.evidence_refs = JSON.stringify(evidenceRefs);
  if (detail) row.detail_json = JSON.stringify(detail);
  try {
    await dbRequest("insert_audit", "POST", "audit_logs", { body: [row], headers: { Prefer: "return=minimal" } });
    return auditId;
  } catch (error) {
    console.error(`audit insert failed action=${action}`); // 审计失败不改变业务响应，但记录错误
    return null;
  }
}

// ---------- Section: API handlers ----------
const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;

async function handleLogin(request, response, url, ctx) {
  const body = await readBody(request);
  const username = String(body.username || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!USERNAME_RE.test(username) || !password || password.length > 128) throw new HttpError(400, "bad_request");
  if (!rateCheck(username)) throw new HttpError(429, "too_many_attempts");
  const { data } = await dbRequest("get_user_by_name", "GET", "app_users", {
    query: { username: `eq.${username}`, select: "user_id,password_hash,account_status" },
    headers: { "Range-Unit": "items", Range: "0-0" },
  });
  const row = Array.isArray(data) ? data[0] : null;
  const ok = row && (await verifyPassword(password, row.password_hash));
  await appendAudit({ user: { user_id: row?.user_id || "unknown", role: "anonymous" } }, "auth.login", "app_user", row?.user_id || null, null, ok && row.account_status === "active" ? "ok" : (row ? (ok ? "disabled" : "bad_password") : "no_user"), ctx.requestId);
  if (!row || !ok) { rateHit(username); throw new HttpError(401, "invalid_credentials"); }
  if (row.account_status !== "active") throw new HttpError(403, "account_disabled");
  loginAttempts.delete(username);
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await dbRequest("create_session", "POST", "app_sessions", {
    body: [{ session_id: sha256hex(token), user_id: row.user_id, created_at: nowIso(), expires_at: expiresAt }],
    headers: { Prefer: "return=minimal" },
  });
  await dbRequest("touch_login", "PATCH", "app_users", {
    query: { user_id: `eq.${row.user_id}` }, body: { last_login_at: nowIso() },
    headers: { Prefer: "return=minimal" },
  });
  const secure = IS_PROD ? "; Secure" : "";
  sendJson(response, 200, { ok: true }, {
    "set-cookie": `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`,
  });
}

async function handleLogout(request, response, url, ctx) {
  const token = parseCookies(request)[SESSION_COOKIE] || "";
  if (token) {
    await dbRequest("delete_session", "DELETE", "app_sessions", { query: { session_id: `eq.${sha256hex(token)}` } }).catch(() => {});
    await appendAudit(ctx.principal, "auth.logout", "app_user", ctx.principal?.user?.user_id || null, null, "ok", ctx.requestId);
  }
  sendJson(response, 200, { ok: true }, { "set-cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${IS_PROD ? "; Secure" : ""}` });
}

function publicUser(u, authKind) {
  return {
    userId: u.user_id, username: u.username || null, displayName: u.display_name || "", role: u.role,
    localSourceOnly: process.env.IE_LOCAL_SOURCE_ONLY === "1",
    fleetScope: u.fleet_scope || null, driverId: u.driver_id || null, binding_verified: Boolean(u.binding_verified), bindingVerified: Boolean(u.binding_verified),
    bindingNote: u.binding_note || null, accountStatus: u.account_status || "active",
    authKind,
    capabilities: [...(ROLE_CAPABILITIES[u.role] || [])],
    allowedResources: Object.entries(RESOURCE_DEFS).filter(([, d]) => d.roles.includes(u.role)).map(([k]) => k),
    ssoEnabled: SSO_TRUST, dataManifest: process.env.IE_DATA_MANIFEST || "数据以实际查询结果为准；演示身份不代表真实司机核验",
  };
}

async function handleMe(request, response, url, ctx) {
  const p = ctx.principal;
  if (p?.user) return sendJson(response, 200, { user: publicUser(p.user, p.kind), sso: p.sso ? { provider: p.sso.provider, name: p.sso.name } : null });
  if (p?.kind === "sso_unbound") return sendJson(response, 200, { user: null, unbound: { provider: p.sso.provider, name: p.sso.name }, sso: true });
  return sendJson(response, 401, { error: "unauthenticated" });
}

const OVERVIEW_METRICS = [
  { key: "drivers", label: "司机映射", table: "drivers", query: { select: "driver_id" } },
  { key: "score_latest", label: "近14天评分快照", table: "score_snapshots", query: { select: "score_id" } },
  { key: "alerts_total", label: "告警", table: "alerts", query: { select: "alert_id" } },
  { key: "alerts_pending", label: "待人工复核", table: "alerts", query: { select: "alert_id", status: "eq.pending_review" } },
  { key: "interventions_sent", label: "已发送干预", table: "interventions", query: { select: "intervention_id", status: "eq.sent" } },
  { key: "interventions_unreplied", label: "干预未回复", table: "interventions", query: { select: "intervention_id", status: "eq.sent", read_at: "is.null" } },
  { key: "trainings_open", label: "进行中培训", table: "training_tasks", query: { select: "task_id", status: "eq.assigned" } },
  { key: "review_requests_open", label: "待处理复核申请", table: "review_requests", query: { select: "request_id", status: `eq.submitted` } },
  { key: "low_confidence", label: "低可信度对象", table: "score_snapshots", query: { select: "score_id", confidence_level: "eq.low" } },
];

async function handleHistoryDates(request, response, url, ctx) {
  const user = requireUser(ctx.principal);
  if (!(ROLE_CAPABILITIES[user.role] || new Set()).has("view.fleet_overview")) throw new HttpError(403, "forbidden");
  const grab = async (dir) => {
    const r = await dbRequest("list_resource", "GET", "score_history", { query: { select: "as_of_date", order: `as_of_date.${dir}`, limit: 1 } });
    return r.data?.[0]?.as_of_date || null;
  };
  let dates = null;
  // 首选 PostgREST distinct（老版本可能不支持则回退枚举）
  try {
    const r = await dbRequest("list_resource", "GET", "score_history", {
      query: { select: "as_of_date", order: "as_of_date.asc", distinct: "1", on: "as_of_date", limit: 400 },
    });
    const seen = [...new Set((r.data || []).map((x) => x.as_of_date))].filter(Boolean);
    if (seen.length) dates = seen.sort();
  } catch { /* fallthrough */ }
  if (!dates) {
    const a = await grab("asc"); const b = await grab("desc");
    if (a && b) {
      dates = [];
      const d0 = new Date(a + "T00:00:00Z"), d1 = new Date(b + "T00:00:00Z");
      for (let ms = d0.getTime(); ms <= d1.getTime() && dates.length < 400; ms += 86400000) {
        const ds = new Date(ms).toISOString().slice(0, 10);
        const chk = await dbRequest("list_resource", "GET", "score_history", { query: { select: "as_of_date", as_of_date: `eq.${ds}`, limit: 1 } });
        if (chk.data?.length) dates.push(ds);
      }
    }
  }
  const counts = {};
  for (const ds of (dates || []).slice(0, 60)) {
    const r = await dbRequest("count_resource", "GET", "score_history", { query: { select: "score_id", as_of_date: `eq.${ds}`, limit: 1 }, headers: { Prefer: "count=exact" } });
    counts[ds] = parseCount(r.rangeHeader);
  }
  sendJson(response, 200, { dates: dates || [], counts });
}

// ===== R21：EV04 匿名车队聚合（只读、可信会话、防反推） =====
// ===== R22：RM01「7 天下滑」分组（只读比较，不产告警/扣分/任务；可信会话 scope） =====
function addDaysIso(iso, n) { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
async function handleDrop7(request, response, url, ctx) {
  const user = requireUser(ctx.principal);
  if (!["safety_admin", "team_leader"].includes(user.role)) throw new HttpError(403, "forbidden");
  try {
    const oc = await dbRequest("get_config_row", "GET", "operation_config", { query: { config_id: "eq.drop_threshold", select: "value,config_version", limit: 1 } });
    const thr = Number(oc.data?.[0]?.value); const tver = String(oc.data?.[0]?.config_version || "—");
    if (!Number.isFinite(thr)) throw new HttpError(500, "threshold_config_missing");
    let pair = null;
    { // 从最新真实采样日向前探测"相隔恰好 7 自然日的双真实日"（存在性用 count 检查，绝不补造日期）
      const maxR = await dbRequest("list_resource", "GET", "score_history", { query: { select: "as_of_date", order: "as_of_date.desc", limit: 1 } });
      let later = maxR.data?.[0]?.as_of_date || null;
      const dcache = new Set();
      const hasDay = async (d) => { if (dcache.has(d)) return true; const hr = await dbRequest("list_resource", "GET", "score_history", { query: { select: "as_of_date", as_of_date: `eq.${d}`, limit: 1 } }); if (hr.data?.length) { dcache.add(d); return true; } return false; };
      for (let step = 0; step < 40 && later; step++) {
        if (await hasDay(later)) { const earlier = addDaysIso(later, -7); if (await hasDay(earlier)) { pair = [earlier, later]; break; } }
        else break;
        const prev = await dbRequest("list_resource", "GET", "score_history", { query: { select: "as_of_date", as_of_date: `lt.${later}`, order: "as_of_date.desc", limit: 1 } });
        later = prev.data?.[0]?.as_of_date || null;
      }
    }
    if (!pair) return sendJson(response, 200, { data_status: "no_data", threshold: thr, threshold_version: tver, drop_count: 0, rows: [], not_comparable: [], note: "score_history 中不存在相隔恰好 7 个自然日的真实双日（不补造日期）" });
    const hist = await dbRequest("list_resource", "GET", "score_history", { query: { select: "gpsno,driver_id,score_id,as_of_date,safety_score,score_status,confidence_level,source_version,rank", as_of_date: `in.(${pair[0]},${pair[1]})`, limit: 1800 } });
    let inScope = null;
    const scope = String(user.fleet_scope || "*");
    if (scope !== "*") { const s = await fleetScopeSets(scope); inScope = new Set(s.gps); }
    const qr = await dbRequest("list_resource", "GET", "review_queue", { query: { select: "gpsno,risk_level,review_queue,confidence_level,as_of_date", as_of_date: `eq.${pair[1]}`, limit: 700 } });
    const qmap = {}; for (const x of qr.data || []) qmap[x.gpsno] = x;
    const al = await dbRequest("list_resource", "GET", "alerts", { query: { select: "gpsno,owner_user_id,status", order: "occurred_at.desc", limit: 100 } });
    const ownerByGps = {}; for (const x of al.data || []) if (!ownerByGps[x.gpsno]) ownerByGps[x.gpsno] = x.status !== "closed" ? (x.owner_user_id || "责任人待指派") : "已结案";
    const byG = {};
    for (const x of hist.data || []) { if (inScope && !inScope.has(String(x.gpsno))) continue; (byG[x.gpsno] = byG[x.gpsno] || {})[x.as_of_date] = x; }
    const COMPARABLE = ["usable", "usable_with_review", "manual_review"];
    const rowsOut = []; const notComp = [];
    for (const [g, v] of Object.entries(byG)) {
      const e = v[pair[0]]; const l = v[pair[1]];
      if (!e || !l) { notComp.push({ gpsno: g, driver_id: (e || l || {}).driver_id || null, reason: !e ? "缺较早日（不记为未下滑）" : "缺较晚日（不记为未下滑）" }); continue; }
      if (!COMPARABLE.includes(String(e.score_status)) || !COMPARABLE.includes(String(l.score_status))) { notComp.push({ gpsno: g, driver_id: l.driver_id, reason: "score_status 不可比：" + [e.score_status, l.score_status].join("/") }); continue; }
      if (e.source_version !== l.source_version) { notComp.push({ gpsno: g, driver_id: l.driver_id, reason: "来源版本不同（" + e.source_version + "≠" + l.source_version + "），不比较" }); continue; }
      const drop = Number(e.safety_score) - Number(l.safety_score);
      const q = qmap[g] || {};
      const base = { gpsno: g, driver_id: l.driver_id, early_date: pair[0], late_date: pair[1], early_score: Number(Number(e.safety_score).toFixed(4)), late_score: Number(Number(l.safety_score).toFixed(4)), drop: Number(drop.toFixed(4)), threshold: thr, threshold_version: tver, early_score_id: e.score_id, late_score_id: l.score_id, confidence: l.confidence_level || null, base_tags: [q.review_queue, q.risk_level ? "行为" + q.risk_level : null].filter(Boolean), owner: ownerByGps[g] || "未指派", next_step: String(l.confidence_level) === "low" ? "先设备/数据核验，再复核下滑" : "EV03 复核两日证据与扣分历史；分组仅定人工复核顺序" };
      if (drop >= thr) { rowsOut.push({ ...base, route: `#/ev-fleet?gpsno=${g}` }); }
      else { rowsOut.length; }
    }
    rowsOut.sort((a, b) => b.drop - a.drop);
    sendJson(response, 200, { data_status: "ok", date_pair: pair, threshold: thr, threshold_version: tver, comparable: Object.keys(byG).length - notComp.length, drop_count: rowsOut.length, not_comparable_count: notComp.length, not_comparable: notComp.slice(0, 60), rows: rowsOut, scope_note: scope !== "*" ? "已按你会话的 fleet_scope 过滤" : "全范围会话", generated: "本分组不生成告警/扣分/惩罚/培训任务" });
  } catch (e) {
    if (e instanceof HttpError && e.status !== 500) throw e;
    return sendJson(response, 200, { data_status: "query_failed", note: "下滑统计查询失败（不以 0 冒充）" });
  }
}
async function handleDriverFleetSummary(request, response, url, ctx) {
  const user = requireVerifiedDriver(ctx.principal);
  const driver = (await driverProjectionRead("drivers", { driver_id: `eq.${user.driver_id}`, select: "driver_id,fleet_id", limit: 1 })).data?.[0];
  const score = (await driverProjectionRead("score_snapshots", { driver_id: `eq.${user.driver_id}`, select: "as_of_date", order: "as_of_date.desc,score_id.desc", limit: 1 })).data?.[0];
  if (!driver?.fleet_id || !score?.as_of_date) return sendJson(response, 200, { data_status: "no_data", as_of_date: null, valid_count: null, average: null, distribution: null, note: "缺少本人评分日期或车队档案，不替换成其他日期或车队统计。" });
  const members = await readAll(driverProjectionRead, projectionFail, "drivers", { fleet_id: `eq.${driver.fleet_id}`, select: "driver_id" }, "driver_id");
  const rows = [];
  for (let i=0;i<members.length;i+=100) rows.push(...await readAll(driverProjectionRead, projectionFail, "score_snapshots", { driver_id: `in.(${members.slice(i,i+100).map(x=>x.driver_id).join(",")})`, as_of_date: `eq.${score.as_of_date}`, select: "score_id,driver_id,risk_level,score_status,safety_score,source_version,score_method" }, "score_id"));
  sendJson(response, 200, { ...fleetStatistics(rows), as_of_date: score.as_of_date });
}
async function handleOverview(request, response, url, ctx) {
  const user = requireUser(ctx.principal);
  if (!(ROLE_CAPABILITIES[user.role] || new Set()).has("view.fleet_overview")) throw new HttpError(403, "forbidden");
  const metrics = [];
  for (const m of OVERVIEW_METRICS) {
    try {
      const qm = { ...m.query, limit: 1 };
      let batches = [null];
      { const scopeU = String(user.fleet_scope || "*");
        if (scopeU !== "*" && ["safety_admin", "team_leader"].includes(user.role)) {
          if (m.table === "drivers" || m.table === "user_bindings") qm.fleet_id = `eq.${scopeU}`;
          else if (FLEET_GPS_TABLES.has(m.table) || FLEET_DRV_TABLES.has(m.table)) {
            const s = await fleetScopeSets(scopeU);
            const vals = FLEET_GPS_TABLES.has(m.table) ? s.gps : s.drv; const col = FLEET_GPS_TABLES.has(m.table) ? "gpsno" : "driver_id";
            if (!vals.length) qm[col] = "in.()"; else { batches = []; for (let bi = 0; bi < vals.length; bi += 120) batches.push(vals.slice(bi, bi + 120)); } // 分批求和避免 414
          }
        } }
      let cnt = 0;
      const runs = batches.length && batches[0] !== null ? batches : [null];
      for (const b of runs) {
        const qq = { ...qm }; if (b) { const col2 = FLEET_GPS_TABLES.has(m.table) ? "gpsno" : "driver_id"; qq[col2] = `in.(${b.join(",")})`; }
        const r = await dbRequest("count_resource", "GET", m.table, { query: qq, headers: { Prefer: "count=exact" } });
        if (b) { const dl = (r.data || []); if (r.rangeHeader) cnt += parseCount(r.rangeHeader) ?? dl.length; }
        else cnt = parseCount(r.rangeHeader) ?? (r.data ? r.data.length : null);
      }
      const rangeHeader = "0-0/" + cnt;
      metrics.push({ key: m.key, label: m.label, count: cnt });
    } catch { metrics.push({ key: m.key, label: m.label, count: null, unread: true }); }
  }
  let asOf = null;
  try {
    const r = await dbRequest("list_resource", "GET", "score_snapshots", { query: { select: "as_of_date", order: "as_of_date.desc", limit: 1 } });
    asOf = r.data?.[0]?.as_of_date || null;
  } catch { /* 展示为空即可 */ }
  sendJson(response, 200, { dataImported: Boolean(asOf), asOfDate: asOf, asOfNote: asOf ? null : "业务数据尚未导入（第2轮版本化导入）", metrics });
}

async function handleData(request, response, url, ctx) {
  const resName = decodeURIComponent(url.pathname.slice("/api/data/".length)).replace(/\/+$/, "");
  requireUser(ctx.principal);
  const result = await listResource(ctx.principal, resName, url);
  sendJson(response, 200, result);
}

// ---------- Section: versioned CSV import (admin-only; check -> confirm -> commit) ----------
// 契约来源：data_dictionary.json（15表）与 app_tables.json（4扩展表）。
// 规则：gpsno/driver_id/event_type/所有业务ID按文本存储；空值→NULL（绝不转0）；
// 数值以字符串交给 numeric 列保精度与原始小数位；日期/时间保持原始字符串（仅格式校验）；
// 布尔 true/false/1/0 规范化为 boolean。浏览器绝不直接持有数据库权限，一切经服务端验权。

const T = "text", N = "number", B = "boolean", D = "date", DT = "datetime";

// 19张业务表可导入字段（audit_logs 由系统写入，不接受导入）
const IMPORT_SPECS = {
  drivers: { pk: "driver_id", cols: { driver_id: T, gpsno: T, display_name: T, fleet_id: T, identity_status: T, mapping_start: D, mapping_end: D } },
  risk_snapshots: { pk: "snapshot_id", cols: { snapshot_id: T, gpsno: T, risk_prob: N, risk_rank: N, as_of_date: D, horizon_days: N, source_version: T } },
  score_snapshots: { pk: "score_id", cols: { gpsno: T, safety_score: N, rank: N, risk_rank_percentile: N, risk_level: T, as_of_date: D, window_start: D, reference_version: T, score_method: T, confidence_score: N, confidence_level: T, score_status: T, behavior_safety_score: N, confidence_adjusted_floor: N, observed_behavior_deduction: N, prior_background_deduction: N, gross_reference_deduction: N, uncertainty_reserve: N, score_change_7d: N, history_contribution: N, fatigue_distraction_contribution: N, driving_stability_contribution: N, road_rule_contribution: N, management_contribution: N, imu_evidence_contribution: N, history_event_count: N, fatigue_distraction_event_count: N, driving_stability_event_count: N, road_rule_event_count: N, management_event_count: N, imu_evidence_event_count: N, top_reason_1: T, top_reason_2: T, top_reason_3: T, primary_risk_dimension: T, recommended_action: T, review_cycle: T, forecast_40d_risk_prob: N, review_queue: T, action_deadline: T, immediate_alert: T, driver_id: T, score_id: T, source_version: T } },
  review_queue: { pk: "queue_id", cols: { queue_id: T, gpsno: T, safety_score: N, risk_level: T, forecast_40d_risk_prob: N, review_queue: T, action_deadline: T, confidence_level: T, top_reason_1: T, as_of_date: D, source_version: T } },
  score_history: { pk: "score_id", cols: { score_id: T, gpsno: T, driver_id: T, as_of_date: D, window_start: D, safety_score: N, rank: N, risk_level: T, confidence_score: N, confidence_level: T, score_method: T, score_status: T, confidence_adjusted_floor: N, history_contribution: N, fatigue_distraction_contribution: N, driving_stability_contribution: N, road_rule_contribution: N, management_contribution: N, imu_evidence_contribution: N, source_version: T } },
  deduction_ledger: { pk: "ledger_id", cols: { ledger_id: T, gpsno: T, event_type: T, dimension: T, event_count: N, decayed_severity: N, dimension_points: N, allocated_points: N, allocation_rule: T, as_of_date: D, source_version: T } },
  replay_events: { pk: "event_id", cols: { event_id: T, gpsno: T, driver_id: T, event_time: DT, event_type: T, event_name: T, speed_kmh: N, dimension: T, replay_date: D, is_replay: B, source_version: T } },
  evaluation_rules: { pk: "dimension", cols: { dimension: T, dimension_name: T, weight: N, window_days: N, score_method: T, editable: B, source_version: T } },
  training_courses: { pk: "course_id", cols: { course_id: T, title: T, dimension: T, content: T, completion_requirement: T, content_status: T } },
  operation_config: { pk: "config_id", cols: { config_id: T, value: T, unit: T, config_version: T, updated_by: T, updated_at: DT } },
  user_bindings: { pk: "binding_id", cols: { binding_id: T, platform_user_id: T, role: T, driver_id: T, fleet_id: T, account_status: T } },
  alerts: { pk: "alert_id", cols: { alert_id: T, gpsno: T, driver_id: T, rule_code: T, evidence_id: T, occurred_at: DT, status: T, is_replay: B, replay_session_id: T, idempotency_key: T, rule_version: T, created_by: T, updated_at: DT } },
  interventions: { pk: "intervention_id", cols: { intervention_id: T, alert_id: T, driver_id: T, status: T, draft_text: T, sent_text: T, sent_at: DT, read_at: DT, reply_text: T, replied_at: DT, created_by: T, closed_by: T, closed_at: DT, idempotency_key: T, updated_at: DT } },
  training_tasks: { pk: "task_id", cols: { task_id: T, driver_id: T, alert_id: T, course_id: T, goal: T, mandatory: B, due_at: DT, status: T, started_at: DT, submitted_at: DT, learning_record: T, feedback: T, reviewer_id: T, review_note: T, reviewed_at: DT, created_by: T, idempotency_key: T, updated_at: DT } },
  review_requests: { pk: "request_id", cols: { request_id: T, driver_id: T, score_id: T, evidence_id: T, reason_code: T, description: T, status: T, review_note: T, reviewer_id: T, source_version: T, created_by: T, created_at: DT, updated_at: DT, idempotency_key: T } },
  knowledge_articles: { pk: "article_id", cols: { article_id: T, title: T, version: T, dimension: T, content: T, source_note: T, applicable_role: T, review_status: T, created_by: T, reviewed_by: T, reviewed_at: DT, updated_at: DT } },
  evaluation_rule_drafts: { pk: "draft_id", cols: { draft_id: T, base_version: T, proposal: T, status: T, created_by: T, created_at: DT, reviewed_by: T, reviewed_at: DT, review_note: T, updated_at: DT } },
  notification_events: { pk: "notification_id", cols: { notification_id: T, target_user_id: T, source_entity_type: T, source_entity_id: T, type: T, content: T, created_at: DT, read_at: DT, idempotency_key: T } },
};
// drivers 表契约不含 source_version 列，但线上表可空且导入需要版本口径 —— 白名单允许映射
const TABLE_EXTRA_ALLOWED = { drivers: ["source_version"] };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NUM_RE = /^-?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
const MAX_IMPORT_ROWS = 20000;
const IMPORT_CONFIRM_WINDOW_MS = 30 * 60 * 1000;
const IMPORT_CHUNK = 100;

// 最小 RFC4180 CSV 解析器（引号/转义/嵌入逗号换行；空值保持 "" → null）
function parseCsv(text) {
  const rows = [];
  let field = "", row = [], inQuotes = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); field = ""; rows.push(row); row = []; }
    else if (c === "\r") { /* swallow, handles CRLF via next \n */ }
    else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function normalizeCell(name, kind, raw, lineNo) {
  const v = String(raw ?? "").trim();
  if (v === "") return { value: null };            // 空=null，绝不转0
  switch (kind) {
    case "number":
      if (!NUM_RE.test(v)) return { err: { line: lineNo, field: name, reason: "不是有效数值", value: v.slice(0, 40) } };
      return { value: v };                           // 字符串交给 numeric，保留原始小数位文本
    case "boolean": {
      const low = v.toLowerCase();
      if (["true", "1", "t", "yes", "y"].includes(low)) return { value: true };
      if (["false", "0", "f", "no", "n"].includes(low)) return { value: false };
      return { err: { line: lineNo, field: name, reason: "不是布尔值(true/false)", value: v.slice(0, 40) } };
    }
    case "date":
      if (!DATE_RE.test(v)) return { err: { line: lineNo, field: name, reason: "不是日期 YYYY-MM-DD", value: v.slice(0, 40) } };
      return { value: v };
    case "datetime":
      if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return { err: { line: lineNo, field: name, reason: "不是日期时间", value: v.slice(0, 40) } };
      if (v.length > 64) return { err: { line: lineNo, field: name, reason: "时间戳过长", value: v.slice(0, 40) } };
      return { value: v };                            // 原始日期时间字符串原样保留
    default:
      if (v.length > 8000) return { err: { line: lineNo, field: name, reason: "文本过长(>8000)", value: v.slice(0, 40) } };
      return { value: v };                            // 文本保持原值（前导零、编码不变）
  }
}

// 预检：不写任何业务表；生成 run 记录 + 幂等键 + 报告哈希
async function runPrecheck(principal, body, ctx) {
  const user = requireUser(principal);
  const table = String(body.table || "");
  const spec = IMPORT_SPECS[table];
  if (!spec) throw new HttpError(400, "unsupported_table");
  const filename = String(body.filename || "").slice(0, 200);
  const csv = String(body.csv || "");
  if (Buffer.byteLength(csv, "utf8") > MAX_IMPORT_BYTES) throw new HttpError(413, "file_too_large");
  const sourceVersion = String(body.source_version || "").slice(0, 100) || null;
  const rows = parseCsv(csv);
  const report = {
    ok: true, filename, table,
    header: [], unknown_columns: [], missing_columns: [],
    row_total: Math.max(rows.length - 1, 0),
    dup_pk: [], rejected_rows: [], type_errors: [], blank_pk_rows: 0,
    will_insert: 0, will_update_hint_count: null,
    source_version_in_file: null, source_version_input: sourceVersion,
    warnings: [],
  };
  if (rows.length === 0) { report.ok = false; report.fatal = "空文件或无有效行"; return { status: "fatal", report }; }
  const header = rows[0].map((h) => h.trim().replace(/^\ufeff/, ""));
  report.header = header;
  const allowed = new Set([...Object.keys(spec.cols), ...(TABLE_EXTRA_ALLOWED[table] || [])]);
  report.unknown_columns = header.filter((h) => h && !allowed.has(h));
  if (report.unknown_columns.length) { report.ok = false; report.fatal = "存在契约外未知列（导入会静默丢数据，已拒绝）: " + report.unknown_columns.join(","); }
  report.missing_contract_columns = Object.keys(spec.cols).filter((c) => !header.includes(c));
  if (spec.cols[spec.pk] !== undefined && !header.includes(spec.pk)) { report.ok = false; report.fatal = "表头缺少业务主键列 " + spec.pk; }
  report.warnings.push("缺失的契约列不会被更新（UPSERT 仅写文件内出现的列）：" + report.missing_contract_columns.join(",") + "。");
  const known = Object.fromEntries(header.map((h, i) => [h, i]));
  const seen = new Map();
  let dupCount = 0, rejected = 0;
  for (let r = 1; r < rows.length; r++) {
    const lineNo = r + 1;
    const raw = rows[r];
    const pkIdx = known[spec.pk];
    if (pkIdx === undefined) { report.ok = false; report.fatal = "表头缺少业务主键列"; break; }
    const pkVal = String(raw[pkIdx] ?? "").trim();
    if (!pkVal) { report.blank_pk_rows++; rejected++; report.rejected_rows.push({ line: lineNo, reason: "业务主键为空" }); continue; }
    if (seen.has(pkVal)) {
      dupCount++;
      const prev = seen.get(pkVal);
      if (report.dup_pk.length < 50) report.dup_pk.push({ key: spec.pk + "=" + pkVal, lines: [prev, lineNo], kept: "last_will_win" });
      else if (report.dup_pk.length === 50) report.warnings.push("重复主键数量超过50，未全部列出");
    }
    let rowErr = false;
    seen.set(pkVal, lineNo);
    for (const [col, type] of Object.entries(spec.cols)) {
      const idx = known[col];
      if (idx === undefined) continue;                 // 列缺失：该列不更新
      const cell = normalizeCell(col, type, raw[idx], lineNo);
      if (cell.err) {
        rowErr = true;
        if (report.type_errors.length < 50) report.type_errors.push(cell.err);
        else if (report.type_errors.length === 50) report.warnings.push("类型错误数量超过50，未全部列出");
      }
    }
    if (rowErr) rejected++;
  }
  report.rejected_count = rejected;
  report.accepted_row_estimate = Math.max(rows.length - 1 - rejected, 0);
  report.dup_pk_count = dupCount;
  if (rows.length - 1 > MAX_IMPORT_ROWS) { report.ok = false; report.fatal = `行数超过 ${MAX_IMPORT_ROWS} 上限`; }
  const inputSha = sha256hex(table + "\n" + (sourceVersion || "") + "\n" + csv);
  const runId = newId("imp");
  const status = report.ok ? "checked" : "rejected";
  // 幂等键：相同内容(表+版本+文件指纹) 30 分钟窗口内复用提示
  const now = nowIso();
  report.run_id = runId;
  report.confirm_window_minutes = IMPORT_CONFIRM_WINDOW_MS / 60000;
  const runRow = {
    run_id: runId, filename, target_table: table, source_version: sourceVersion, input_sha256: inputSha,
    check_status: status, row_total: rows.length - 1,
    accepted_count: Math.max(rows.length - 1 - rejected, 0), rejected_count: rejected,
    dup_pk_count: dupCount, type_error_count: (report.type_errors || []).length,
    unknown_columns: report.unknown_columns.join(","), check_report_json: JSON.stringify(report),
    created_at: now, updated_at: now,
    actor_id: user.user_id, actor_role: user.role, request_id: ctx.requestId,
    idempotency_key: `check:${sha256hex(inputSha + ":" + filename)}`,
  };
  return { status, report, runRow };
}

async function handleImportCheck(request, response, url, ctx) {
  const body = await readBody(request, MAX_IMPORT_BYTES + 65536);
  const prepared = await runPrecheck(ctx.principal, body, ctx);
  if (prepared.runRow) {
    // 幂等：同内容+同目标表+同文件名直接复用既有预检运行（不新增 run、不重复写业务表）
    const exist = await dbRequest("list_import_by_key", "GET", "import_runs", {
      query: { idempotency_key: `eq.${prepared.runRow.idempotency_key}`, select: "run_id,check_status,check_report_json,commit_report_json" },
    });
    const prev = exist.data?.[0];
    if (prev) {
      const replay = { ...JSON.parse(prev.check_report_json || "{}"), run_id: prev.run_id, idempotent_replay: true };
      if (prev.commit_report_json) replay.already_committed = true;
      replay.audit_id = await appendAudit(ctx.principal, "import.check.replay", "import_run", prev.run_id, prev.check_status, prev.check_status, ctx.requestId);
      return sendJson(response, 200, replay);
    }
    prepared.report.audit_id = await appendAudit(ctx.principal, "import.check", "import_run", prepared.report.run_id, null, prepared.status, ctx.requestId);
    prepared.runRow.created_audit_id = prepared.report.audit_id ?? null;
    try {
      await dbRequest("insert_import_run", "POST", "import_runs", { body: [prepared.runRow], headers: { Prefer: "return=minimal" } });
    } catch (e) {
      if (e instanceof HttpError && e.code === "db_conflict") {
        const again = await dbRequest("list_import_by_key", "GET", "import_runs", {
          query: { idempotency_key: `eq.${prepared.runRow.idempotency_key}`, select: "run_id,check_status,check_report_json" },
        });
        const other = again.data?.[0];
        if (other) return sendJson(response, 200, { ...JSON.parse(other.check_report_json || "{}"), run_id: other.run_id, idempotent_replay: true });
      }
      throw e;
    }
  }
  sendJson(response, 200, prepared.report);
}

async function handleImportCommit(request, response, url, ctx) {
  const user = requireUser(ctx.principal);
  const body = await readBody(request, MAX_IMPORT_BYTES + 65536);
  const runId = String(body.run_id || "");
  if (!/^imp-[0-9a-f]{16}$/.test(runId)) throw new HttpError(400, "bad_request");
  // 先查已有提交结果（幂等：重复点击返回既有记录）
  const runRes = await dbRequest("get_import_run", "GET", "import_runs", { query: { run_id: `eq.${runId}`, select: "*" } });
  const run = runRes.data?.[0];
  if (!run) throw new HttpError(404, "not_found");
  if (run.commit_report_json) {
    const auditId = await appendAudit(user, "import.commit.replay", "import_run", runId, "committed", "committed_replayed", ctx.requestId);
    return sendJson(response, 200, { idempotent_replay: true, replay_audit_id: auditId, ...JSON.parse(run.commit_report_json) });
  }
  if (run.check_status !== "checked") throw new HttpError(409, "precheck_not_passed");
  if (run.actor_id !== user.user_id) throw new HttpError(403, "forbidden"); // 仅发起人可确认同一预检
  if (Date.parse(run.created_at) + IMPORT_CONFIRM_WINDOW_MS < Date.now()) throw new HttpError(410, "confirm_window_expired");
  const csv = String(body.csv || "");
  const inputSha = sha256hex(run.target_table + "\n" + (run.source_version || "") + "\n" + csv);
  if (inputSha !== run.input_sha256) throw new HttpError(409, "content_changed_since_check");
  const spec = IMPORT_SPECS[run.target_table];
  const rows = parseCsv(csv);
  // 提交端二次防线：契约外未知列 / 缺主键列的 CSV 即使带着旧 run 也拒绝写入
  {
    const h0 = (rows[0] || []).map((h) => h.trim().replace(/^\ufeff/, ""));
    const allowedC = new Set([...Object.keys(spec.cols), ...(TABLE_EXTRA_ALLOWED[run.target_table] || [])]);
    const unknownC = h0.filter((h) => h && !allowedC.has(h));
    if (unknownC.length) throw new HttpError(409, "unknown_columns_in_header");
    if (!h0.includes(spec.pk)) throw new HttpError(409, "missing_pk_column");
  }
  // 重新归一化，按主键 last-wins 去重；空值→null；文本保原样
  const header = rows[0].map((h) => h.trim().replace(/^\ufeff/, ""));
  const known = Object.fromEntries(header.map((h, i) => [h, i]));
  const byPk = new Map();
  const rejected = [];
  for (let r = 1; r < rows.length; r++) {
    const lineNo = r + 1;
    const raw = rows[r];
    const pkVal = String(raw[known[spec.pk]] ?? "").trim();
    const out = {}; let bad = false;
    if (!pkVal) { rejected.push({ line: lineNo, reason: "业务主键为空" }); continue; }
    for (const [col, type] of Object.entries(spec.cols)) {
      const idx = known[col];
      if (idx === undefined) continue;
      const cell = normalizeCell(col, type, raw[idx], lineNo);
      if (cell.err) { bad = true; rejected.push(cell.err); break; }
      out[col] = cell.value;
    }
    if (bad) continue;
    // 运行级 source_version 口径：仅补齐文件中该列为空的行，不覆写文件原值
    if (run.source_version && "source_version" in spec.cols && out.source_version === null) out.source_version = run.source_version;
    byPk.set(pkVal, out);
  }
  const acceptedRows = [...byPk.values()];
  // 空导入防线：无有效行且目标表已有记录时拒绝，防止空模板误提交（UPSERT 不改写文件外列/不删行）
  if (acceptedRows.length === 0) {
    const cur = await dbRequest("list_resource", "GET", run.target_table, { query: { select: spec.pk, limit: 1 } });
    if (cur.data?.length) throw new HttpError(409, "empty_import_guard");
  }
  const commitReport = {
    run_id: runId, table: run.target_table, filename: run.filename,
    submitted_rows: Math.max(rows.length - 1, 0),
    upserted: 0, rejected_final: rejected.length,
    chunks: [], mode: "upsert_on_business_pk",
  };
  let failed = false;
  for (let i = 0; i < acceptedRows.length; i += IMPORT_CHUNK) {
    const chunk = acceptedRows.slice(i, i + IMPORT_CHUNK);
    try {
      await dbRequest("upsert_resource", "POST", run.target_table, {
        query: { on_conflict: spec.pk },
        body: chunk,
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      });
      commitReport.upserted += chunk.length;
      commitReport.chunks.push({ from: i + 1, to: i + chunk.length, ok: true });
    } catch (err) {
      failed = true;
      commitReport.chunks.push({ from: i + 1, to: i + chunk.length, ok: false, reason: "write_failed" });
      break;
    }
  }
  const now = nowIso();
  commitReport.finished_at = now;
  commitReport.result = failed ? "partial_failed" : "committed";
  await dbRequest("update_import_run", "PATCH", "import_runs", {
    query: { run_id: `eq.${runId}` },
    body: { commit_report_json: JSON.stringify(commitReport), updated_at: now, committed_at: now },
    headers: { Prefer: "return=minimal" },
  });
  const auditId = await appendAudit(user, failed ? "import.commit.partial_failed" : "import.commit", "import_run", runId, "checked", commitReport.result, ctx.requestId);
  commitReport.audit_id = auditId;
  await dbRequest("update_import_run", "PATCH", "import_runs", { query: { run_id: `eq.${runId}` }, body: { commit_audit_id: auditId }, headers: { Prefer: "return=minimal" } }).catch(() => {});
  sendJson(response, failed ? 500 : 200, commitReport);
}


// ---------- Section: admin binding management (SM01/SM02) ----------
// ===== R23：SM02 时段冲突引擎（闭区间：start 含当日，end 含当日；null=开放有效；相邻=start_next > end_prev） =====
const BIND_OPEN = "9999-12-31T23:59:59.999Z";
function normWin(s, e) {
  const D = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
  if (s && !D.test(s)) throw new HttpError(400, "bad_start_date");
  if (e && !D.test(e)) throw new HttpError(400, "bad_end_date");
  if (s && e && e < s) throw new HttpError(409, "invalid_window_end_before_start");
  return { start: s ? s + "T00:00:00.000Z" : null, end: e ? e + "T23:59:59.999Z" : null };
}
function winOverlap(s1, e1, s2, e2) {
  const lo = (s1 || "0000") > (s2 || "0000") ? (s1 || "0000") : (s2 || "0000");
  const hi = (e1 || BIND_OPEN) < (e2 || BIND_OPEN) ? (e1 || BIND_OPEN) : (e2 || BIND_OPEN);
  return lo <= hi;
}
async function findBindingConflicts({ driverId, userId, startS, endS, excludeBindingId }) {
  const rows = await dbRequest("bind_conflict_q", "GET", "user_bindings", { query: { account_status: "eq.active", select: "binding_id,user_id,driver_id,effective_start,effective_end", limit: 500 } });
  const out = [];
  for (const b of rows.data || []) {
    if (excludeBindingId && String(b.binding_id) === String(excludeBindingId)) continue;
    if (!winOverlap(startS, endS, b.effective_start, b.effective_end)) continue;
    if (driverId && b.driver_id && String(b.driver_id) !== String(userId ? "" : "") && String(b.driver_id) === String(driverId) && String(b.user_id) !== String(userId || "\u0000")) out.push({ kind: "driver_slot_taken", binding_id: b.binding_id, driver_id: b.driver_id, user_id: b.user_id });
    if (userId && b.driver_id && String(b.driver_id) !== String(driverId || "\u0000") && String(b.user_id) === String(userId)) out.push({ kind: "user_multi_driver", binding_id: b.binding_id, driver_id: b.driver_id });
  }
  return out;
}
let bindingMutex = Promise.resolve();
function withBindingLock(fn) { const run = bindingMutex.then(fn, fn); bindingMutex = run.then(() => undefined, () => undefined); return run; }

async function handleBindingsList(request, response, url, ctx) { requireUser(ctx.principal, "manage.bindings"); const asOf = String(url.searchParams.get("as_of") || ""); const { data } = await dbRequest("bind_rows", "GET", "user_bindings", { query: { select: "binding_id,user_id,platform_user_id,role,driver_id,fleet_id,account_status,identity_status,effective_start,effective_end,note,updated_at", order: "effective_start.desc", limit: 300 } }); let rows = data || []; if (asOf && /^\d{4}-\d{2}-\d{2}$/.test(asOf)) { const d = asOf + "T12:00:00.000Z"; rows = rows.filter((x) => (!x.effective_start || x.effective_start <= d) && (!x.effective_end || x.effective_end >= d)); } sendJson(response, 200, { ok: true, rows, as_of: asOf || null, note: "按 as_of 过滤当日有效关系；未传 as_of 返回全部" }); }
async function handleBindingPreview(request, response, url, ctx) {
  requireUser(ctx.principal, "manage.bindings");
  const q = url.searchParams;
  const s = String(q.get("start") || "").slice(0, 10) || null;
  const eRaw = q.get("end"); const e = eRaw === null || eRaw === "" ? null : eRaw.slice(0, 10);
  let startS = null; let endS = null;
  try { const w = normWin(s, e); startS = w.start; endS = w.end; } catch (er) { return sendJson(response, 400, { error: er.message || String(er) }); }
  if (s && e && e < s) return sendJson(response, 200, { ok: true, invalid: true, conflicts: [], window: [s, e] });
  const cf = await findBindingConflicts({ driverId: String(q.get("driver_id") || ""), userId: String(q.get("user_id") || ""), startS, endS, excludeBindingId: String(q.get("exclude") || "") || null });
  sendJson(response, 200, { ok: true, conflicts: cf, window: [startS, endS], boundary_rule: "闭区间含首尾日；相邻(次日开始)允许；空结束=持续有效；编辑传 exclude=自身 binding_id" });
}
async function handleBindingDelete(request, response, url, ctx) {
  requireUser(ctx.principal, "manage.bindings");
  const body = await readBody(request);
  const bindingId = String(body.binding_id || "");
  const row = (await dbRequest("bind_rows", "GET", "user_bindings", { query: { binding_id: `eq.${bindingId}`, limit: 1 } })).data?.[0];
  if (!row) throw new HttpError(404, "not_found");
  if (["演示绑定（synthetic_demo_mapping）", "已核实"].includes(String(row.identity_status)) && row.account_status === "active" && String(row.user_id) !== "u-") {} // 生产行删除也走本端点：留全量快照审计
  await dbRequest("bind_delete_row", "DELETE", "user_bindings", { query: { binding_id: `eq.${bindingId}` } });
  const auditId = await appendAudit(ctx.principal, "account.binding_delete", "user_binding", String(bindingId), row.account_status, "deleted", ctx.requestId, null, { snapshot: row });
  sendJson(response, 200, { ok: true, binding_id: bindingId, audit_id: auditId });
}

async function bind_rows1(id) { return (await dbRequest("bind_rows", "GET", "user_bindings", { query: { binding_id: `eq.${id}`, limit: 1 } })).data?.[0] || null; }
async function handleBindingReschedule(request, response, url, ctx, bindingIdArg) {
  const admin = requireUser(ctx.principal, "manage.bindings");
  const body = await readBody(request);
  const bindingId = String(bindingIdArg || body.binding_id || "");
  return withBindingLock(async () => {
    const cur = await bind_rows1(bindingId);
    if (!cur) throw new HttpError(404, "not_found");
    const w = normWin(body.start ? String(body.start).slice(0, 10) : null, body.end === undefined ? null : (body.end ? String(body.end).slice(0, 10) : null));
    const startS = w.start || cur.effective_start; const endS = w.end !== null ? w.end : (body.end === null ? null : cur.effective_end);
    if (startS && endS && endS < startS) throw new HttpError(409, "invalid_window_end_before_start");
    if (cur.driver_id) await assertInScope(ctx.principal, { driverId: String(cur.driver_id) });
    const cf = await findBindingConflicts({ driverId: cur.driver_id, userId: cur.user_id, startS, endS, excludeBindingId: bindingId }); // 编辑排除自身
    if (cf.length) { await appendAudit(admin, "account.binding_conflict_refused", "user_binding", bindingId, null, "refused", ctx.requestId, null, { conflicts: cf.slice(0, 5), window: [startS, endS] }); throw new HttpError(409, "binding_window_conflict:" + [...new Set(cf.map((x) => x.kind))].join("/")); }
    const at = nowIso();
    await dbRequest("bind_patch_row", "PATCH", "user_bindings", { query: { binding_id: `eq.${bindingId}` }, body: { effective_start: startS, effective_end: endS, updated_at: at }, headers: { Prefer: "return=minimal" } });
    await appendAudit(admin, "account.binding_reschedule", "user_binding", bindingId, [cur.effective_start, cur.effective_end].join("~"), [startS, endS].join("~"), ctx.requestId, null, { driver_id: cur.driver_id, user_id: cur.user_id });
    sendJson(response, 200, { ok: true, binding_id: bindingId, old_window: [cur.effective_start, cur.effective_end], window: [startS, endS] });
  });
}
async function handleBindingSet(request, response, url, ctx) {
  const admin = requireUser(ctx.principal, "manage.bindings");
  const body = await readBody(request);
  const targetUserId = String(body.user_id || "").slice(0, 64);
  const driverId = body.driver_id === null || body.driver_id === undefined || body.driver_id === "" ? null : String(body.driver_id).trim().slice(0, 64);
  const verified = Boolean(body.verified);
  const note = String(body.note ?? "").slice(0, 200);
  if (!targetUserId) throw new HttpError(400, "bad_request");
  if (driverId) await assertInScope(ctx.principal, { driverId });
  const ures = await dbRequest("get_binding_user", "GET", "app_users", { query: { user_id: `eq.${targetUserId}`, select: "user_id,role,driver_id,account_status" } });
  const target = ures.data?.[0];
  if (!target) throw new HttpError(404, "not_found");
  if (!["safety_admin", "driver", "team_leader"].includes(target.role)) throw new HttpError(400, "bad_request");
  let driverProfile = null;
  if (driverId) {
    const dres = await dbRequest("get_driver_profile", "GET", "drivers", { query: { driver_id: `eq.${driverId}`, select: "driver_id,gpsno,identity_status,mapping_start,mapping_end", limit: 1 } });
    driverProfile = dres.data?.[0] || null;
    if (!driverProfile) throw new HttpError(409, "driver_not_imported");
  }
  const at = nowIso();
  const win = body.window ? normWin(String(body.window.start || "").slice(0, 10) || null, body.window.end === null ? null : String(body.window.end || "").slice(0, 10) || null) : null;
  const startS = win && win.start ? win.start : at; const endS = win && win.end !== undefined ? win.end : null;
  const identityStatus = driverId ? (verified ? (String(driverProfile.identity_status || "").includes("synthetic") ? "演示绑定（synthetic_demo_mapping）" : "已核实") : "待核实") : "未绑定";
  return withBindingLock(async () => {
    if (driverId) {
      const legacy = await dbRequest("count_driver_conflict", "GET", "app_users", { query: { driver_id: `eq.${driverId}`, account_status: "eq.active", user_id: `neq.${targetUserId}`, select: "user_id", limit: 1 } });
      if (!win && (legacy.data || []).length) throw new HttpError(409, "binding_conflict"); // 时段模式由窗口冲突引擎判定
      const cf = await findBindingConflicts({ driverId, userId: targetUserId, startS, endS });
      if (cf.length) { await appendAudit(admin, "account.binding_conflict_refused", "user_binding", targetUserId + ":" + driverId, null, "refused", ctx.requestId, null, { conflicts: cf.slice(0, 6), window: [startS, endS] }); throw new HttpError(409, "binding_window_conflict:" + [...new Set(cf.map((x) => x.kind))].join("/")); }
      const idem = (await dbRequest("bind_rows", "GET", "user_bindings", { query: { user_id: `eq.${targetUserId}`, driver_id: `eq.${driverId}`, account_status: "eq.active", effective_start: `eq.${startS}`, effective_end: endS === null ? "is.null" : `eq.${endS}`, limit: 1 } })).data?.[0];
      if (idem) { sendJson(response, 200, { ok: true, idempotent_replay: true, binding_id: idem.binding_id, user_id: targetUserId, driver_id: driverId, window: [startS, endS], identity_status: identityStatus }); return; }
    }
    if (!win) await dbRequest("close_binding_rows", "PATCH", "user_bindings", { query: { user_id: `eq.${targetUserId}`, account_status: "eq.active", platform_user_id: "is.null" }, body: { account_status: "inactive", effective_end: at, updated_at: at }, headers: { Prefer: "return=minimal" } }); // 平台SSO绑定行独立生命周期：本地解绑永不关闭之
    if (win && verified) { const nowR = nowIso(); const coversNow = (!startS || startS <= nowR) && (!endS || endS >= nowR); if (coversNow || !endS) { await dbRequest("patch_binding_fields", "PATCH", "app_users", { query: { user_id: `eq.${targetUserId}` }, body: { driver_id: driverId, binding_verified: true, binding_note: note || identityStatus, updated_at: nowR }, headers: { Prefer: "return=minimal" } }); } }
    const bindingId = newId("bd");
    if (driverId) {
      await dbRequest("bind_insert", "POST", "user_bindings", { body: [{ binding_id: bindingId, user_id: targetUserId, platform_user_id: null, role: target.role, driver_id: driverId, fleet_id: driverProfile.gpsno ? await (async () => { const fr = await dbRequest("drv_exists", "GET", "drivers", { query: { gpsno: `eq.${driverProfile.gpsno}`, select: "fleet_id", limit: 1 } }); return fr[0]?.fleet_id || null; })() : null, account_status: "active", identity_status: identityStatus, effective_start: startS, effective_end: endS, note, updated_at: at }], headers: { Prefer: "return=minimal" } });
      const back = await findBindingConflicts({ driverId, userId: targetUserId, startS, endS, excludeBindingId: bindingId });
      if (back.length) {
        await dbRequest("bind_patch_row", "PATCH", "user_bindings", { query: { binding_id: `eq.${bindingId}` }, body: { account_status: "inactive", effective_end: nowIso(), updated_at: nowIso(), note: "并发回滚：写后回读发现重叠" }, headers: { Prefer: "return=minimal" } });
        await appendAudit(admin, "account.binding_rolled_back", "user_binding", bindingId, "active", "inactive", ctx.requestId, null, { found: back.slice(0, 3) });
        throw new HttpError(409, "binding_concurrent_conflict_rolled_back");
      }
    }
    if (!win || !verified) await dbRequest("patch_binding_fields", "PATCH", "app_users", { query: { user_id: `eq.${targetUserId}` }, body: { driver_id: (win && verified) ? undefined : (verified ? driverId : null), binding_verified: Boolean(driverId) && verified, binding_note: driverId ? (note || identityStatus) : null, updated_at: at }, headers: { Prefer: "return=minimal" } });
    const auditId = await appendAudit(admin, driverId ? "account.binding_set" : "account.binding_cleared", "app_user", targetUserId, target.driver_id || "未绑定", driverId ? `${driverId}/${identityStatus}` : "未绑定", ctx.requestId, null, { window: [startS, endS], binding_id: driverId ? bindingId : null });
    sendJson(response, 200, { ok: true, binding_id: driverId ? bindingId : null, user_id: targetUserId, driver_id: verified ? driverId : null, identity_status: identityStatus, window: driverId ? [startS, endS] : null, audit_id: auditId });
  });
}

// ---------- Section: gated writes (ops config versioning / course review / assignment gate) ----------
const COURSE_APPROVED = "approved"; // 只有人工审核到达该状态才可正式分配/通知/被AI当制度引用
async function handleCourseReview(request, response, url, ctx) {
  const admin = requireUser(ctx.principal);
  const body = await readBody(request);
  const courseId = String(body.course_id || "").slice(0, 40);
  const next = String(body.new_status || "").slice(0, 40);
  const note = String(body.note || "").slice(0, 400);
  const FLOW = { "demo_draft_requires_team_review": ["pending_review"], "draft": ["pending_review"], "pending_review": [COURSE_APPROVED, "draft"], "approved": ["disabled"], "disabled": ["pending_review"] };
  if (!courseId || !next) throw new HttpError(400, "bad_request");
  if (!["pending_review", COURSE_APPROVED, "draft", "disabled"].includes(next)) throw new HttpError(400, "bad_request");
  const { data } = await dbRequest("get_course_row", "GET", "training_courses", { query: { course_id: `eq.${courseId}`, select: "course_id,title,content_status,version_no" } });
  const course = data?.[0];
  if (!course) throw new HttpError(404, "not_found");
  if (!(FLOW[course.content_status] || []).includes(next)) throw new HttpError(409, "invalid_status_transition");
  const at = nowIso();
  await dbRequest("patch_course_status", "PATCH", "training_courses", {
    query: { course_id: `eq.${courseId}` },
    body: { content_status: next, version_no: (Number(course.version_no) || 0) + 1, updated_at: at },
    headers: { Prefer: "return=minimal" },
  });
  const auditId = await appendAudit(ctx.principal, "course.review", "training_course", courseId, course.content_status, next, ctx.requestId);
  sendJson(response, 200, { ok: true, course_id: courseId, old_status: course.content_status, new_status: next, version_no: (Number(course.version_no) || 0) + 1, reviewed_by: admin.user_id, audit_id: auditId, note });
}

async function handleOpsConfigUpdate(request, response, url, ctx) {
  requireUser(ctx.principal);
  const body = await readBody(request);
  const key = String(body.config_id || "").slice(0, 60);
  const value = String(body.value ?? "").slice(0, key === "training_mandate_policy" ? 240 : 60);
  const effectiveAt = String(body.effective_at || nowIso()).slice(0, 40);
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(key) || !value) throw new HttpError(400, "bad_request");
  const policyIn = key === "training_mandate_policy" ? parseMandatePolicy(value) : null;
  if (key === "training_mandate_policy" && !policyIn) throw new HttpError(409, "mandate_policy_invalid");
  const { data } = await dbRequest("get_config_row", "GET", "operation_config", { query: { config_id: `eq.${key}`, select: "config_id,value,unit,config_version" } });
  const row = data?.[0];
  if (!row && key === "training_mandate_policy") {
    await dbRequest("ops_insert", "POST", "operation_config", { body: [{ config_id: key, value: JSON.stringify(policyIn), unit: "json", config_version: "1", updated_at: nowIso() }], headers: { Prefer: "return=minimal" } });
    const aid0 = await appendAudit(ctx.principal, "ops.config_create", "operation_config", key, null, value, ctx.requestId, [], { note: "风险等级→强制性培训映射（运营配置域；生效版本+审计）" });
    return sendJson(response, 201, { ok: true, config_id: key, old_value: null, new_value: JSON.stringify(policyIn), old_version: 0, new_version: 1, audit_id: aid0 });
  }
  if (!row && key === "ai_long_session" && ["on", "off"].includes(value)) {
    await dbRequest("ops_insert", "POST", "operation_config", { body: [{ config_id: key, value, unit: "flag", config_version: 1, updated_at: nowIso() }], headers: { Prefer: "return=minimal" } });
    const aid0 = await appendAudit(ctx.principal, "ops.config_create", "operation_config", key, null, value, ctx.requestId, [], { note: "AI 跨登录长期摘要开关（默认 off；仅存脱敏摘要于浏览器本地）" });
    return sendJson(response, 201, { ok: true, config_id: key, old_value: null, new_value: value, old_version: 0, new_version: 1, audit_id: aid0 });
  }
  if (!row) throw new HttpError(404, "not_found");
  const nextVersion = (Number(row.config_version) || 0) + 1;
  const at = nowIso();
  await dbRequest("patch_config_row", "PATCH", "operation_config", {
    query: { config_id: `eq.${key}` },
    body: { value: String(value), config_version: String(nextVersion), updated_by: ctx.principal.user.user_id, updated_at: at, effective_at: effectiveAt },
    headers: { Prefer: "return=minimal" },
  });
  const auditId = await appendAudit(ctx.principal, "ops_config.update", "operation_config", key, `${row.value}@v${row.config_version}`, `${value}@v${nextVersion}`, ctx.requestId);
  sendJson(response, 200, { ok: true, config_id: key, old_value: row.value, new_value: value, old_version: row.config_version, new_version: nextVersion, effective_at: effectiveAt, audit_id: auditId });
}

// R30：发送链模板接入（approved-only；无参照/未审核→回退内置文案，不阻塞业务；缺事实渲染「待核」不编造）
async function resolveTemplateForSend(templateRef, scene, facts) {
  if (!templateRef || !(await probeTemplates())) return null;
  const ref = String(templateRef).slice(0, 80);
  let rows = [];
  if (/^nt-/.test(ref)) rows = await listRows("tpl_list", "notification_templates", { template_id: `eq.${ref}`, select: "template_id,template_key,version,body,review_status,scene", limit: 1 });
  else if (ref.includes(":")) { const [k, v] = ref.split(":"); rows = await listRows("tpl_list", "notification_templates", { template_key: `eq.${k}`, version: `eq.${Number(v) || 1}`, select: "template_id,template_key,version,body,review_status,scene", limit: 1 }); }
  const row = rows[0];
  if (!row || String(row.review_status) !== "approved" || String(row.scene) !== scene) { const err = new Error("template_not_usable"); err.templateDiag = row ? { id: row.template_id, status: row.review_status, scene: row.scene } : "not_found"; throw err; }
  return { template_id: row.template_id, template_key: row.template_key, version: Number(row.version), body: String(row.body).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, name) => (facts[name] !== undefined && facts[name] !== null && facts[name] !== "" ? String(facts[name]) : `（待核：${name}）`)), fallback_used: false };
}

async function handleTrainingAssign(request, response, url, ctx) {
  const user = requireUser(ctx.principal, "assign.training");
  const body = await readBody(request);
  await assertInScope(ctx.principal, { driverId: String(body.driver_id || "") });
  const courseId = String(body.course_id || "").slice(0, 40);
  const driverId = String(body.driver_id || "").slice(0, 60);
  if (!courseId || !driverId) throw new HttpError(400, "bad_request");
  const alertIdIn = String(body.alert_id || "").slice(0, 60);
  const idem = String(body.idempotency_key || `assign:${courseId}:${driverId}:${alertIdIn || "none"}`).slice(0, 120);
  const dup = await dbRequest("count_ops_rows", "GET", "training_tasks", { query: { idempotency_key: `eq.${idem}`, select: "task_id,status,updated_at,driver_id,course_id,alert_id,mandatory", limit: 1 } });
  if (dup.data?.length) {
    const old = dup.data[0];
    if (old.driver_id !== driverId || old.course_id !== courseId || String(old.alert_id || "") !== alertIdIn) throw new HttpError(409, "assignment_idempotency_conflict");
    const notification = await taskNotification(old, "assigned");
    return sendJson(response, 200, { ok: true, idempotent_replay: true, task_id: old.task_id, status: old.status, mandatory: old.mandatory, created_at: old.updated_at, notification, assigned_notification: notification.notification_id });
  }
  const c = await dbRequest("get_course_row", "GET", "training_courses", { query: { course_id: `eq.${courseId}`, select: "course_id,title,content,completion_requirement,content_status,version_no,source_version" } });
  const course = c.data?.[0];
  if (!course) throw new HttpError(404, "not_found");
  if (course.content_status !== COURSE_APPROVED) throw new HttpError(409, "course_not_approved");
  const b = await dbRequest("get_binding_target", "GET", "user_bindings", {
    query: { driver_id: `eq.${driverId}`, account_status: "eq.active", identity_status: "eq.已核实", select: "binding_id,user_id,identity_status", limit: 1 },
  });
  if (!b.data?.[0]) {
    const drv = await dbRequest("get_binding_target", "GET", "app_users", { query: { driver_id: `eq.${driverId}`, account_status: "eq.active", select: "user_id,binding_verified", limit: 1 } });
    if (!drv.data?.[0]?.binding_verified) throw new HttpError(409, "driver_binding_unverified");
  }
  if (alertIdIn) {
    const av = await dbRequest("get_alert_row", "GET", "alerts", { query: { alert_id: `eq.${alertIdIn}`, select: "alert_id,gpsno,driver_id,status", limit: 1 } });
    const ar = av.data?.[0];
    if (!ar) throw new HttpError(409, "evidence_alert_not_found");
    if (ar.driver_id && ar.driver_id !== driverId) throw new HttpError(409, "evidence_driver_mismatch");
  }
  if (!(await taskLearning({ task_id: "__schema_probe__" })).available) throw new HttpError(503, "learning_migration_required");
  let assignNoteUsed = null;
  let msg = `新培训任务（课程 ${courseId}），请在“培训任务”查看并完成；本消息为站内演示通知，非外部渠道送达。`;
  // Validate all caller-controlled content before creating the task.
  if (body.template_ref) {
    try { const tr = await resolveTemplateForSend(body.template_ref, "task_assigned", { driver_id: driverId, alert_id: alertIdIn, event_date: null, evidence_type: null, review_note: null }); if (!tr) throw new HttpError(503, "template_unavailable"); msg = tr.body + `\n（模板 ${tr.template_key}:v${tr.version}；本消息为站内演示通知，非外部渠道送达）`; assignNoteUsed = tr; }
    catch (e) { if (String(e?.message) === "template_not_usable") throw new HttpError(409, "template_not_approved_or_disabled"); throw e; }
  }
  // R37④：mandatory 缺省=按现行映射（等级→mandatory/optional）自动设定；表单显式值=人工改判（审计留 policy_expected）
  let mand = Boolean(body.mandatory); let mandSrc = "manual";
  const mp = await loadMandatePolicy();
  const lvlNow = mp ? await driverLatestLevel(driverId) : null;
  const wants = mp && lvlNow ? String(mp.policy[String(lvlNow)] || "") : "";
  if (body.mandatory === undefined) {
    if (wants === "mandatory" || wants === "optional") { mand = wants === "mandatory"; mandSrc = "policy:v" + mp.config_version + ":" + lvlNow + "=" + wants; }
    else mandSrc = wants ? "manual" : "default_false";
  }
  const at = nowIso();
  const taskId = newId("task");
  await dbRequest("insert_task_row", "POST", "training_tasks", {
    body: [{ task_id: taskId, driver_id: driverId, alert_id: alertIdIn, course_id: courseId, course_snapshot: { ...course, captured_at: at, captured_stage: "assignment", assignment_notice: { text: msg } }, goal: String(body.goal || "").slice(0, 500), mandatory: mand, due_at: String(body.due_at || at), status: "assigned", created_by: user.user_id, idempotency_key: idem, updated_at: at }],
    headers: { Prefer: "return=minimal" },
  });
  const notification = await taskNotification({ task_id: taskId, driver_id: driverId, course_id: courseId, status: "assigned" }, "assigned", msg);
  const auditId = await appendAudit(ctx.principal, "training.assign", "training_task", taskId, null, "assigned", ctx.requestId, null, { mandatory: mand, mandatory_source: mandSrc, policy_expected: wants || null, policy_level: lvlNow || null, template_ref: assignNoteUsed ? { template_id: assignNoteUsed.template_id, key: assignNoteUsed.template_key, version: assignNoteUsed.version } : null });
  sendJson(response, 200, { ok: true, task_id: taskId, audit_id: auditId, mandatory: mand, mandatory_source: mandSrc, course_version: course.version_no, course_snapshot_saved: true, assigned_notification: notification.notification_id, notification, note: "任务已保存；通知以独立回执为准，站内记录不等于已读或外发送达" });
}


// ---------- Section: case lifecycle (alert confirm -> intervention -> driver read/reply -> timeline) ----------
const RULE_VERSION = "queue_rules_v1";
const DUAL_RULE = "dual_signal_priority";
const DATA_RULE = "data_verification";
const ALERT_FSM = { pending_review: ["confirmed", "duplicate", "supplement_data", "closed"], confirmed: ["closed"], closed: [], duplicate: [], supplement_data: ["pending_review"] };

async function fetchQueueEvidence(gpsno, evidenceId, occurredAt) {
  const { data } = await dbRequest("get_alert_evidence", "GET", "review_queue", {
    query: { queue_id: `eq.${evidenceId}`, select: "queue_id,gpsno,safety_score,risk_level,forecast_40d_risk_prob,review_queue,confidence_level,as_of_date,source_version", limit: 1 },
  });
  const q = data?.[0] || null;
  if (q && (q.gpsno !== gpsno || q.as_of_date !== occurredAt)) return { q: null, mismatch: true };
  return { q, mismatch: false };
}

async function handleAlertConfirm(request, response, url, ctx) {
  const user = requireUser(ctx.principal);
  { const body0 = await peekBody(request); await assertInScope(ctx.principal, { gpsno: String(body0.gpsno || "") }); }
  const body = await readBody(request);
  const gpsno = String(body.gpsno || "").slice(0, 40);
  const ruleCode = String(body.rule_code || "");
  const evidenceId = String(body.evidence_id || "").slice(0, 60);
  const occurredAt = String(body.occurred_at || "").slice(0, 20);
  if (!gpsno || !evidenceId || !/^(\d{4}-\d{2}-\d{2})$/.test(occurredAt)) throw new HttpError(400, "bad_request");
  if (![DUAL_RULE, DATA_RULE].includes(ruleCode)) throw new HttpError(400, "unknown_rule_code");
  const ev = await fetchQueueEvidence(gpsno, evidenceId, occurredAt);
  if (!ev.q) throw new HttpError(409, ev.mismatch ? "evidence_mismatch" : "evidence_not_found");
  const drvRow = await dbRequest("get_alert_evidence", "GET", "drivers", { query: { gpsno: `eq.${gpsno}`, select: "driver_id", limit: 1 } });
  const driverId = drvRow.data?.[0]?.driver_id || null;
  // 双信号：预测前20% ∧ 行为等级C/D——判定只读复核，不产生新分值
  if (ruleCode === DUAL_RULE) {
    if (!["C", "D"].includes(String(ev.q.risk_level))) throw new HttpError(409, "rule_dual_behavior_not_CD");
    const tot = await dbRequest("count_risk_rows", "GET", "risk_snapshots", { query: { select: "snapshot_id", limit: 1 }, headers: { Prefer: "count=exact,return=minimal" } });
    const total = parseCount(tot.rangeHeader) ?? 0;
    const rk = await dbRequest("get_alert_evidence", "GET", "risk_snapshots", { query: { gpsno: `eq.${gpsno}`, as_of_date: `eq.${occurredAt}`, select: "risk_rank,risk_prob", limit: 1 } });
    const rrow = rk.data?.[0];
    if (!rrow || !total || Number(rrow.risk_rank) > Math.ceil(total * 0.2)) throw new HttpError(409, "rule_dual_not_top20pct");
  } else {
    if (String(ev.q.confidence_level) !== "low") throw new HttpError(409, "rule_data_low_confidence_required");
  }
  const idem = `${ruleCode}:${gpsno}:${evidenceId}:${occurredAt}`;
  const open = await dbRequest("get_alert_row", "GET", "alerts", {
    query: { idempotency_key: `eq.${idem}`, select: "alert_id,status,gpsno,rule_code,evidence_id,occurred_at,rule_version", limit: 1 },
  });
  if (open.data?.[0] && open.data[0].status !== "closed") {
    await appendAudit(ctx.principal, "alert.confirm.replay", "alert", open.data[0].alert_id, open.data[0].status, open.data[0].status, ctx.requestId);
    return sendJson(response, 200, { ok: true, idempotent_replay: true, ...open.data[0] });
  }
  if (open.data?.[0]?.status === "closed") throw new HttpError(409, "case_closed_reopen_requires_new_alert");
  const alertId = newId("alert");
  const at = nowIso();
  await dbRequest("insert_alert_row", "POST", "alerts", {
    body: [{ alert_id: alertId, gpsno, driver_id: driverId, rule_code: ruleCode, evidence_id: evidenceId, occurred_at: occurredAt,
      status: "pending_review", is_replay: false, replay_session_id: null, idempotency_key: idem, rule_version: RULE_VERSION,
      created_by: user.user_id, updated_at: at, owner_user_id: user.user_id, due_at: null, close_reason: null }],
    headers: { Prefer: "return=minimal" },
  });
  const auditId = await appendAudit(ctx.principal, "alert.confirm", "alert", alertId, null, "pending_review", ctx.requestId);
  sendJson(response, 201, { ok: true, alert_id: alertId, status: "pending_review", rule_code: ruleCode, rule_version: RULE_VERSION, evidence: ev.q, driver_id: driverId, audit_id: auditId, idempotent_replay: false });
}

async function loadAlert(id) {
  const { data } = await dbRequest("get_alert_row", "GET", "alerts", { query: { alert_id: `eq.${id}`, select: "alert_id,gpsno,driver_id,rule_code,rule_version,evidence_id,occurred_at,status,owner_user_id,due_at,close_reason,updated_at" } });
  const a = data?.[0]; if (!a) throw new HttpError(404, "not_found"); return a;
}

async function handleAlertStatus(request, response, url, ctx, alertId) {
  requireUser(ctx.principal);
  await assertInScope(ctx.principal, { alertId });
  const alert = await loadAlert(alertId);
  const body = await readBody(request);
  const next = String(body.status || "");
  if (alert.status === "closed" && next === "closed") return sendJson(response, 200, { ok: true, idempotent_replay: true, alert_id: alertId, status: "closed", close_reason: alert.close_reason }); // 重复关闭返回既有
  const reason = String(body.reason || "").slice(0, 300);
  if (!(ALERT_FSM[alert.status] || []).includes(next)) throw new HttpError(409, `alert_transition_${alert.status}_to_${next}_invalid`);
  if (next === "closed" && !["已完成干预", "证据不成立", "转设备核验", "重复记录"].includes(reason)) throw new HttpError(409, "close_reason_required");
  const at = nowIso();
  await dbRequest("patch_alert_status", "PATCH", "alerts", {
    query: { alert_id: `eq.${alertId}` },
    body: { status: next, close_reason: next === "closed" ? reason : null, updated_at: at },
    headers: { Prefer: "return=minimal" },
  });
  const auditId = await appendAudit(ctx.principal, `alert.${next}`, "alert", alertId, alert.status, next, ctx.requestId);
  sendJson(response, 200, { ok: true, alert_id: alertId, old_status: alert.status, new_status: next, close_reason: next === "closed" ? reason : null, audit_id: auditId });
}

async function handleInterventionDraft(request, response, url, ctx, alertId) {
  requireUser(ctx.principal);
  await assertInScope(ctx.principal, { alertId });
  const alert = await loadAlert(alertId);
  if (alert.status !== "confirmed") throw new HttpError(409, "alert_not_confined_as_confirmed");
  const body = await readBody(request);
  const draft = String(body.draft_text || "").slice(0, 2000);
  if (!draft.trim()) throw new HttpError(400, "bad_request");
  const exists = await dbRequest("get_intervention_row", "GET", "interventions", {
    query: { idempotency_key: `eq.draft:${alertId}`, select: "intervention_id,status,draft_text,alert_id", limit: 1 },
  });
  if (exists.data?.[0]) return sendJson(response, 200, { ok: true, idempotent_replay: true, ...exists.data[0] });
  const idem = body.idempotency_key ? String(body.idempotency_key).slice(0, 120) : `draft:${alertId}`;
  const dup = await dbRequest("get_intervention_row", "GET", "interventions", { query: { idempotency_key: `eq.${idem}`, select: "intervention_id,status", limit: 1 } });
  if (dup.data?.[0]) return sendJson(response, 200, { ok: true, idempotent_replay: true, ...dup.data[0], alert_id: alertId });
  const interventionId = newId("intv");
  const at = nowIso();
  await dbRequest("create_intervention", "POST", "interventions", {
    body: [{ intervention_id: interventionId, alert_id: alertId, driver_id: alert.driver_id, status: "draft", draft_text: draft,
      sent_text: null, sent_at: null, read_at: null, reply_text: null, replied_at: null,
      created_by: ctx.principal.user.user_id, closed_by: null, closed_at: null, idempotency_key: idem, updated_at: at }],
    headers: { Prefer: "return=minimal" },
  });
  const auditId = await appendAudit(ctx.principal, "intervention.draft", "intervention", interventionId, null, "draft", ctx.requestId);
  sendJson(response, 201, { ok: true, intervention_id: interventionId, status: "draft", alert_id: alertId, audit_id: auditId, note: "草稿为人工撰写（当前运行时AI未接通，不标称AI生成）；未确认发送前不构成已送达。" });
}

async function handleDraftEdit(request, response, url, ctx, interventionId) {
  requireUser(ctx.principal, "send.intervention");
  const row = await loadIntervention(interventionId, null);
  await assertInScope(ctx.principal, { driverId: row.driver_id });
  if (row.status !== "draft") throw new HttpError(409, `intervention_state_${row.status}_not_editable`);
  const body = await readBody(request);
  const draft = String(body.draft_text || "").slice(0, 2000);
  if (!draft.trim()) throw new HttpError(400, "bad_request");
  await dbRequest("patch_intervention", "PATCH", "interventions", { query: { intervention_id: `eq.${interventionId}` }, body: { draft_text: draft, updated_at: nowIso() }, headers: { Prefer: "return=minimal" } });
  const auditId = await appendAudit(ctx.principal, "intervention.draft_edit", "intervention", interventionId, "draft", "draft", ctx.requestId);
  sendJson(response, 200, { ok: true, intervention_id: interventionId, status: "draft", audit_id: auditId });
}

async function loadIntervention(id, asDriverId) {
  const q = asDriverId
    ? { intervention_id: `eq.${id}`, driver_id: `eq.${asDriverId}`, select: "intervention_id,alert_id,driver_id,status,draft_text,sent_text,sent_at,read_at,reply_text,replied_at,created_by,updated_at" }
    : { intervention_id: `eq.${id}`, select: "intervention_id,alert_id,driver_id,status,draft_text,sent_text,sent_at,read_at,reply_text,replied_at,created_by,updated_at" };
  const { data } = await dbRequest(asDriverId ? "read_own_intervention" : "get_intervention_row", "GET", "interventions", { query: q });
  const row = data?.[0];
  if (!row) throw new HttpError(404, "not_found"); // 越权与不存在同返回，不泄漏存在性
  return row;
}

async function handleInterventionSend(request, response, url, ctx, interventionId) {
  requireUser(ctx.principal, "send.intervention");
  const row = await loadIntervention(interventionId, null);
  await assertInScope(ctx.principal, { driverId: row.driver_id });
  if (row.status !== "draft") {
    // 双击重复发送：返回既有状态与既有通知，不新增记录
    const n = await dbRequest("get_notification_by_key", "GET", "notification_events", { query: { idempotency_key: `eq.notif:${interventionId}`, select: "notification_id,created_at", limit: 1 } });
    return sendJson(response, 200, { ok: true, idempotent_replay: true, intervention_id: interventionId, status: row.status, sent_at: row.sent_at, notification_id: n.data?.[0]?.notification_id || null });
  }
  const at = nowIso();
  await dbRequest("send_intervention", "PATCH", "interventions", {
    query: { intervention_id: `eq.${interventionId}`, status: "eq.draft" },
    body: { status: "sent", sent_text: row.draft_text, sent_at: at, updated_at: at },
    headers: { Prefer: "return=minimal" },
  });
  // 有效绑定账号才生成站内通知；不声称外部渠道送达
  const acct = await dbRequest("get_binding_target", "GET", "app_users", { query: { driver_id: `eq.${row.driver_id}`, account_status: "eq.active", binding_verified: "eq.true", select: "user_id,display_name", limit: 1 } });
  let notificationId = null;
  if (acct.data?.[0]) {
    const existN = await dbRequest("get_notification_by_key", "GET", "notification_events", { query: { idempotency_key: `eq.notif:${interventionId}`, select: "notification_id", limit: 1 } });
    if (!existN.data?.[0]) {
      notificationId = newId("noti");
      await dbRequest("insert_notification", "POST", "notification_events", {
        body: [{ notification_id: notificationId, target_user_id: acct.data[0].user_id, target_role: "driver", source_entity_type: "intervention", source_entity_id: interventionId, type: "intervention_message", title: "安全沟通消息", body: String(row.draft_text).slice(0, 500), content: String(row.draft_text).slice(0, 500), read_at: null, idempotency_key: `notif:${interventionId}`, created_at: at }],
        headers: { Prefer: "return=minimal" },
      });
    } else notificationId = existN.data[0].notification_id;
  }
  await dbRequest("patch_alert_status", "PATCH", "alerts", { query: { alert_id: `eq.${row.alert_id}`, status: `eq.confirmed` }, body: { status: "confirmed", updated_at: at }, headers: { Prefer: "return=minimal" } }).catch(() => {});
  const auditId = await appendAudit(ctx.principal, "intervention.send", "intervention", interventionId, "draft", "sent", ctx.requestId);
  sendJson(response, 200, { ok: true, intervention_id: interventionId, status: "sent", sent_at: at, notification_id: notificationId, delivered_to_account: Boolean(acct.data?.[0] || notificationId), audit_id: auditId, note: "演示绑定（非真实司机身份核验）；站内通知≠外部渠道送达" });
}

async function handleInterventionRead(request, response, url, ctx, interventionId) {
  const user = requireVerifiedDriver(ctx.principal);
  const row = await loadIntervention(interventionId, user.driver_id);
  if (!["sent", "read", "replied"].includes(row.status)) throw new HttpError(409, "intervention_not_readable_state");
  if (row.read_at) {
    await dbRequest("patch_intervention", "PATCH", "notification_events", {
      query: { source_entity_id: `eq.${interventionId}`, target_user_id: `eq.${user.user_id}`, read_at: "is.null" },
      body: { read_at: row.read_at },
      headers: { Prefer: "return=minimal" },
    }).catch(() => {});
    return sendJson(response, 200, { ok: true, idempotent_replay: true, intervention_id: interventionId, read_at: row.read_at, status: row.status });
  }
  const at = nowIso();
  const changed = await dbRequest("read_own_intervention", "PATCH", "interventions", {
    query: { intervention_id: `eq.${interventionId}`, driver_id: `eq.${user.driver_id}`, status: `eq.${row.status}`, read_at: "is.null" },
    body: { status: row.status === "sent" ? "read" : row.status, read_at: at, updated_at: at },
    headers: { Prefer: "return=representation" },
  });
  if (!changed.data?.length) {
    const current = await loadIntervention(interventionId, user.driver_id);
    if (!current.read_at) throw new HttpError(409, "intervention_version_conflict");
    return sendJson(response, 200, { ok: true, idempotent_replay: true, intervention_id: interventionId, read_at: current.read_at, status: current.status });
  }
  await dbRequest("patch_intervention", "PATCH", "notification_events", {
    query: { source_entity_id: `eq.${interventionId}`, target_user_id: `eq.${user.user_id}`, read_at: "is.null" },
    body: { read_at: at },
    headers: { Prefer: "return=minimal" },
  }).catch(() => {}); // 站内通知与案卷已读同步
  const auditId = await appendAudit(ctx.principal, "intervention.read", "intervention", interventionId, row.status, row.status === "sent" ? "read" : row.status, ctx.requestId);
  sendJson(response, 200, { ok: true, intervention_id: interventionId, read_at: at, audit_id: auditId });
}

async function handleInterventionReply(request, response, url, ctx, interventionId) {
  const user = requireVerifiedDriver(ctx.principal);
  const row = await loadIntervention(interventionId, user.driver_id);
  if (row.status === "replied") return sendJson(response, 200, { ok: true, idempotent_replay: true, intervention_id: interventionId, replied_at: row.replied_at, reply_text: row.reply_text });
  if (!["sent", "read"].includes(row.status)) throw new HttpError(409, "intervention_state_invalid");
  const body = await readBody(request);
  const reply = String(body.reply_text || "").slice(0, 2000);
  if (!reply.trim()) throw new HttpError(400, "bad_request");
  const at = nowIso();
  const changed = await dbRequest("reply_own_intervention", "PATCH", "interventions", {
    query: { intervention_id: `eq.${interventionId}`, driver_id: `eq.${user.driver_id}`, status: `in.(sent,read)` },
    body: { status: "replied", reply_text: reply, replied_at: at, read_at: row.read_at || at, updated_at: at },
    headers: { Prefer: "return=representation" },
  });
  if (!changed.data?.length) {
    const current = await loadIntervention(interventionId, user.driver_id);
    if (current.status !== "replied") throw new HttpError(409, "intervention_version_conflict");
    return sendJson(response, 200, { ok: true, idempotent_replay: true, intervention_id: interventionId, status: current.status, replied_at: current.replied_at, reply_text: current.reply_text });
  }
  const auditId = await appendAudit(ctx.principal, "intervention.reply", "intervention", interventionId, row.status, "replied", ctx.requestId);
  sendJson(response, 200, { ok: true, intervention_id: interventionId, status: "replied", replied_at: at, reply_text: reply, audit_id: auditId });
}

async function handleCaseView(request, response, url, ctx, alertId) {
  const user = requireUser(ctx.principal);
  if (!["safety_admin", "team_leader"].includes(user.role)) throw new HttpError(403, "forbidden");
  const alert = await loadAlert(alertId);
  const [iv, tv] = await Promise.all([
    dbRequest("get_intervention_row", "GET", "interventions", { query: { alert_id: `eq.${alertId}`, select: "intervention_id,status,draft_text,sent_text,sent_at,read_at,reply_text,replied_at,created_by,idempotency_key", order: "updated_at.asc" } }),
    dbRequest("get_alert_evidence", "GET", "training_tasks", { query: { alert_id: `eq.${alertId}`, select: "task_id,course_id,status,driver_id,due_at,submitted_at,reviewed_at", order: "updated_at.asc" } }),
  ]);
  const ids = (iv.data || []).map((x) => x.intervention_id);
  let notes = []; let audits = [];
  if (ids.length) {
    const nres = await dbRequest("get_notification_by_key", "GET", "notification_events", { query: { source_entity_id: `in.(${ids.join(",")})`, select: "notification_id,target_user_id,type,content,read_at,created_at" } });
    notes = nres.data || [];
  }
  const ares = await dbRequest("list_audit", "GET", "audit_logs", {
    query: { entity_id: `in.(${[alertId, ...ids].map((x) => `"${x}"`).join(",")})`, select: "audit_id,actor_id,actor_role,action,entity_type,entity_id,old_status,new_status,detail_json,occurred_at", order: "occurred_at.asc", limit: 60 },
  });
  audits = ares.data || [];
  const driverAcct = await dbRequest("get_binding_target", "GET", "app_users", { query: { driver_id: `eq.${alert.driver_id}`, select: "user_id,binding_verified,display_name", limit: 1 } });
  sendJson(response, 200, { alert, interventions: iv.data || [], trainings: tv.data || [], notifications: notes, timeline: audits, demo_binding: driverAcct.data?.[0] ? { verified: Boolean(driverAcct.data[0].binding_verified), note: "演示映射账号，非真实司机身份核验；站内消息不等于外部渠道送达" } : null });
}

function pathId(rest, prefix) { return decodeURIComponent(rest.slice(prefix.length)).split("/")[0]; }


// ---------- Section: training task state machine (draft gate at assign; FSM server-side) ----------
// assigned -> in_progress -> submitted ->(reviewed|returned|observation|interview); returned -> in_progress/submitted（补充再提交）
// 逾期为展示分支（due_at 到期且未 submitted/reviewed）；非法跳转/越权/重复一律服务端拒绝或返回原ID。
const TASK_EDITABLE = ["assigned", "in_progress", "returned"];
const TASK_FSM_SUBMIT = ["assigned", "in_progress", "returned"];
const TASK_FSM_START = ["assigned", "returned"];
const TASK_FSM_REVIEW = ["submitted"];

function requireVerifiedDriver(principal) {
  const user = requireUser(principal);
  if (user.role !== "driver") throw new HttpError(403, "forbidden");
  if (!user.driver_id) throw new HttpError(409, "binding_required");
  if (!user.binding_verified) throw new HttpError(403, "binding_not_verified");
  return user;
}

const dailyBusinessDate = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const validDailyDate = value => typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;
async function dailyReportStore(method,params={}) {
  if (process.env.IE_LOCAL_SOURCE_ONLY === '1') {
    const target=resolveDbTarget();
    let result;
    try {
      const query=method==='GET'?'?'+new URLSearchParams(params):'';
      result=await fetch(`${target.url}/internal/daily-reports${query}`,{method,headers:{apikey:target.key,'content-type':'application/json'},body:method==='POST'?JSON.stringify(params):undefined});
    } catch { throw new HttpError(503,'daily_report_store_unavailable'); }
    let payload;try{payload=await result.json();}catch{throw new HttpError(503,'daily_report_store_unavailable');}
    if (!result.ok) throw new HttpError(result.status===404?404:result.status===409?409:result.status===400?400:503,payload.code||'daily_report_store_unavailable');
    return payload;
  }
  return hostDailyStore(method, params);
}
// ===== R40 宿主每日简报：与本地 report-store 同协议的 PostgreSQL 实现（引擎模块 server/daily-report/* 两边共用） =====
let dailyPreload=null, dailyPreloadAt=0, dailyPreloadPromise=null;
async function grabAll(op, table, select, order) {
  const out=[];
  for (let off=0; off<60000; off+=2000) {
    const r = await dbRequest(op, "GET", table, { query: { select, order: order || undefined, limit: 2000, offset: off } });
    const rows = r.data || []; out.push(...rows); if (rows.length<2000) break;
  }
  return out;
}
async function dailyFactsStore() {
  if (dailyPreload && Date.now()-dailyPreloadAt < 90000) return dailyPreload;
  if (dailyPreloadPromise) return dailyPreloadPromise;
  dailyPreloadPromise = (async () => {
    const [drivers, history, snapshots, events, courses, ledger] = await Promise.all([
      grabAll("dsr_q","drivers","driver_id,gpsno,fleet_id,mapping_start,mapping_end","driver_id.asc"),
      grabAll("dsr_q","score_history","score_id,driver_id,gpsno,as_of_date,safety_score,risk_level,confidence_level,score_status,score_method,source_version,window_start","score_id.asc"),
      grabAll("dsr_q","score_snapshots","score_id,driver_id,gpsno,as_of_date,safety_score,risk_level,confidence_level,score_status,score_method,source_version,window_start,recommended_action,primary_risk_dimension","score_id.asc"),
      grabAll("dsr_q","replay_events","event_id,gpsno,driver_id,event_time,event_type,event_name,dimension,replay_date,is_replay,source_version","event_id.asc"),
      grabAll("dsr_q","training_courses","course_id,title,dimension,content_status,version_no,source_version,updated_at","course_id.asc"),
      grabAll("dsr_q","deduction_ledger","ledger_id,gpsno,dimension,event_type,event_count,allocated_points,dimension_points,as_of_date,source_version","ledger_id.asc"),
    ]);
    dailyPreload = { drivers, score_history: history, score_snapshots: snapshots, replay_events: events, training_courses: courses, deduction_ledger: ledger };
    dailyPreloadAt = Date.now(); dailyPreloadPromise = null; return dailyPreload;
  })().catch(e => { dailyPreloadPromise = null; throw e; });
  return dailyPreloadPromise;
}
function hostDailyStoreAdapter(data) {
  const map = { drivers: data.drivers, score_history: data.score_history, score_snapshots: data.score_snapshots, replay_events: data.replay_events, training_courses: data.training_courses, deduction_ledger: data.deduction_ledger };
  return { rows: name => map[name] || [], sourceHash: "hosted_postgres" };
}
const dailyParse = row => row ? { id:Number(row.id), reportVersion:Number(row.report_version), publishedAt:row.published_at, report:JSON.parse(row.report_json) } : null;
function dailyReportRows(rows){ return rows.map(row=>({id:Number(row.id),reportDate:row.report_date,reportVersion:Number(row.report_version),isCurrent:row.is_current===true||row.is_current==='true',publishedAt:row.published_at,title:(()=>{try{return JSON.parse(row.report_json).title;}catch{return '';}})()})); }
function dailyGoalRows(rows){ return rows.map(row=>({id:Number(row.id),reportId:Number(row.report_id),previousGoalId:row.previous_goal_id?Number(row.previous_goal_id):null,type:row.goal_type,description:row.goal_text,status:row.status,feedbackCode:row.feedback_code||null,feedbackText:row.feedback_text||null,updatedAt:row.updated_at||null,createdAt:row.created_at})); }
async function previousGoalContextHost(driverId, reportDate) {
  const rs = await dbRequest("dsr_q","GET","daily_safety_reports",{ query:{ driver_id:`eq.${driverId}`, report_date:`lt.${reportDate}`, status:'eq.published', is_current:'eq.true', select:"id,report_date,report_json", order:"report_date.desc", limit:1 } });
  const prev = rs.data?.[0]; if (!prev) return null;
  const g = await dbRequest("dsg_q","GET","driver_safety_goals",{ query:{ report_id:`eq.${prev.id}`, select:"id,status,feedback_code", limit:1 } });
  const goal = g.data?.[0] || null; let parsed = {}; try { parsed = JSON.parse(prev.report_json); } catch {}
  return { id: goal?Number(goal.id):null, reportDate: prev.report_date, status: goal?.status || "active", feedbackCode: goal?.feedback_code || null,
    scoreEvidenceId: parsed?.metrics?.scoreEvidenceId || null, eventType: parsed?.risks?.[0]?.eventType || null, evidenceRefs: parsed?.risks?.[0]?.evidenceRefs || [] };
}
const DAILY_NARRATIVE_PROMPT_VERSION = sha256hex("daily-report-personalizer-v1").slice(0, 12);
function dailyGreeting() { const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(new Date())); return h < 5 ? '凌晨好' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好'; }
async function dailyNarrate(report, snapshot, actorHint) {
  const allow = allowedNumberStrings(report, snapshot);
  const hint = { greeting: dailyGreeting(), feedbackCode: report.goalTracking?.previousFeedbackCode || null };
  let repair = null; const diag = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    let narrative = null;
    try {
      const j = await aiUpstream({ model: aiModel(), messages: personalizerMessages(report, snapshot, hint, repair), temperature: 0.4, max_tokens: 1100 });
      const content = String(j?.choices?.[0]?.message?.content || '').trim().replace(/^```(json)?/i, '').replace(/```$/i, '').trim();
      narrative = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
    } catch (e) { diag.push('parse_or_call:' + String((e && e.code) || e?.message || 'network').slice(0, 60)); repair = '上一稿无效 JSON/调用失败。只输出纯 JSON。'; continue; }
    const verdict = verifyNarrative(narrative, report, allow);
    if (verdict.ok) return { narrative, meta: { generatedBy: 'ai', model: aiModel(), prompt_version: DAILY_NARRATIVE_PROMPT_VERSION, attempts: attempt + 1, ai_status: attempt ? 'ok_after_repair' : 'ok', ...actorHint }, allowSize: allow.size };
    diag.push('verify:' + verdict.errors.slice(0, 8).join('|'));
    if (verdict.errors.some(x => String(x).startsWith('number:'))) diag.push('sample:' + JSON.stringify(narrative).slice(0, 240));
    repair = '数字/证据/措辞校验失败：' + verdict.errors.slice(0, 6).join('、') + '。数字只能用输入中出现过的原值，禁止百分比与实时措辞，证据引用必须原样来自 facts。';
  }
  return { narrative: null, meta: { generatedBy: 'fallback_template', model: aiModel(), prompt_version: DAILY_NARRATIVE_PROMPT_VERSION, ai_status: 'fallback_template', diag, ...actorHint } };
}
async function generateDailyReportCore(driverId, reportDate) {
  const data = await dailyFactsStore();
  const store = hostDailyStoreAdapter(data);
  const asOf = new Date(Date.parse(reportDate+'T00:00:00Z')-86400000).toISOString().slice(0,10);
  const facts = readDriverFacts(store, driverId, asOf);
  const snapshot = { ...computeDriverSnapshot(facts), previousGoal: await previousGoalContextHost(driverId, reportDate) };
  return validateDailySafetyReport(organizeDailyReport(snapshot, reportDate), snapshot);
}
async function hostPublishDailyReport({driverId,reportDate,actorId,actorRole='safety_admin',revise=false,jobClaim=null}) {
  const report = await generateDailyReportCore(driverId, reportDate); // 确定性核心：不调模型
  const finishJob = async () => { if (jobClaim) { try { await dbRequest("drj_u","PATCH","daily_report_jobs",{ query:{ id:`eq.${jobClaim.id}`, lease_token:`eq.${jobClaim.leaseToken}` }, body:{ status:'succeeded', finished_at: nowIso(), lease_token:null, lease_until:null, next_at:0, error_message:null }, headers:{ Prefer:'return=minimal' } }); } catch {} } };
  const cur = await dbRequest("dsr_q","GET","daily_safety_reports",{ query:{ driver_id:`eq.${driverId}`, report_date:`eq.${reportDate}`, is_current:'eq.true', status:'eq.published', select:"id,report_version,report_json,published_at,source_fingerprint,is_current", limit:1 } });
  const current = cur.data?.[0] || null;
  if (current && current.source_fingerprint === report.sourceFingerprint) { await finishJob(); return { ...dailyParse({ ...current, report_version:current.report_version }), idempotentReplay:true, notificationCount:0 }; }
  if (current && !revise) throw new HttpError(409, "report_revision_required");
  if (aiAvailable()) { // 仅确需发布新版本时才调用模型（幂等/409 路径零模型消耗）；数字/证据/措辞三重守门，不过关回落规则模板并在 meta 如实标注
    try { const { narrative, meta } = await dailyNarrate(report, null, {}); if (narrative) report.narrative = narrative; report.narrativeMeta = meta; }
    catch (e) { report.narrativeMeta = { generatedBy: 'fallback_template', ai_status: 'fallback_error', reason: String((e && e.code) || e?.message || 'e').slice(0, 60) }; }
  }
  const maxv = await dbRequest("dsr_q","GET","daily_safety_reports",{ query:{ driver_id:`eq.${driverId}`, report_date:`eq.${reportDate}`, select:"report_version", order:"report_version.desc", limit:1 } });
  const version = (Number(maxv.data?.[0]?.report_version) || 0) + 1;
  const at = nowIso();
  if (current) { const flip = await dbRequest("dsr_u","PATCH","daily_safety_reports",{ query:{ id:`eq.${current.id}`, is_current:'eq.true' }, body:{ is_current:false }, headers:{ Prefer:'return=minimal' } }); if (flip.status && flip.status>=400) throw new HttpError(409,"report_revision_conflict"); }
  const ins = await dbRequest("dsr_i","POST","daily_safety_reports",{ body:[{ driver_id:driverId, report_date:reportDate, report_version:version, status:'published', is_current:true, data_as_of:report.dataAsOf, source_fingerprint:report.sourceFingerprint, report_json:JSON.stringify(report), published_at:at }], headers:{ Prefer:'return=representation' } }).catch(async e => {
    if (e instanceof HttpError && (e.status===409||String(e.code).includes('duplicate'))) { const re = await dbRequest("dsr_q","GET","daily_safety_reports",{ query:{ driver_id:`eq.${driverId}`, report_date:`eq.${reportDate}`, is_current:'eq.true', select:"id,report_version,report_json,published_at", limit:1 } }); if (re.data?.[0]) { await finishJob(); return { __replay: re.data[0] }; } }
    throw e;
  });
  if (ins?.__replay) return { ...dailyParse(ins.__replay), idempotentReplay:true, notificationCount:0 };
  const inserted = ins.data?.[0] || null;
  const reportId = inserted ? Number(inserted.id) : (await dbRequest("dsr_q","GET","daily_safety_reports",{ query:{ driver_id:`eq.${driverId}`, report_date:`eq.${reportDate}`, report_version:`eq.${version}`, select:"id", limit:1 } })).data?.[0]?.id;
  const reportView = { id:reportId, reportVersion:version, publishedAt:at, report };
  if (report.dailyGoal) {
    const exg = await dbRequest("dsg_q","GET","driver_safety_goals",{ query:{ report_id:`eq.${reportId}`, select:"id", limit:1 } });
    if (!exg.data?.length) await dbRequest("dsg_i","POST","driver_safety_goals",{ body:[{ driver_id:driverId, report_id:reportId, previous_goal_id:report.goalTracking?.previousGoalId || null, goal_type:report.dailyGoal.type, goal_text:report.dailyGoal.description, status:'active', created_at:at }], headers:{ Prefer:'resolution=ignore,return=minimal' } }).catch(()=>{});
  }
  const recips = (await dbRequest("dau_q","GET","app_users",{ query:{ driver_id:`eq.${driverId}`, role:'eq.driver', account_status:'eq.active', binding_verified:'eq.true', select:"user_id", limit:10 } })).data || [];
  let notes = 0;
  for (const acct of recips) { try { await notify(acct.user_id, "daily_report_ready", String(reportId), `${reportDate} 的历史安全简报已可查看。`, `daily_report_ready:${driverId}:${reportDate}:${version}:${acct.user_id}`, "daily_safety_report", "每日安全简报已生成"); notes++; } catch {} }
  await appendAudit({ user:{ user_id:actorId, role:actorRole } }, "daily_report.publish", "daily_safety_report", String(reportId), current?"published":null, "published", null, [], { driver_id:driverId, report_date:reportDate, report_version:version, source_fingerprint:report.sourceFingerprint });
  await finishJob();
  return { ...reportView, idempotentReplay:false, notificationCount:notes };
}
async function hostListJobs({date,limit,offset,fleetId,status}) {
  const q = { report_date:`eq.${date}`, select:"id,driver_id,report_date,status,attempts,started_at,finished_at,error_message", order:"id.asc", limit:Number(limit)||50, offset:Number(offset)||0 };
  if (status) q.status = `eq.${status}`;
  const sumQ = { report_date:`eq.${date}`, select:"id,status,driver_id", order:"id.asc", limit:2000 };
  const [page, all] = await Promise.all([
    dbRequest("drj_q","GET","daily_report_jobs",{ query:q }),
    dbRequest("drj_q","GET","daily_report_jobs",{ query:sumQ }),
  ]);
  let rows = (all.data||[]);
  if (fleetId && fleetId !== "*") { const data = await dailyFactsStore(); const inFleet = new Set(data.drivers.filter(d=>String(d.fleet_id)===String(fleetId)).map(d=>String(d.driver_id))); rows = rows.filter(r=>inFleet.has(String(r.driver_id))); }
  const byStatus = {}; for (const r of rows) byStatus[r.status]=(byStatus[r.status]||0)+1;
  const pageRows = status ? rows.slice(Number(offset)||0,(Number(offset)||0)+(Number(limit)||50)) : (page.data||[]).slice(0, Number(limit)||50);
  return { date, total: rows.length, byStatus, rows: pageRows.map(r=>({ id:Number(r.id), driver_id:r.driver_id, report_date:r.report_date, status:r.status, attempts:Number(r.attempts)||0, started_at:r.started_at||null, finished_at:r.finished_at||null, error_message:r.error_message||null })), limit:Number(limit)||50, offset:Number(offset)||0 };
}
async function hostDailyStore(method, params={}) {
  if (method==='POST' && params.action==='publish') return hostPublishDailyReport({ driverId: String(params.driverId||''), reportDate: params.reportDate, actorId: String(params.actorId||''), revise: params.revise===true });
  if (method==='POST' && params.action==='feedback') {
    const gid = Number(params.goalId); if (!Number.isSafeInteger(gid)||gid<1) throw new HttpError(400,"invalid_goal_id");
    const code = String(params.code||''), text = String(params.text??'').slice(0,500);
    if (!['will_review','need_help','dismissed'].includes(code)) throw new HttpError(400,"invalid_goal_feedback");
    const row = (await dbRequest("dsg_q","GET","driver_safety_goals",{ query:{ id:`eq.${gid}`, driver_id:`eq.${params.driverId}`, select:"id,status,feedback_code,feedback_text,updated_at", limit:1 } })).data?.[0];
    if (!row) throw new HttpError(404,"not_found");
    if (row.feedback_code===code && (row.feedback_text||'')===text) return { id:gid, status:row.status, feedbackCode:code, updatedAt:row.updated_at, idempotentReplay:true };
    const at = nowIso(), status = code==='dismissed' ? 'dismissed' : 'active';
    await dbRequest("dsg_u","PATCH","driver_safety_goals",{ query:{ id:`eq.${gid}`, driver_id:`eq.${params.driverId}` }, body:{ status, feedback_code:code, feedback_text:text, updated_at:at }, headers:{ Prefer:'return=minimal' } });
    await appendAudit({ user:{ user_id:String(params.actorId||params.driverId), role:'driver' } }, "daily_goal.feedback", "driver_safety_goal", String(gid), row.status, status, null, [], { feedback_code:code });
    return { id:gid, status, feedbackCode:code, updatedAt:at, idempotentReplay:false };
  }
  if (method==='GET') {
    const kind = params.kind;
    if (kind==='jobs') return hostListJobs({ date:params.date, limit:params.limit, offset:params.offset, fleetId:params.fleet_id, status:params.status });
    const driverId = String(params.driver_id||'');
    if (!/^([\w.-]{1,100})$/.test(driverId)) throw new HttpError(400,"invalid_driver_id");
    if (kind==='today') { const row = (await dbRequest("dsr_q","GET","daily_safety_reports",{ query:{ driver_id:`eq.${driverId}`, report_date:`eq.${params.date}`, is_current:'eq.true', status:'eq.published', select:"id,report_version,report_json,published_at", limit:1 } })).data?.[0]; if (!row) throw new HttpError(404,"not_found"); return dailyParse(row); }
    if (kind==='detail') { const row = (await dbRequest("dsr_q","GET","daily_safety_reports",{ query:{ id:`eq.${params.id}`, driver_id:`eq.${driverId}`, status:'eq.published', select:"id,report_version,report_json,published_at", limit:1 } })).data?.[0]; if (!row) throw new HttpError(404,"not_found"); return dailyParse(row); }
    if (kind==='history') {
      const limit = Math.min(Math.max(Number(params.limit)||20,1),50), offset = Math.max(Number(params.offset)||0,0);
      const r = await dbRequest("dsr_q","GET","daily_safety_reports",{ query:{ driver_id:`eq.${driverId}`, status:'eq.published', select:"id,report_date,report_version,is_current,published_at,report_json", order:"report_date.desc,report_version.desc", limit, offset }, headers:{ Prefer:"count=exact" } });
      return { rows: dailyReportRows(r.data||[]), total: (r.rangeHeader ? Number(String(r.rangeHeader).split('/')[1]) : (r.data||[]).length) || (r.data||[]).length, limit, offset };
    }
    if (kind==='goals') { const rows = (await dbRequest("dsg_q","GET","driver_safety_goals",{ query:{ driver_id:`eq.${driverId}`, select:"id,report_id,previous_goal_id,goal_type,goal_text,status,feedback_code,feedback_text,updated_at,created_at", order:"created_at.desc,id.desc", limit:100 } })).data||[]; return { rows: dailyGoalRows(rows) }; }
    if (kind==='notifications') {
      const reports = (await dbRequest("dsr_q","GET","daily_safety_reports",{ query:{ driver_id:`eq.${driverId}`, status:'eq.published', select:"id", order:"id.desc", limit:100 } })).data||[];
      const ids = new Set(reports.map(x=>String(x.id)));
      const rows = (await dbRequest("dne_q","GET","notification_events",{ query:{ target_user_id:`eq.${params.user_id}`, type:'eq.daily_report_ready', select:"notification_id,source_entity_type,source_entity_id,type,title,content,created_at,read_at", order:"created_at.desc", limit:50 } })).data||[];
      return { rows: rows.filter(r=>r.source_entity_type==='daily_safety_report' && ids.has(String(r.source_entity_id))).map(r=>({ notification_id:r.notification_id, source_entity_id:r.source_entity_id, type:r.type, title:r.title||'每日安全简报已生成', content:r.content, created_at:r.created_at, read_at:r.read_at||null })) };
    }
  }
  throw new HttpError(400,"invalid_daily_report_request");
}
const dailyLazyAt=new Map();
let dailyTickBusy=false;
const dailyPublishDue = () => { const hm=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date()); return hm >= (process.env.IE_DAILY_REPORT_AT || "07:00"); };
async function ensureDailyJobsForDate(date, driverIds) {
  for (const id of driverIds) { if (!id) continue;
    const ex = await dbRequest("drj_q","GET","daily_report_jobs",{ query:{ driver_id:`eq.${id}`, report_date:`eq.${date}`, select:"id", limit:1 } });
    if (!ex.data?.length) { try { await dbRequest("drj_i","POST","daily_report_jobs",{ body:[{ driver_id:id, report_date:date, status:'pending', attempts:0, next_at:0 }], headers:{ Prefer:'resolution=ignore,return=minimal' } }); } catch {} }
  }
}
async function dailyTick(force=false) {
  if (process.env.IE_LOCAL_SOURCE_ONLY==='1') return; // 本地工作台由自身 scheduler 驱动
  if (dailyTickBusy) return; if (!force && !dailyPublishDue()) return; dailyTickBusy=true;
  try {
    const date=dailyBusinessDate();
    const accts=(await dbRequest("dau_q","GET","app_users",{ query:{ role:'eq.driver', account_status:'eq.active', binding_verified:'eq.true', driver_id:'not.is.null', select:"driver_id", limit:500 } })).data||[];
    const targets=[...new Set(accts.map(x=>x.driver_id).filter(Boolean))];
    await ensureDailyJobsForDate(date, targets);
    const stale=(await dbRequest("drj_q","GET","daily_report_jobs",{ query:{ report_date:'eq.'+date, status:'eq.running', select:"id,lease_until", limit:200 } })).data||[];
    for (const j of stale) { if (Number(j.lease_until) && Number(j.lease_until) < Date.now()-30000) { await dbRequest("drj_u","PATCH","daily_report_jobs",{ query:{ id:'eq.'+j.id, status:'eq.running' }, body:{ status:'pending', lease_token:null, lease_until:null, next_at:Date.now()+60000 }, headers:{ Prefer:'return=minimal' } }).catch(()=>{}); } }
    const pend=(await dbRequest("drj_q","GET","daily_report_jobs",{ query:{ report_date:'eq.'+date, status:'eq.pending', next_at:'lte.'+Date.now(), select:"id,driver_id,report_date,attempts", order:"id.asc", limit:25 } })).data||[];
    const leaseTok=newId('lease');
    for (const j of pend) {
      if (Number(j.attempts)>=5) { await dbRequest("drj_u","PATCH","daily_report_jobs",{ query:{ id:'eq.'+j.id, status:'eq.pending' }, body:{ status:'failed', error_message:'max_attempts', finished_at:nowIso() }, headers:{ Prefer:'return=minimal' } }).catch(()=>{}); continue; }
      const cl=await dbRequest("drj_u","PATCH","daily_report_jobs",{ query:{ id:'eq.'+j.id, status:'eq.pending', attempts:'eq.'+j.attempts }, body:{ status:'running', attempts:Number(j.attempts)+1, lease_token:leaseTok, lease_until:Date.now()+600000, started_at:nowIso(), next_at:0, error_message:null }, headers:{ Prefer:'return=representation' } });
      if (!cl.data?.length) continue;
      try { await hostPublishDailyReport({ driverId:j.driver_id, reportDate:j.report_date, actorId:'system:scheduler', actorRole:'system', revise:false, jobClaim:{ id:j.id, leaseToken:leaseTok } }); }
      catch (e) { const code=String(e?.code||e?.message||'publish_error').slice(0,80);
        const terminal = code==='report_revision_required' || code==='driver_not_found_or_ambiguous' || code==='not_found';
        await dbRequest("drj_u","PATCH","daily_report_jobs",{ query:{ id:'eq.'+j.id, lease_token:'eq.'+leaseTok }, body: terminal ? { status:'failed', error_message:code, finished_at:nowIso(), lease_token:null, lease_until:null, next_at:0 } : { status:'pending', error_message:code, lease_token:null, lease_until:null, next_at:Date.now()+300000*(Number(j.attempts)+1) }, headers:{ Prefer:'return=minimal' } }).catch(()=>{});
      }
    }
  } catch (e) { console.error("daily_tick_error", String(e?.code||e).slice(0,120)); } finally { dailyTickBusy=false; }
}

async function handleDailyReportRun(request,response,url,ctx) {
  const user=requireUser(ctx.principal);
  if (user.role!=='safety_admin') throw new HttpError(403,'forbidden');
  const body=await readBody(request);
  const driverId=String(body.driver_id||'');
  const reportDate=body.report_date||dailyBusinessDate();
  if (!/^[\w.-]{1,100}$/.test(driverId)||!validDailyDate(reportDate)||reportDate>dailyBusinessDate()||typeof body.revise!=='undefined'&&typeof body.revise!=='boolean') throw new HttpError(400,'invalid_daily_report_request');
  const driver=(await dbRequest('list_resource','GET','drivers',{query:{driver_id:`eq.${driverId}`,select:'driver_id,fleet_id',limit:1}})).data?.[0];
  if (!driver) throw new HttpError(404,'not_found');
  await assertInScope(ctx.principal,{driverId});
  sendJson(response,200,await dailyReportStore('POST',{action:'publish',driverId,reportDate,actorId:user.user_id,revise:body.revise===true}));
}
async function handleDailyReportJobs(request,response,url,ctx) {
  const user=requireUser(ctx.principal);
  if(user.role!=='safety_admin') throw new HttpError(403,'forbidden');
  const date=url.searchParams.get('date')||dailyBusinessDate(),limit=url.searchParams.get('limit')||'50',offset=url.searchParams.get('offset')||'0',status=url.searchParams.get('status');
  if(!validDailyDate(date)||date>dailyBusinessDate()||!/^[1-9]\d*$/.test(limit)||Number(limit)>100||!/^\d+$/.test(offset)||!Number.isSafeInteger(Number(offset))||status!==null&&!['pending','running','succeeded','failed'].includes(status)) throw new HttpError(400,'invalid_job_query');
  const fleetId=String(user.fleet_scope||'*');
  sendJson(response,200,await dailyReportStore('GET',{kind:'jobs',date,limit,offset,...(status?{status}:{}),...(fleetId==='*'?{}:{fleet_id:fleetId})}));
}
async function handleDailyReportToday(request,response,url,ctx) {
  const user=requireVerifiedDriver(ctx.principal);
  const date=dailyBusinessDate();
  let report=null;
  try{report=await dailyReportStore('GET',{kind:'today',driver_id:user.driver_id,date});}catch(error){if(!(error instanceof HttpError&&error.status===404))throw error;}
  if (!report && process.env.IE_LOCAL_SOURCE_ONLY!=='1' && dailyPublishDue()) { // 宿主惰性补偿：到点后首次访问即生成（每司机+日期 30s 节流；无人访问/实例冷启动时由定时器补）
    const key=user.driver_id+":"+date; const last=dailyLazyAt.get(key)||0;
    if (Date.now()-last>30000) { dailyLazyAt.set(key,Date.now());
      try { await ensureDailyJobsForDate(date, [user.driver_id]); await hostPublishDailyReport({driverId:user.driver_id,reportDate:date,actorId:'system:scheduler',actorRole:'system',revise:false});
        await dbRequest("drj_u","PATCH","daily_report_jobs",{ query:{ driver_id:`eq.${user.driver_id}`, report_date:`eq.${date}`, status:'in.(pending,running)' }, body:{ status:'succeeded', finished_at:nowIso(), error_message:null }, headers:{ Prefer:'return=minimal' } }).catch(()=>{}); report=(await dbRequest("dsr_q","GET","daily_safety_reports",{ query:{ driver_id:`eq.${user.driver_id}`, report_date:`eq.${date}`, is_current:'eq.true', status:'eq.published', select:"id,report_version,report_json,published_at", limit:1 } })).data?.[0]||null; if(report) report=dailyParse(report); } catch (e) { if (!(e instanceof HttpError && ["report_revision_required"].includes(e.code))) console.error("daily_lazy_error", user.driver_id, String(e?.code||e).slice(0,60)); }
    }
  }
  sendJson(response,200,report);
}
async function handleDailyReportHistory(request,response,url,ctx) {
  const user=requireVerifiedDriver(ctx.principal);
  const limit=url.searchParams.get('limit')||'20',offset=url.searchParams.get('offset')||'0';
  if (!/^\d+$/.test(limit)||Number(limit)<1||Number(limit)>50||!/^\d+$/.test(offset)||!Number.isSafeInteger(Number(offset))) throw new HttpError(400,'invalid_pagination');
  sendJson(response,200,await dailyReportStore('GET',{kind:'history',driver_id:user.driver_id,limit,offset}));
}
async function handleDailyReportDetail(request,response,url,ctx) {
  const user=requireVerifiedDriver(ctx.principal),id=url.pathname.slice('/api/driver/reports/'.length);
  if (!/^[1-9]\d*$/.test(id)||!Number.isSafeInteger(Number(id))) throw new HttpError(404,'not_found');
  sendJson(response,200,await dailyReportStore('GET',{kind:'detail',driver_id:user.driver_id,id}));
}
async function handleDailySafetyGoals(request,response,url,ctx) {
  const user=requireVerifiedDriver(ctx.principal);
  sendJson(response,200,await dailyReportStore('GET',{kind:'goals',driver_id:user.driver_id}));
}
async function handleDailyGoalFeedback(request,response,url,ctx) {
  const user=requireVerifiedDriver(ctx.principal),match=/^\/api\/driver\/safety-goals\/([1-9]\d*)\/feedback$/.exec(url.pathname);
  if (!match||!Number.isSafeInteger(Number(match[1]))) throw new HttpError(404,'not_found');
  const body=await readBody(request);
  if (!['will_review','need_help','dismissed'].includes(body.code)||typeof (body.text??'')!=='string'||(body.text??'').length>500) throw new HttpError(400,'invalid_goal_feedback');
  sendJson(response,200,await dailyReportStore('POST',{action:'feedback',driverId:user.driver_id,actorId:user.user_id,goalId:Number(match[1]),code:body.code,text:body.text??''}));
}
async function handleDailyReportNotifications(request,response,url,ctx) {
  const user=requireVerifiedDriver(ctx.principal);
  sendJson(response,200,await dailyReportStore('GET',{kind:'notifications',driver_id:user.driver_id,user_id:user.user_id}));
}

const driverProjectionRead = (table, query) => dbRequest("list_resource", "GET", table, { query, headers: { Prefer: "count=exact" } });
const projectionFail = (status, code) => { throw new HttpError(status, code); };
async function handleDriverActionCenter(request, response, url, ctx) {
  const user = requireVerifiedDriver(ctx.principal);
  sendJson(response, 200, await actionCenter({ driverId: user.driver_id, read: driverProjectionRead, fail: projectionFail, params: url.searchParams }));
}
async function handleDriverScoreComparison(request, response, url, ctx) {
  const user = requireVerifiedDriver(ctx.principal);
  sendJson(response, 200, await scoreComparison({ driverId: user.driver_id, read: driverProjectionRead, fail: projectionFail, params: url.searchParams }));
}
async function handleDriverInterventionView(request, response, url, ctx) {
  const user = requireVerifiedDriver(ctx.principal), id = url.searchParams.get("id") || "";
  if (!/^[\w:.,-]{1,100}$/.test(id)) throw new HttpError(400, "invalid_intervention_id");
  const row = await loadIntervention(id, user.driver_id);
  if (!["sent", "read", "replied", "closed"].includes(row.status) || !row.sent_at) throw new HttpError(404, "not_found");
  let alert = null;
  if (row.alert_id) alert = (await dbRequest("list_resource", "GET", "alerts", { query: { alert_id: `eq.${row.alert_id}`, driver_id: `eq.${user.driver_id}`, select: "alert_id", limit: 1 } })).data?.[0] || null;
  const safe = Object.fromEntries(["intervention_id", "sent_text", "sent_at", "read_at", "reply_text", "replied_at", "status"].map(k => [k, row[k] ?? null]));
  sendJson(response, 200, { ...safe, alert_id: alert?.alert_id || null });
}

async function handleDriverRiskCenter(request, response, url, ctx) {
  const user = requireVerifiedDriver(ctx.principal);
  const date = url.searchParams.get("date") || new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new HttpError(400, "invalid_date");
  const pageNumber = (key, fallback, max) => {
    const raw = url.searchParams.get(key);
    if (raw === null) return fallback;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > max) throw new HttpError(400, "invalid_pagination");
    return Number(raw);
  };
  const limit = pageNumber("limit", 100, 100);
  if (limit < 1) throw new HttpError(400, "invalid_pagination");
  const eventsOffset = pageNumber("events_offset", 0, 1000000), alertsOffset = pageNumber("alerts_offset", 0, 1000000);
  const start = new Date(date + "T00:00:00+08:00");
  const end = new Date(start.getTime() + 86400000);
  const [events, alerts, score, latest] = await Promise.all([
    dbRequest("list_resource", "GET", "replay_events", { query: { driver_id: `eq.${user.driver_id}`, replay_date: `eq.${date}`, select: "event_id,event_time,event_type,event_name,speed_kmh,dimension,replay_date,is_replay,source_version", order: "event_time.asc,event_id.asc", limit: limit + 1, offset: eventsOffset } }),
    dbRequest("list_resource", "GET", "alerts", { query: { driver_id: `eq.${user.driver_id}`, and: `(occurred_at.gte.${start.toISOString()},occurred_at.lt.${end.toISOString()})`, select: "alert_id,rule_code,evidence_id,occurred_at,status,is_replay", order: "occurred_at.desc,alert_id.desc", limit: limit + 1, offset: alertsOffset } }),
    listResource(ctx.principal, "my.score", new URL("http://local/?limit=1")),
    dbRequest("list_resource", "GET", "replay_events", { query: { driver_id: `eq.${user.driver_id}`, select: "replay_date", order: "replay_date.desc", limit: 1 } }),
  ]);
  const rows = events.data || [], ars = alerts.data || [];
  sendJson(response, 200, { date, timezone: "Asia/Shanghai", source_type: "replay", queried_at: nowIso(), latest_replay_date: latest.data?.[0]?.replay_date || null, snapshot: score.rows[0] || null, events: rows.slice(0, limit), alerts: ars.slice(0, limit), pagination: { limit, events_offset: eventsOffset, alerts_offset: alertsOffset, events_has_more: rows.length > limit, alerts_has_more: ars.length > limit }, truncated: rows.length > limit || ars.length > limit, note: "历史回放记录与人工告警分开展示；预测是未来40天概率，不是当天事故事实。无记录不等于零风险。" });
}

async function handleDriverEvidence(request, response, url, ctx) {
  const user = requireVerifiedDriver(ctx.principal);
  const kind = url.searchParams.get("kind"), id = url.searchParams.get("id") || "";
  const definitions = {
    event: ["replay_events", "event_id", "event_id,event_time,event_type,event_name,speed_kmh,dimension,replay_date,is_replay,source_version"],
    alert: ["alerts", "alert_id", "alert_id,gpsno,rule_code,evidence_id,occurred_at,status,is_replay"],
    score: ["score_snapshots", "score_id", "score_id,gpsno,safety_score,risk_level,as_of_date,window_start,confidence_level,source_version,primary_risk_dimension,history_contribution,fatigue_distraction_contribution,driving_stability_contribution,road_rule_contribution,management_contribution,imu_evidence_contribution"],
    score_history: ["score_history", "score_id", "score_id,gpsno,safety_score,risk_level,as_of_date,confidence_level,source_version,history_contribution,fatigue_distraction_contribution,driving_stability_contribution,road_rule_contribution,management_contribution,imu_evidence_contribution"],
  };
  const def = Object.hasOwn(definitions, kind) ? definitions[kind] : null;
  const rawOffset = url.searchParams.get("offset") || "0";
  if (!def || !/^[\w:.,-]{1,100}$/.test(id) || !/^\d+$/.test(rawOffset) || Number(rawOffset) > 1000000) throw new HttpError(400, "invalid_evidence_request");
  const offset = Number(rawOffset);
  const r = await dbRequest("list_resource", "GET", def[0], { query: { [def[1]]: `eq.${id}`, driver_id: `eq.${user.driver_id}`, select: def[2], limit: 1 } });
  const record = r.data?.[0];
  if (!record) throw new HttpError(404, "not_found");
  let linked = null, linkedKind = null, ledger = [], ledgerStatus = "not_applicable", hasMore = false;
  if (kind === "alert" && record.evidence_id) {
    const queueSource = [DUAL_RULE, DATA_RULE].includes(record.rule_code);
    const ev = queueSource ? { data: [] } : await dbRequest("list_resource", "GET", "replay_events", { query: { event_id: `eq.${record.evidence_id}`, driver_id: `eq.${user.driver_id}`, select: definitions.event[2], limit: 1 } });
    linked = ev.data?.[0] || null; linkedKind = linked ? "event" : null;
    // Queue evidence is shown only through an owned alert and its exact vehicle/date, never arbitrary IDs.
    if (queueSource && record.gpsno && record.occurred_at) {
      const day = /^\d{4}-\d{2}-\d{2}$/.test(record.occurred_at) ? record.occurred_at : Number.isFinite(Date.parse(record.occurred_at)) ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(record.occurred_at)) : null;
      if (day) {
        const q = await dbRequest("list_resource", "GET", "review_queue", { query: { queue_id: `eq.${record.evidence_id}`, gpsno: `eq.${record.gpsno}`, as_of_date: `eq.${day}`, select: "queue_id,as_of_date,safety_score,risk_level,forecast_40d_risk_prob,confidence_level,source_version", limit: 1 } });
        linked = q.data?.[0] || null; linkedKind = linked ? "queue" : null;
      }
    }
  }
  if (["score", "score_history"].includes(kind)) {
    ledgerStatus = "unavailable";
    if (record.gpsno && record.as_of_date) {
      const ls = await dbRequest("list_resource", "GET", "deduction_ledger", { query: { gpsno: `eq.${record.gpsno}`, as_of_date: `eq.${record.as_of_date}`, select: "ledger_id,event_type,dimension,event_count,allocated_points,dimension_points,allocation_rule,as_of_date,source_version", order: "ledger_id.asc", offset, limit: 21 } });
      ledger = (ls.data || []).slice(0, 20); hasMore = (ls.data || []).length > 20;
      ledgerStatus = ledger.length ? "available" : "no_records";
    }
  }
  // Vehicle keys are used internally for authorization, not exposed as a general lookup capability.
  const { gpsno, ...safeRecord } = record;
  sendJson(response, 200, { kind, record: safeRecord, linked, linked_kind: linkedKind, ledger, ledger_status: ledgerStatus, offset, has_more: hasMore, queried_at: nowIso(), limitations: "只展示本人记录及其精确关联。台账为该评价日期的扣分分摊，不是单事件因果解释；来源版本可能不同，未核验时不能据此重算历史评分。无台账不等于零风险。" });
}

// Compare-and-set: only a successful transition may audit/notify. Stale drafts cannot overwrite a submission.
async function patchTaskExpected(row, patch) {
  const at = new Date(Math.max(Date.now(), (Date.parse(row.updated_at) || 0) + 1)).toISOString();
  const result = await dbRequest("patch_task_row", "PATCH", "training_tasks", {
    query: { task_id: `eq.${row.task_id}`, status: `eq.${row.status}`, updated_at: row.updated_at ? `eq.${row.updated_at}` : "is.null", select: "task_id,updated_at" },
    body: { ...patch, updated_at: at }, headers: { Prefer: "return=representation" },
  });
  if (!result.data?.length) throw new HttpError(409, "task_version_conflict");
  return result.data[0].updated_at || at;
}

function checkTaskClientVersion(row, body) {
  if (Object.hasOwn(body, "expected_updated_at") && body.expected_updated_at !== (row.updated_at || null)) throw new HttpError(409, "task_version_conflict");
}


async function taskLearning(row) {
  try {
    const r = await dbRequest("task_learning_get", "GET", "training_tasks", { query: { task_id: `eq.${row.task_id}`, select: "course_snapshot", limit: 1 } });
    return { available: true, ...(r.data?.[0] || {}) };
  } catch (e) {
    // Only an absent-column response is a migration gap; outages must stay visible.
    if (e instanceof HttpError && e.code === "learning_migration_required") return { available: false };
    throw e;
  }
}

async function loadTask(id, asDriverId) {
  const q = { task_id: `eq.${id}`, select: "task_id,driver_id,alert_id,course_id,goal,mandatory,due_at,status,started_at,submitted_at,learning_record,feedback,reviewer_id,review_note,reviewed_at,created_by,idempotency_key,updated_at" };
  if (asDriverId) q.driver_id = `eq.${asDriverId}`;
  const { data } = await dbRequest("get_task_row", "GET", "training_tasks", { query: q });
  const row = data?.[0];
  if (!row) throw new HttpError(404, "not_found");
  return row;
}
async function notify(targetUserId, type, sourceId, content, idem, entity = "training_task", title = null) {
  const dup = await dbRequest("count_task_notifs", "GET", "notification_events", { query: { idempotency_key: `eq.${idem}`, select: "notification_id,target_user_id", limit: 1 } });
  if (dup.data?.[0]) {
    if (dup.data[0].target_user_id !== targetUserId) throw new HttpError(409, "notification_recipient_changed");
    return dup.data[0].notification_id;
  }
  const nid = newId("noti");
  const role = ["rr_submitted", "task_submitted"].includes(type) ? "safety_admin" : "driver";
  try { await dbRequest("insert_task_notify", "POST", "notification_events", {
    body: [{ notification_id: nid, target_user_id: targetUserId, target_role: role, source_entity_type: entity, source_entity_id: sourceId, type, title: title || (type.includes("assigned") ? "新的培训任务" : type.includes("submitted") ? "待复核提醒" : "处理进展提醒"), body: String(content).slice(0, 500), content: String(content).slice(0, 500), read_at: null, idempotency_key: idem, created_at: nowIso() }],
    headers: { Prefer: "return=minimal" },
  }); } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 409) throw e;
    const existing = await dbRequest("count_task_notifs", "GET", "notification_events", { query: { idempotency_key: `eq.${idem}`, select: "notification_id,target_user_id", limit: 1 } });
    if (!existing.data?.[0] || existing.data[0].target_user_id !== targetUserId) throw e;
    return existing.data[0].notification_id;
  }
  return nid;
}
async function adminAccountId() {
  const a = await dbRequest("get_task_row", "GET", "app_users", { query: { role: "eq.safety_admin", account_status: "eq.active", select: "user_id", limit: 1 } });
  return a.data?.[0]?.user_id || null;
}

async function taskNotification(row, kind, assignedText = null) {
  if ((kind === "assigned" && row.status !== "assigned") || (kind === "submitted" && row.status !== "submitted")) return { state: "not_needed", notification_id: null };
  try {
    let target, text, idem;
    if (kind === "assigned") {
      const acct = await dbRequest("get_binding_target", "GET", "app_users", { query: { driver_id: `eq.${row.driver_id}`, role: "eq.driver", account_status: "eq.active", binding_verified: "eq.true", select: "user_id", limit: 1 } });
      target = acct.data?.[0]?.user_id;
      if (!assignedText) { const learning = await taskLearning(row); assignedText = learning.course_snapshot?.assignment_notice?.text || null; }
      text = assignedText || `培训任务 ${row.task_id}（课程 ${row.course_id}），请在培训任务中查看。站内通知不等于外部渠道送达。`;
      idem = `notif:taskas:${row.task_id}`;
    } else {
      const admins = await dbRequest("get_binding_target", "GET", "app_users", { query: { role: "eq.safety_admin", account_status: "eq.active", select: "user_id,fleet_scope", order: "user_id.asc", limit: 100 } });
      const candidates = [...(admins.data || [])].sort((a, b) => Number(b.user_id === row.created_by) - Number(a.user_id === row.created_by));
      let fleet = null;
      if (candidates.some(a => String(a.fleet_scope || "*") !== "*")) {
        const d = await dbRequest("get_binding_target", "GET", "drivers", { query: { driver_id: `eq.${row.driver_id}`, select: "fleet_id", limit: 1 } }); fleet = d.data?.[0]?.fleet_id;
      }
      target = candidates.find(a => String(a.fleet_scope || "*") === "*" || (fleet && String(a.fleet_scope) === String(fleet)))?.user_id;
      text = `司机 ${row.driver_id} 提交培训任务 ${row.task_id}，请在TR06复核。`; idem = `notif:tasksub:${row.task_id}`;
    }
    if (!target) return { state: "no_recipient", notification_id: null };
    const notificationId = await notify(target, kind === "assigned" ? "task_assigned" : "task_submitted", row.task_id, text, idem);
    return { state: "recorded", notification_id: notificationId };
  } catch { return { state: "pending", notification_id: null }; }
}

async function handleTaskNotificationRetry(request, response, url, ctx, taskId) {
  requireUser(ctx.principal, "assign.training");
  const row = await loadTask(taskId, null);
  await assertInScope(ctx.principal, { driverId: row.driver_id });
  const body = await readBody(request);
  if (!["assigned", "submitted"].includes(body.kind)) throw new HttpError(400, "invalid_notification_kind");
  const receipt = await taskNotification(row, body.kind);
  const auditId = await appendAudit(ctx.principal, "training.notification_retry", "training_task", taskId, null, receipt.state, ctx.requestId, null, { kind: body.kind, notification_id: receipt.notification_id });
  sendJson(response, 200, { ok: true, task_id: taskId, notification: receipt, audit_id: auditId });
}

// ===== R24：TR06 AI 辅助摘要（受控、只读、结构化、可点击回源；不改业务状态） =====
const summaryCache = new Map();
// ===== R26：AI04 管理动作并排预演（只读组装卡片事实底座 + 复用对话侧 action_preplan；零业务写） =====
async function handleAiPreplan(request, response, url, ctx) {
  const user = requireUser(ctx.principal);
  if (user.role !== "safety_admin") throw new HttpError(403, "forbidden"); // 预演页仅安全管理员
  const drvQ = cleanQuery(url.searchParams.get("driver_id"), 60);
  const gpsQ = cleanQuery(url.searchParams.get("gpsno"), 40);
  const asQ = String(url.searchParams.get("as_of_date") || "").slice(0, 10);
  if (!drvQ && !gpsQ) throw new HttpError(400, "object_required");
  if (asQ && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(asQ)) throw new HttpError(400, "bad_as_of");
  try {
    const sQuery = { select: "score_id,driver_id,gpsno,safety_score,risk_level,confidence_level,as_of_date,source_version,top_reason_1,observed_behavior_deduction,fatigue_distraction_event_count,driving_stability_event_count,road_rule_event_count,history_event_count,imu_evidence_event_count,review_queue,forecast_40d_risk_prob,rank", order: "as_of_date.desc", limit: 1 };
    if (drvQ) sQuery.driver_id = `eq.${drvQ}`; else sQuery.gpsno = `eq.${gpsQ}`;
    let sc = (await dbRequest("list_resource", "GET", "score_snapshots", { query: sQuery })).data?.[0] || null;
    if (asQ) { if (sc && sc.as_of_date !== asQ) { const sq2 = { ...sQuery, as_of_date: `eq.${asQ}` }; sc = (await dbRequest("list_resource", "GET", "score_snapshots", { query: sq2 })).data?.[0] || null; } else if (sc === null) { sc = null; } }
    if (!sc) return sendJson(response, 200, { data_status: asQ ? "no_data_for_date" : "not_found", as_of_date: asQ || null, cards: [], note: asQ ? `该对象在 ${asQ} 无评分快照（不补造数据，可切回最新日期）` : "对象在本会话可见范围内不存在（越权与不存在同语义）" });
    await assertInScope(ctx.principal, { driverId: String(sc.driver_id || ""), gpsno: String(sc.gpsno) });
    const dateFor = asQ || String(sc.as_of_date);
    const alertsAll = (await dbRequest("list_resource", "GET", "alerts", { query: { gpsno: `eq.${sc.gpsno}`, select: "alert_id,rule_code,evidence_id,occurred_at,status,owner_user_id,due_at", order: "occurred_at.desc", limit: 10 } })).data || [];
    const openAlerts = alertsAll.filter((a) => ["confirmed", "pending_review", "supplement_data"].includes(String(a.status)));
    const confirmed = alertsAll.filter((a) => String(a.status) === "confirmed");
    const qrow = (await dbRequest("list_resource", "GET", "review_queue", { query: { gpsno: `eq.${sc.gpsno}`, as_of_date: `eq.${String(sc.as_of_date)}`, select: "queue_id,review_queue,confidence_level,action_deadline", limit: 1 } })).data?.[0] || null;
    const courses = (await dbRequest("list_resource", "GET", "training_courses", { query: { content_status: "eq.approved", select: "course_id,title,completion_requirement", order: "course_id.asc", limit: 10 } })).data || [];
    const ledg = (await dbRequest("list_resource", "GET", "deduction_ledger", { query: { gpsno: `eq.${sc.gpsno}`, select: "ledger_id,dimension,as_of_date", order: "as_of_date.desc", limit: 3 } })).data || [];
    const tasks = (await dbRequest("list_resource", "GET", "training_tasks", { query: { driver_id: `eq.${String(sc.driver_id)}`, select: "task_id,status", order: "updated_at.desc", limit: 5 } })).data || [];
    const low = String(sc.confidence_level) === "low";
    const behaviorEvents = Number(sc.fatigue_distraction_event_count || 0) + Number(sc.driving_stability_event_count || 0) + Number(sc.road_rule_event_count || 0) + Number(sc.history_event_count || 0);
    const scoreRef = "score:" + sc.score_id;
    const commonBasis = [{ label: "近14天评分快照", table: "score_snapshots", record_id: sc.score_id, ref: scoreRef, note: `${sc.safety_score} · ${sc.risk_level} · 可信度 ${sc.confidence_level} · as_of ${sc.as_of_date} · ${sc.source_version}` }];
    const cards = [
      {
        key: "verify", title: "先核验设备或数据",
        basis: [...commonBasis, ...(qrow ? [{ label: "复核队列行", table: "review_queue", record_id: qrow.queue_id, ref: "queue:" + qrow.queue_id, note: `${qrow.review_queue} · 可信度 ${qrow.confidence_level}` }] : []), ...(ledg.length ? [{ label: "扣分台账（口径解释）", table: "deduction_ledger", record_id: String(ledg[0].ledger_id), ref: "ledger:" + String(ledg[0].ledger_id), note: "分摊用于核账非单事件因果" }] : [])],
        plan: low ? "设备在线/数据覆盖/IMU 佐证核验（RM01 队列 + 需要时 RM03 核验向草稿问话）" : "常规数据覆盖抽查",
        highlight: low,
        missing: low && !qrow ? ["缺少当日队列行佐证"] : [],
        todos: "本路径不新建业务记录；核验结论由人工回填案卷",
        limits: "低可信度时行为扣减仅供参考；不外推概率变化",
        operator: "safety_admin 人工执行核验并在案卷留痕",
        actionable: true,
        draft_entry: confirmed.length ? { kind: "rm3", label: `进入 RM03 核验向草稿（${confirmed[0].alert_id}）`, hash: `rm-alerts?alert_id=${encodeURIComponent(confirmed[0].alert_id)}` } : { kind: "queue", label: "无已确认案卷：去 RM01 队列按 gpsno 人工核验（不凭空开草稿）", hash: `rm-queue?gpsno=${encodeURIComponent(String(sc.gpsno))}` },
      },
      {
        key: "communicate", title: "先人工沟通",
        basis: [...commonBasis, ...(confirmed[0] ? [{ label: "关联案卷", table: "alerts", record_id: confirmed[0].alert_id, ref: "alert:" + confirmed[0].alert_id, note: `${confirmed[0].rule_code} · 证据 ${confirmed[0].evidence_id} · 事实日 ${confirmed[0].occurred_at}` }] : alertsAll.map((a) => ({ label: "案卷（非 open）", table: "alerts", record_id: String(a.status) === "closed" ? "" + String(a.alert_id) + "（closed）" : String(a.alert_id), ref: "alert:" + String(a.alert_id), note: `状态 ${a.status}` })).slice(0, 1))],
        plan: confirmed.length ? "经 RM03 起草→人工确认发送本人沟通（当前对象有已确认案卷）" : "无可沟通案卷上下文",
        highlight: false,
        actionable: confirmed.length > 0,
        disabled_reason: confirmed.length ? null : "存在案卷但无 confirmed 状态（closed/待核）→ 不凭空打开带告警上下文的 RM03 草稿；需先经 RM01/RM03 建立有效案卷",
        missing: confirmed.length ? [] : ["无有效（confirmed）告警"],
        todos: "确认后新增 interventions 一行（draft→sent）与本人站内通知",
        limits: "沟通不改变评分/预测；发送前正文可编辑",
        operator: "safety_admin 在 RM03 独立点击确认发送",
        draft_entry: confirmed.length ? { kind: "rm3", label: `进入 RM03 可编辑草稿（${confirmed[0].alert_id}）`, hash: `rm-alerts?alert_id=${encodeURIComponent(confirmed[0].alert_id)}` } : null,
      },
      {
        key: "training", title: "安排已审核课程",
        basis: [...commonBasis, ...(courses[0] ? [{ label: "候选课程（已审核）", table: "training_courses", record_id: courses[0].course_id, ref: "course:" + courses[0].course_id, note: `${courses[0].title} · ${String(courses[0].completion_requirement || "").slice(0, 40)}` }] : []), ...(tasks[0] ? [{ label: "该司机既有任务（避免重复分配）", table: "training_tasks", record_id: tasks[0].task_id, ref: null, note: `状态 ${tasks[0].status}` }] : [])],
        plan: "TR02 选已审核课程＋勾证据→人工确认分配（进入草稿不等于分配）",
        highlight: false,
        actionable: courses.length > 0 && behaviorEvents >= 1 && !low,
        disabled_reason: courses.length === 0 ? "无 approved 课程——待团队审核课程不可正式分配" : low ? "低可信度对象：先核验通过再评估培训（不自动安排惩罚性课程）" : behaviorEvents < 1 ? "无已核实行为证据事件：培训分配缺少事实锚点" : null,
        missing: low ? ["设备/数据核验先于培训"] : [],
        todos: "确认后新增 training_tasks 一行 + 本人站内通知",
        limits: "只引用 approved 版本；不宣称培训改善评分；行为事件数 " + behaviorEvents + "（fatigue/stability/road_rule/history 合计）",
        operator: "safety_admin 在 TR02 独立点击“安全员确认分配”",
        draft_entry: courses.length > 0 && !low && behaviorEvents >= 1 ? { kind: "tr2", label: "进入 TR02 可编辑草稿（携带本对象上下文）", hash: "tr-create" } : null,
      },
    ];
    sendJson(response, 200, { data_status: "ok", mode: "preplan_readonly", title_tag: "操作预演，未写入", subject: { driver_id: sc.driver_id, gpsno: sc.gpsno, as_of_date: sc.as_of_date, source_version: sc.source_version }, facts_status: "AI 建议与已核实事实分列：basis 均为本会话授权查询的真实记录", cards, ai_note: "需要模型建议文字时用面板「让 AI 预演三路径」（走既有 action_preplan 工具与 ai.chat 审计，本页不另建调用链）" });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    sendJson(response, 200, { data_status: "query_failed", cards: [], note: "组装查询失败（不以空壳伪装预演完成）" });
  }
}

// ===== R27 准备（未上线）：通知模板审核端点。表未迁移前全部路径优雅降级 migration_pending。
async function probeTemplates() {
  try { const r = await dbRequest("tpl_probe", "GET", "notification_templates", { query: { select: "template_id", limit: 1 } }); return Boolean(r.data); } catch { return false; }
}
const PLACEHOLDER_WHITELIST = ["event_date", "evidence_type", "review_note", "driver_id", "alert_id"];
const TPL_FSM = { draft: ["pending_review"], pending_review: ["approved", "draft", "disabled"], approved: ["disabled"], disabled: [] };
async function handleTemplatesAdmin(request, response, url, ctx, templateId) {
  requireUser(ctx.principal, "manage.knowledge");
  if (!(await probeTemplates())) return sendJson(response, 200, { ok: true, migration_pending: true, rows: [], latest: [], note: "迁移 005（notification_templates）尚未执行——待属主在平台数据库入口执行 scripts/contract/migrations/005_notification_templates.up.sql 后本页方可用；当前零写入零影响" });
  const user = requireUser(ctx.principal, "manage.knowledge");
  const body = await readBody(request);
  const action = String(body.action || "");
  if (request.method === "GET" && !templateId) {
    const q = { select: "template_id,template_key,version,title,body,allowed_placeholders,scene,applicable_role,review_status,status_version,source_note,created_by,created_at,reviewed_by,reviewed_at,review_note", order: "template_key.asc,version.desc", limit: 200 };
    if (["draft", "pending_review", "approved", "disabled"].includes(String(url.searchParams.get("review_status") || ""))) q.review_status = `eq.${url.searchParams.get("review_status")}`;
    if (url.searchParams.get("scene")) q.scene = `eq.${String(url.searchParams.get("scene")).slice(0, 30)}`;
    const rows = await listRows("tpl_list", "notification_templates", { query: q });
    const latestMap = new Map(); for (const r of rows) { const cur = latestMap.get(r.template_key); if (!cur || Number(r.version) > Number(cur.version)) latestMap.set(r.template_key, r); }
    const latest = [...latestMap.values()];
    sendJson(response, 200, { ok: true, rows, latest, officially_referenceable: latest.filter((r) => r.review_status === "approved").map((r) => r.template_id), whitelist: PLACEHOLDER_WHITELIST });
    return;
  }
  if (request.method === "POST" && !templateId) {
    const key = String(body.template_key || "").trim().toLowerCase().slice(0, 48);
    const title = String(body.title || "").slice(0, 160); const tplBody = String(body.body || "").slice(0, 4000);
    if (!/^[a-z0-9_.-]{3,48}$/.test(key) || !title.trim() || !tplBody.trim()) throw new HttpError(400, "key_title_body_required");
    const allowed = String(body.allowed_placeholders || "event_date,evidence_type,review_note").split(",").map((s) => s.trim()).filter(Boolean);
    if (allowed.some((a) => !PLACEHOLDER_WHITELIST.includes(a))) throw new HttpError(409, "placeholder_not_whitelisted");
    const used = [...tplBody.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]);
    if (used.some((u) => !allowed.includes(u))) throw new HttpError(409, "body_uses_disallowed_placeholder");
    const at = nowIso();
    const exist = await listRows("tpl_list", "notification_templates", { template_key: `eq.${key}`, select: "version", order: "version.desc", limit: 1 });
    const version = Number(exist[0]?.version || 0) + 1;
    const id = newId("nt");
    await dbRequest("tpl_insert", "POST", "notification_templates", { body: [{ template_id: id, template_key: key, version, title, body: tplBody, allowed_placeholders: allowed.join(","), scene: ["rm3_draft", "task_assigned", "review_answer"].includes(body.scene) ? body.scene : "rm3_draft", applicable_role: ["driver", "safety_admin", "all"].includes(body.applicable_role) ? body.applicable_role : "driver", review_status: "draft", status_version: 0, source_note: String(body.source_note || "").slice(0, 300) || null, created_by: user.user_id, created_at: at, updated_at: at }], headers: { Prefer: "return=minimal" } });
    const auditId = await appendAudit(ctx.principal, "template.create", "notification_template", `${key}:${version}`, null, "draft", ctx.requestId, [], { template_id: id });
    sendJson(response, 201, { ok: true, template_id: id, template_key: key, version, review_status: "draft", audit_id: auditId, note: "新建模板初始 draft，永不自动批准；改已审核正文一律 new_version 新草稿，不静默覆盖" });
    return;
  }
  const keyQ = String(templateId || "");
  const rowsAll = await listRows("tpl_list", "notification_templates", { template_key: `eq.${keyQ.split(":")[0]}`, version: keyQ.includes(":") ? `eq.${keyQ.split(":")[1]}` : undefined, select: "template_id,template_key,version,title,body,review_status,status_version,created_by", order: "version.desc", limit: 1 });
  const row = rowsAll[0]; if (!row) throw new HttpError(404, "not_found");
  const at2 = nowIso(); let patch = null; let au = null;
  if (action === "submit" && row.review_status === "draft") { patch = { review_status: "pending_review", status_version: Number(row.status_version || 0) + 1 }; au = ["draft", "pending_review", "template.submit"]; }
  else if (action === "withdraw" && row.review_status === "pending_review") { patch = { review_status: "draft", status_version: Number(row.status_version || 0) + 1 }; au = ["pending_review", "draft", "template.withdraw"]; }
  else if (action === "approve" && row.review_status === "pending_review") {
    const sameActor = String(row.created_by) === String(user.user_id);
    if (sameActor && body.confirm_same_actor !== true) throw new HttpError(409, "self_review_requires_explicit_confirm");
    patch = { review_status: "approved", reviewed_by: user.user_id, reviewed_at: at2, status_version: Number(row.status_version || 0) + 1 }; au = ["pending_review", "approved", "template.approve"];
    if (sameActor) patch.review_note = "同作者二次确认批准（留痕）";
  }
  else if (action === "disable" && TPL_FSM[row.review_status]?.includes("disabled")) { patch = { review_status: "disabled", reviewed_by: user.user_id, reviewed_at: at2, status_version: Number(row.status_version || 0) + 1 }; au = [row.review_status, "disabled", "template.disable"]; }
  else if (action === "edit" && row.review_status === "draft") {
    const b2 = String(body.body ?? row.body).slice(0, 4000); const al = String(row.allowed_placeholders || "").split(",");
    if ([...b2.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].some((m) => !al.includes(m[1]))) throw new HttpError(409, "body_uses_disallowed_placeholder");
    patch = { body: b2, title: body.title !== undefined ? String(body.title).slice(0, 160) : row.title, updated_at: at2 }; au = ["draft", "draft", "template.edit"];
  }
  else if (action === "new_version" && ["approved", "disabled"].includes(row.review_status)) {
    const b2 = String(body.body || "").slice(0, 4000); if (!b2.trim()) throw new HttpError(400, "body_required");
    const ex = await listRows("tpl_list", "notification_templates", { template_key: `eq.${row.template_key}`, select: "version", order: "version.desc", limit: 1 });
    const vnext = Number(ex[0]?.version || row.version) + 1; const id2 = newId("nt");
    await dbRequest("tpl_insert", "POST", "notification_templates", { body: [{ template_id: id2, template_key: row.template_key, version: vnext, title: String(body.title || row.title).slice(0, 160), body: b2, allowed_placeholders: row.allowed_placeholders, scene: "rm3_draft", applicable_role: "driver", review_status: "draft", status_version: 0, source_note: `基于 ${row.template_key}:${row.version} 修订`, created_by: user.user_id, created_at: at2, updated_at: at2 }], headers: { Prefer: "return=minimal" } });
    const a3 = await appendAudit(ctx.principal, "template.new_version", "notification_template", `${row.template_key}:${vnext}`, row.review_status, "draft", ctx.requestId, [], { base_version: row.version });
    sendJson(response, 200, { ok: true, template_id: id2, version: vnext, review_status: "draft", audit_id: a3 }); return;
  }
  if (!patch) throw new HttpError(409, `template_action_${action || "none"}_invalid_from_${row.review_status}`);
  { const pq = { template_id: `eq.${row.template_id}`, review_status: `eq.${row.review_status}` };
    await dbRequest("tpl_patch", "PATCH", "notification_templates", { query: pq, body: { ...patch, updated_at: at2 }, headers: { Prefer: "return=minimal" } }); }
  const auditId = await appendAudit(ctx.principal, au[2], "notification_template", `${row.template_key}:${row.version}`, au[0], au[1], ctx.requestId);
  sendJson(response, 200, { ok: true, template_key: row.template_key, version: row.version, old_status: au[0], new_status: au[1], audit_id: auditId });
}
async function handleTemplatePreview(request, response, url, ctx) {
  requireUser(ctx.principal, "manage.knowledge");
  if (!(await probeTemplates())) return sendJson(response, 200, { ok: true, migration_pending: true, rendered: null, note: "模板表未迁移，预览不可用（不伪造渲染结果）" });
  const tid = cleanQuery(url.searchParams.get("template_id"), 80); const drv = cleanQuery(url.searchParams.get("driver_id"), 60); const gps = cleanQuery(url.searchParams.get("gpsno"), 40);
  if (!tid || (!drv && !gps)) throw new HttpError(400, "bad_request");
  await assertInScope(ctx.principal, drv ? { driverId: drv } : { gpsno: gps });
  const row = (await listRows("tpl_list", "notification_templates", { select: "template_id,template_key,version,body,review_status", template_id: `eq.${tid}`, limit: 1 }))[0];
  if (!row) throw new HttpError(404, "not_found");
  if (row.review_status !== "approved") return sendJson(response, 200, { ok: false, error: "template_not_approved", review_status: row.review_status, rendered: null, note: `状态 ${row.review_status} 不可用于正式发送（预览仅供审阅）` });
  const facts = {}; const missing = [];
  const sc = (await listRows("tpl_list", "score_snapshots", { driver_id: drv ? `eq.${drv}` : undefined, gpsno: gps ? `eq.${gps}` : undefined, select: "gpsno,as_of_date,source_version", order: "as_of_date.desc", limit: 1 }))[0];
  const al = sc ? (await listRows("tpl_list", "alerts", { gpsno: `eq.${sc.gpsno}`, select: "alert_id,rule_code,occurred_at", order: "occurred_at.desc", limit: 1 }))[0] : null;
  if (al) { facts.event_date = String(al.occurred_at || "").slice(0, 10); facts.evidence_type = al.rule_code; facts.alert_id = al.alert_id; } else { missing.push("event_date", "evidence_type", "alert_id"); }
  const iv = al ? (await listRows("tpl_list", "interventions", { alert_id: `eq.${al.alert_id}`, select: "reply_text,replied_at", order: "updated_at.desc", limit: 1 }))[0] : null;
  if (iv && iv.reply_text) facts.review_note = "（引用司机本人回复，审阅意见需人工撰写，不由模板决定）"; else missing.push("review_note");
  const alMap = (await listRows("tpl_list", "app_users", { driver_id: `eq.${drv || (sc ? "" : "")}`, binding_verified: "eq.true", account_status: "eq.active", select: "user_id", limit: 1 }))[0];
  if (!drv && sc) { const dv = (await listRows("tpl_list", "drivers", { gpsno: `eq.${sc.gpsno}`, select: "driver_id", limit: 1 }))[0]; if (dv) facts.driver_id = dv.driver_id; else missing.push("driver_id"); } else facts.driver_id = drv;
  const tplRow = row;
  const rendered = String(tplRow.body).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, name) => (facts[name] !== undefined && facts[name] !== null ? String(facts[name]) : `（待核：${name}）`));
  sendJson(response, 200, { ok: true, template_id: tplRow.template_id, version: Number(tplRow.version), rendered, missing_facts: [...new Set(missing)], bound_account: alMap ? true : false, delivered_label: alMap ? "站内可达（已绑定）" : "无已核实绑定：发送后也不会显示「已送达」", note: "预览只读；写入仍需 RM03 人工确认，正文进入草稿后可编辑" });
}

async function handleTaskSummary(request, response, url, ctx) {
  const user = requireUser(ctx.principal, "review.training_feedback");
  const body = await readBody(request);
  const taskId = String(body.task_id || "").slice(0, 64);
  if (!taskId) throw new HttpError(400, "bad_request");
  if (!aiAvailable()) { try { await appendAudit(ctx.principal, "ai.task_summary", "ai_call", taskId, null, "provider_not_configured", ctx.requestId); } catch {} return sendJson(response, 200, { available: false, reason: "ai_provider_not_configured", note: "AI 摘要暂不可用（运行时模型未配置）；前三部分与人工审核照常可用" }); }
  const cached = summaryCache.get(taskId);
  if (cached && Date.now() - cached.at < 600000) { sendJson(response, 200, { ...cached.data, cached: true }); return; }
  let task = null; const taskId2 = taskId;
  try {
    task = (await dbRequest("get_task_row", "GET", "training_tasks", { query: { task_id: `eq.${taskId}`, select: "task_id,driver_id,alert_id,course_id,goal,mandatory,due_at,status,learning_record,submitted_at", limit: 1 } })).data?.[0];
    if (!task) { try { await appendAudit(ctx.principal, "ai.task_summary", "ai_call", taskId, null, "not_found", ctx.requestId); } catch {} throw new HttpError(404, "not_found"); }
    if (!["submitted", "returned"].includes(String(task.status))) { try { await appendAudit(ctx.principal, "ai.task_summary", "ai_call", taskId, String(task.status), "rejected_state", ctx.requestId); } catch {} throw new HttpError(409, "summary_requires_submitted"); }
    await assertInScope(ctx.principal, { driverId: String(task.driver_id) });
    const facts = [];
    if (task.learning_record) facts.push({ ref: "task:" + task.task_id, label: "司机原文（提交于 " + String(task.submitted_at || "").slice(0, 16) + "）", text: String(task.learning_record).slice(0, 1200) });
    else facts.push({ ref: "task:" + task.task_id, label: "司机原文", text: "（未取得：该任务尚无提交文本）" });
    const cs = (await dbRequest("ts_course", "GET", "training_courses", { query: { course_id: `eq.${task.course_id}`, select: "course_id,title,completion_requirement,content_status,version_no", limit: 1 } })).data?.[0] || null;
    if (cs) facts.push({ ref: "course:" + cs.course_id, label: `课程《${cs.title}》分配版本记录 v${cs.version_no}（当前状态 ${cs.content_status}）`, text: "完成条件：" + String(cs.completion_requirement || "—").slice(0, 300) });
    else facts.push({ ref: "course:" + task.course_id, label: "课程", text: "（未取得：课程记录不可读）" });
    if (task.alert_id) {
      const al = (await dbRequest("get_alert_row", "GET", "alerts", { query: { alert_id: `eq.${task.alert_id}`, select: "alert_id,gpsno,evidence_id,rule_code,status,occurred_at", limit: 1 } })).data?.[0];
      if (al) {
        facts.push({ ref: "alert:" + al.alert_id, label: `关联案卷 ${al.rule_code}（当前 ${al.status}，事实日 ${al.occurred_at}）`, text: "证据记录 " + String(al.evidence_id || "—") });
        const sc = (await dbRequest("ts_facts", "GET", "score_snapshots", { query: { gpsno: `eq.${al.gpsno}`, select: "score_id,safety_score,risk_level,confidence_level,as_of_date,source_version", order: "as_of_date.desc", limit: 1 } })).data?.[0];
        if (sc) facts.push({ ref: "score:" + sc.score_id, label: `关联评分（截止 ${sc.as_of_date}）`, text: `safety_score=${sc.safety_score} 等级=${sc.risk_level} 可信度=${sc.confidence_level} 来源=${sc.source_version}` });
      } else facts.push({ ref: "alert-missing:" + task.alert_id, label: "关联案卷", text: "（未取得：案卷记录当前不可读）" });
    } else facts.push({ ref: "task:" + task.task_id, label: "关联案卷/证据", text: "（未取得：任务未关联 alert_id——不臆造证据）" });
    const allowed = new Set(facts.map((f) => f.ref));
    const prompt = [
      "你是培训反馈审核辅助员（只读）。基于且仅基于给定事实，输出对这条司机提交的【完成条件逐项核查草稿】。规则：",
      "1) 每个判断附 fact（指出引用了事实的哪一处/缺什么）与 ref（只能取自给定 ref 列表原样值）；",
      "2) 不得判定通过/退回；不得宣称培训改善评分或消除风险；state 只能取 覆盖/未见/无法判断；",
      "3) 严格输出 JSON：",
      '{"items":[{"judgment":"string","state":"覆盖|未见|无法判断","fact":"string","ref":"string"}],"limitations":["string"]}',
      "事实：" + JSON.stringify({ task_id: task.task_id, goal: task.goal, mandatory: task.mandatory, due_at: task.due_at, status: task.status, facts: facts.map((f) => ({ ref: f.ref, label: f.label, text: f.text })) }),
    ].join("\n");
    const ai = await aiUpstreamOnce({ model: aiModel(), messages: [{ role: "system", content: "只输出一个 JSON 对象，不输出任何其它文字。" }, { role: "user", content: prompt.slice(0, 12000) }], temperature: 0.2, max_tokens: 1600, enable_thinking: false }, 150000);
    let parsed = null;
    try { const s = String((ai.choices && ai.choices[0] && ai.choices[0].message && ai.choices[0].message.content) || ai.content || ""); parsed = JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)); } catch { parsed = null; }
    if (!parsed || !Array.isArray(parsed.items)) { try { await appendAudit(ctx.principal, "ai.task_summary", "ai_call", taskId, null, "malformed_model_output", ctx.requestId); } catch {} return sendJson(response, 200, { available: false, reason: "malformed_model_output", note: "模型输出不合结构（已留审计，未落业务表）；前三部分与人工审核照常可用" }); }
    const items = parsed.items.slice(0, 12).map((x) => ({ judgment: String(x.judgment || "").slice(0, 300), state: String(x.state || "无法判断"), fact: String(x.fact || "").slice(0, 400), ref: String(x.ref || ""), ref_ok: allowed.has(String(x.ref || "")) }));
    const data = {
      available: true, task_id: task.task_id, status: task.status,
      course: cs ? { course_id: cs.course_id, title: cs.title, version_no: cs.version_no, current_status: cs.content_status, note: cs.content_status === "disabled" ? "课程现已停用：本卡片仍展示任务分配所指向的历史版本记录，并如实标当前状态" : null } : null,
      facts: facts.map((f) => ({ ref: f.ref, label: f.label, missing: /（未取得/.test(f.text) })),
      items, limitations: ["AI 辅助草稿：不自动判定通过/退回，不宣称评分改善或风险消除；缺失事实不由模型补齐", ...(Array.isArray(parsed.limitations) ? parsed.limitations.slice(0, 3).map(String) : [])],
      model: aiModel(), generated_at: nowIso(), cached: false, audit_note: "调用已审计（角色/工具/引用ID/结果状态；不保留完整个人原文）",
    };
    summaryCache.set(taskId, { at: Date.now(), data });
    try { await appendAudit(ctx.principal, "ai.task_summary", "ai_call", taskId, null, "answered_with_facts", ctx.requestId, items.filter((i) => i.ref_ok).map((i) => i.ref).slice(0, 8), { kind: "task_summary", model: aiModel(), items: items.length, refs_ok: items.filter((i) => i.ref_ok).length, refs_bad: items.filter((i) => !i.ref_ok).length, no_full_text_stored: true }); } catch {}
    sendJson(response, 200, data);
  } catch (e) {
    if (e instanceof HttpError && e.status !== 502) throw e;
    try { await appendAudit(ctx.principal, "ai.task_summary", "ai_call", taskId2, null, /502|abort|timeout|upstream/i.test(String((e && e.message) || "")) ? "upstream_error" : "chat_internal_error", ctx.requestId, null, { err: sanitizeText(String((e && e.message) || e)).slice(0, 60) }); } catch {}
    if (e instanceof HttpError) throw e;
    return sendJson(response, 200, { available: false, reason: "ai_upstream_unavailable", note: "AI 摘要暂不可用（上游错误/超时，已留审计）；人工四部分审核照常" });
  }
}

async function handleTaskStart(request, response, url, ctx, taskId) {
  const user = requireVerifiedDriver(ctx.principal);
  const row = await loadTask(taskId, user.driver_id);
  checkTaskClientVersion(row, await readBody(request));
  if (row.status === "in_progress") return sendJson(response, 200, { ok: true, idempotent_replay: true, task_id: taskId, status: row.status, started_at: row.started_at });
  if (!TASK_FSM_START.includes(row.status)) throw new HttpError(409, `task_state_${row.status}_cannot_start`);
  const at = nowIso();
  await patchTaskExpected(row, { status: "in_progress", started_at: row.started_at || at });
  const auditId = await appendAudit(ctx.principal, "training.start", "training_task", taskId, row.status, "in_progress", ctx.requestId);
  sendJson(response, 200, { ok: true, task_id: taskId, status: "in_progress", started_at: row.started_at || at, audit_id: auditId });
}

async function handleTaskDraftSave(request, response, url, ctx, taskId) {
  const user = requireVerifiedDriver(ctx.principal);
  const row = await loadTask(taskId, user.driver_id);
  if (!TASK_EDITABLE.includes(row.status)) throw new HttpError(409, `task_state_${row.status}_not_editable`);
  const body = await readBody(request);
  checkTaskClientVersion(row, body);
  const lr = String(body.learning_record ?? row.learning_record ?? "").slice(0, 6000);
  const patch = { learning_record: lr, ...(body.feedback !== undefined ? { feedback: String(body.feedback).slice(0, 3000) } : {}) };
  if (body.self_check !== undefined) throw new HttpError(410, "quiz_not_supported_by_source_materials");
  const updatedAt = await patchTaskExpected(row, patch);
  sendJson(response, 200, { ok: true, task_id: taskId, saved_at: updatedAt, updated_at: updatedAt, note: "未提交草稿可反复保存；提交后司机端不可再改" });
}

async function handleTaskSubmit(request, response, url, ctx, taskId) {
  const user = requireVerifiedDriver(ctx.principal);
  const row = await loadTask(taskId, user.driver_id);
  if (row.status === "submitted") {
    const notification = await taskNotification(row, "submitted");
    return sendJson(response, 200, { ok: true, idempotent_replay: true, task_id: taskId, status: "submitted", submitted_at: row.submitted_at, notification, reviewer_notified: notification.notification_id });
  }
  if (!TASK_FSM_SUBMIT.includes(row.status)) throw new HttpError(409, `task_state_${row.status}_cannot_submit`);
  const body = await readBody(request);
  checkTaskClientVersion(row, body);
  const lr = String(body.learning_record ?? row.learning_record ?? "").slice(0, 6000);
  const fb = String(body.feedback ?? "").slice(0, 3000);
  if (!lr.trim()) throw new HttpError(409, "learning_record_required");
  const at = nowIso();
  await patchTaskExpected(row, { status: "submitted", submitted_at: at, learning_record: lr, feedback: fb, started_at: row.started_at || at });
  const auditId = await appendAudit(ctx.principal, "training.submit", "training_task", taskId, row.status, "submitted", ctx.requestId);
  const notification = await taskNotification({ ...row, status: "submitted" }, "submitted");
  sendJson(response, 200, { ok: true, task_id: taskId, status: "submitted", submitted_at: at, audit_id: auditId, reviewer_notified: notification.notification_id, notification });
}

async function handleTaskReview(request, response, url, ctx, taskId) {
  const user = requireUser(ctx.principal, "review.training_feedback");
  const body = await readBody(request);
  const row = await loadTask(taskId, null);
  await assertInScope(ctx.principal, { driverId: row.driver_id });
  if (row.status === "reviewed" || row.status === "observation" || row.status === "interview") {
    return sendJson(response, 200, { ok: true, idempotent_replay: true, task_id: taskId, status: row.status, reviewed_at: row.reviewed_at, reviewer_id: row.reviewer_id });
  }
  if (!TASK_FSM_REVIEW.includes(row.status)) throw new HttpError(409, `task_state_${row.status}_cannot_review`);
  const decision = String(body.decision || "");
  const map = { approved: "reviewed", returned: "returned", observe: "observation", interview: "interview" };
  const next = map[decision];
  if (!next) throw new HttpError(400, "bad_request");
  const reason = String(body.reason || "").slice(0, 1000);
  if (!reason.trim()) throw new HttpError(409, "review_reason_required");
  const at = nowIso();
  await patchTaskExpected(row, { status: next, reviewer_id: user.user_id, review_note: reason, reviewed_at: at });
  const auditId = await appendAudit(ctx.principal, `training.review.${decision}`, "training_task", taskId, "submitted", next, ctx.requestId);
  sendJson(response, 200, { ok: true, task_id: taskId, new_status: next, reviewer_id: user.user_id, reviewed_at: at, audit_id: auditId });
}

async function handleTaskView(request, response, url, ctx, taskId) {
  const user = requireUser(ctx.principal);
  const isDriver = user.role === "driver";
  if (isDriver) requireVerifiedDriver(ctx.principal);
  else if (!ROLE_CAPABILITIES[user.role]?.has("assign.training")) throw new HttpError(403, "forbidden");
  const row = await loadTask(taskId, user.role === "driver" ? user.driver_id : null);
  if (!isDriver) await assertInScope(ctx.principal, { driverId: row.driver_id });
  const [al, co] = await Promise.all([
    row.alert_id ? dbRequest("get_alert_row", "GET", "alerts", { query: { alert_id: `eq.${row.alert_id}`, driver_id: `eq.${row.driver_id}`, select: "alert_id,gpsno,rule_code,evidence_id,occurred_at,status" } }) : { data: [] },
    dbRequest("get_course_row", "GET", "training_courses", { query: { course_id: `eq.${row.course_id}`, select: "course_id,title,content,completion_requirement,content_status,version_no,source_version" } }),
  ]);
  const t2 = isDriver ? { data: [] } : await dbRequest("list_audit", "GET", "audit_logs", { query: { entity_id: `eq.${taskId}`, select: "audit_id,action,old_status,new_status,actor_id,actor_role,occurred_at", order: "occurred_at.asc", limit: 40 } });
  const learning = await taskLearning(row);
  const current = co.data?.[0] || null;
  // A snapshot is captured on first learning save, never mislabeled as the assignment version.
  const course = learning.course_snapshot || (current?.content_status === "approved" ? current : current ? { ...current, content: null } : null);
  let reassess = { date: null, row: null, status: "awaiting_submission", note: "提交并经人工复核后，等待本人下一周期数据。" };
  if (row.submitted_at) {
    const submitDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(row.submitted_at));
    const cols = "score_id,as_of_date,safety_score,risk_level,confidence_level,source_version";
    const [before, after] = await Promise.all([
      dbRequest("list_resource", "GET", "score_history", { query: { driver_id: `eq.${row.driver_id}`, as_of_date: `lte.${submitDate}`, select: cols, order: "as_of_date.desc", limit: 1 } }),
      dbRequest("list_resource", "GET", "score_history", { query: { driver_id: `eq.${row.driver_id}`, as_of_date: `gt.${submitDate}`, select: cols, order: "as_of_date.desc", limit: 1 } }),
    ]);
    const base = before.data?.[0], next = after.data?.[0];
    let status = "awaiting_data", note = "等待本人下一周期数据，不以培训完成宣称改善有效。";
    if (next) {
      status = "requires_review"; note = "已有后续数据，需人工核验评价口径与覆盖，分值变化不证明培训的因果效果。";
      if (row.status !== "reviewed") { status = "awaiting_review"; note = "培训尚未通过人工复核，后续数据仅供查看。"; }
      else if (!base || !base.source_version || base.source_version !== next.source_version) { status = "not_comparable"; note = "缺少基线或来源版本不同，不能直接比较；来源版本一致也仍需人工核验算法口径。"; }
      else if (base.confidence_level === "low" || next.confidence_level === "low") { status = "low_confidence"; note = "基线或后续数据可信度低，优先核验数据。"; }
      else if (Date.parse(next.as_of_date) - Date.parse(submitDate) < 14 * 86400000) { status = "overlapping_window"; note = "后续14天滚动评价窗口可能包含培训前数据，暂不做改善效果判定。"; }
    }
    reassess = { date: next?.as_of_date || null, row: next || null, baseline: base || null, status, note };
  }
  sendJson(response, 200, { task: row, alert: al.data?.[0] || null, course, current_course_status: current?.content_status || null, course_basis: learning.course_snapshot?.captured_stage || (learning.course_snapshot ? "first_learning_save" : "current_version"), learning_available: learning.available, timeline: t2.data || [], reassess });
}

async function handleLearningReport(request, response, url, ctx) {
  const user = requireVerifiedDriver(ctx.principal);
  const taskId = String(url.searchParams.get("task_id") || "");
  if (!/^[\w:,.-]{1,80}$/.test(taskId)) throw new HttpError(400, "invalid_task_id");
  const task = await loadTask(taskId, user.driver_id);
  const learning = await taskLearning(task);
  const courseResult = await dbRequest("get_course_row", "GET", "training_courses", { query: { course_id: `eq.${task.course_id}`, select: "course_id,title,content_status,version_no,source_version,completion_requirement", limit: 1 } });
  const course = learning.course_snapshot || courseResult.data?.[0] || null;
  sendJson(response, 200, { task_id: task.task_id, course: course ? { course_id: course.course_id, title: course.title, completion_requirement: course.completion_requirement, version_no: course.version_no ?? null, source_version: course.source_version || null } : null, goal: task.goal || null, status: task.status, learning_record: task.learning_record ?? null, feedback: task.feedback ?? null, review_note: task.review_note ?? null, submitted_at: task.submitted_at || null, reviewed_at: task.reviewed_at || null, alert_id: task.alert_id || null, conclusion: task.review_note ? "以下是安全员已记录的复核意见，不等于事故风险降低的证明。" : "尚无人工复核结论。", limitations: "本汇总仅整理来源课程、本人学习记录及已保存的流程事实，不生成专业测验分数，不推断培训效果，不改安全评分。", generated_at: nowIso() });
}


// ---------- Section: score review requests (EV05) ----------
// 契约 app_tables.json：状态 submitted→checking→awaiting_data_owner→answered→closed；
// 本模块只读取快照/台账做核查展示，任何接口不写评分/概率/等级/六维/旧快照（源数据问题只能转数据负责人走正式版本化流程）。
const RR_REASONS = ["identity_association", "event_record", "device_or_data_missing", "score_explanation"];
const RR_FLOW = { submitted: ["checking", "answered"], checking: ["awaiting_data_owner", "answered"], awaiting_data_owner: ["answered"], answered: ["closed"], closed: [] };
const RR_NOTE_REQUIRED = ["awaiting_data_owner", "answered", "closed"];

async function handleRRCreate(request, response, url, ctx) {
  const user = requireVerifiedDriver(ctx.principal);
  const body = await readBody(request);
  const scoreId = String(body.score_id || "").slice(0, 80);
  const evidenceId = String(body.evidence_id || "").slice(0, 80);
  const reason = String(body.reason_code || "");
  const desc = String(body.description || "").trim().slice(0, 4000);
  if (!RR_REASONS.includes(reason) || !desc) throw new HttpError(400, "bad_request");
  if (!scoreId && !evidenceId) throw new HttpError(400, "target_required");
  let sourceVersion = null;
  if (scoreId) {
    const s = await dbRequest("get_own_score_row", "GET", "score_snapshots", { query: { score_id: `eq.${scoreId}`, driver_id: `eq.${user.driver_id}`, select: "score_id,source_version,gpsno", limit: 1 } });
    if (!s.data?.[0]) throw new HttpError(404, "not_found");
    sourceVersion = s.data[0].source_version;
  }
  if (evidenceId) {
    const meGps = await dbRequest("get_own_score_row", "GET", "drivers", { query: { driver_id: `eq.${user.driver_id}`, select: "gpsno", limit: 1 } });
    const gps = meGps.data?.[0]?.gpsno;
    const l = await dbRequest("get_own_ledger_row", "GET", "deduction_ledger", { query: { ledger_id: `eq.${evidenceId}`, select: "ledger_id,gpsno,source_version", limit: 1 } });
    if (!gps || !l.data?.[0] || l.data[0].gpsno !== gps) throw new HttpError(404, "not_found");
    sourceVersion = sourceVersion || l.data[0].source_version;
  }
  const idem = String(body.idempotency_key || `rr:${user.driver_id}:${scoreId || evidenceId}:${reason}:${sha256hex(desc).slice(0, 12)}`).slice(0, 140);
  const findDuplicate = async () => (await dbRequest("get_rr_row", "GET", "review_requests", { query: { idempotency_key: `eq.${idem}`, select: "request_id,driver_id,score_id,evidence_id,reason_code,description,status,created_at", limit: 1 } })).data?.[0];
  const replay = async row => {
    if (row.driver_id !== user.driver_id || (row.score_id || "") !== scoreId || (row.evidence_id || "") !== evidenceId || row.reason_code !== reason || row.description !== desc) throw new HttpError(409, "review_request_idempotency_conflict");
    const notification = await reviewRequestNotification(row, "submitted");
    return sendJson(response, 200, { ok: true, idempotent_replay: true, request_id: row.request_id, status: row.status, created_at: row.created_at, notification, admin_notified: notification.notification_id || null });
  };
  const dup = await findDuplicate();
  if (dup) return replay(dup);
  const requestId = newId("rr");
  const at = nowIso();
  const target = await reviewRecipient(user.driver_id);
  const row = { request_id: requestId, driver_id: user.driver_id, score_id: scoreId || null, evidence_id: evidenceId || null, reason_code: reason, description: desc, status: "submitted", review_note: null, reviewer_id: null, source_version: sourceVersion, created_by: user.user_id, created_at: at, updated_at: at, idempotency_key: idem,
    ...(process.env.IE_LOCAL_SOURCE_ONLY === "1" ? { reminder_target_user_id: target } : {}) };
  try { await dbRequest("insert_rr_row", "POST", "review_requests", {
    body: [row],
    headers: { Prefer: "return=minimal" },
  }); } catch (e) {
    if (e instanceof HttpError && e.status === 409) { const existing = await findDuplicate(); if (existing) return replay(existing); }
    throw e;
  }
  const notification = await reviewRequestNotification(row, "submitted");
  const auditId = await appendAudit(ctx.principal, "review_request.create", "review_request", requestId, null, "submitted", ctx.requestId);
  sendJson(response, 201, { ok: true, request_id: requestId, status: "submitted", audit_id: auditId, notification, admin_notified: notification.notification_id || null, note: "申请已保存；提醒结果单独返回。不修改任何评分事实值；由安全员核查答复" });
}

async function reviewRecipient(driverId) {
  const d = await dbRequest("get_own_score_row", "GET", "drivers", { query: { driver_id: `eq.${driverId}`, select: "fleet_id", limit: 1 } });
  const fleet = d.data?.[0]?.fleet_id;
  if (!fleet) return null;
  const a = await dbRequest("get_task_row", "GET", "app_users", { query: { role: "eq.safety_admin", account_status: "eq.active", select: "user_id,fleet_scope", order: "user_id.asc", limit: 2000 } });
  return a.data?.find(x => x.fleet_scope === "*" || x.fleet_scope === fleet)?.user_id || null;
}

async function reviewRequestNotification(row, kind, text = null) {
  const submitted = kind === "submitted", key = submitted ? `notif:rr:${row.request_id}` : `notif:rra:${row.request_id}:${kind}`;
  try {
    const existing = await dbRequest("count_task_notifs", "GET", "notification_events", { query: { idempotency_key: `eq.${key}`, select: "notification_id", limit: 1 } });
    if (existing.data?.[0]) return { state: "recorded", notification_id: existing.data[0].notification_id };
    if (submitted && !["submitted", "checking", "awaiting_data_owner"].includes(row.status)) return { state: "not_needed" };
    if (process.env.IE_LOCAL_SOURCE_ONLY === "1") return { state: "pending", note: "业务已保存，提醒由持久发件箱处理。" };
    let target = null;
    if (submitted) target = await reviewRecipient(row.driver_id);
    else target = (await dbRequest("get_binding_target", "GET", "app_users", { query: { driver_id: `eq.${row.driver_id}`, role: "eq.driver", account_status: "eq.active", binding_verified: "eq.true", select: "user_id", limit: 1 } })).data?.[0]?.user_id;
    if (!target) return { state: "no_recipient" };
    const id = await notify(target, submitted ? "rr_submitted" : "rr_answered", row.request_id, text || `复核申请 ${row.request_id} 待处理。`, key, "review_request", "复核申请进展");
    return { state: "recorded", notification_id: id };
  } catch { return { state: "pending", note: "业务已保存，提醒尚未记录；非本地环境不保证后台自动恢复。" }; }
}

async function loadRR(id, asDriverId) {
  const q = { select: "request_id,driver_id,score_id,evidence_id,reason_code,description,status,review_note,reviewer_id,source_version,created_by,created_at,updated_at,idempotency_key", request_id: `eq.${id === "undefined" ? "__none__" : id}` };
  if (asDriverId) q.driver_id = `eq.${asDriverId}`;
  const { data } = await dbRequest("get_rr_row", "GET", "review_requests", { query: q });
  const row = data?.[0];
  if (!row) throw new HttpError(404, "not_found");
  return row;
}
async function ledQuery(row) {
  if (!row.evidence_id) return { data: [] };
  return dbRequest("list_resource", "GET", "deduction_ledger", { query: { ledger_id: `eq.${row.evidence_id}`, select: "ledger_id,gpsno,event_type,dimension,event_count,allocated_points,as_of_date,source_version" } });
}
async function assembleRR(row, adminView) {
  const snap = row.score_id ? await dbRequest("list_resource", "GET", "score_snapshots", { query: { score_id: `eq.${row.score_id}`, select: "score_id,gpsno,driver_id,safety_score,rank,risk_level,confidence_score,confidence_level,score_status,as_of_date,source_version" } }) : { data: [] };
  const led = await ledQuery(row);
  const tl = adminView ? await dbRequest("list_audit", "GET", "audit_logs", { query: { entity_id: `eq.${row.request_id}`, select: "audit_id,action,old_status,new_status,actor_id,occurred_at", order: "occurred_at.asc", limit: 30 } }) : { data: [] };
  return { request: row, snapshot: snap.data?.[0] || null, ledger: adminView ? led.data || [] : null, timeline: adminView ? tl.data || [] : null };
}
async function handleRRView(request, response, url, ctx, id) {
  const user = requireUser(ctx.principal);
  if (user.role === "driver") {
    requireVerifiedDriver(ctx.principal);
    const row = await loadRR(id, user.driver_id);
    const view = await assembleRR(row, false);
    view.timeline = null; view.ledger = null;
    return sendJson(response, 200, view);
  }
  if (!(ROLE_CAPABILITIES[user.role] || new Set()).has("review.score_challenge")) throw new HttpError(403, "forbidden");
  const row = await loadRR(id, null);
  await assertInScope(ctx.principal, { driverId: row.driver_id });
  sendJson(response, 200, await assembleRR(row, true));
}
async function handleRRAdvance(request, response, url, ctx, id) {
  const user = requireUser(ctx.principal);
  if (!(ROLE_CAPABILITIES[user.role] || new Set()).has("review.score_challenge")) throw new HttpError(403, "forbidden");
  const row = await loadRR(id, null);
  await assertInScope(ctx.principal, { driverId: row.driver_id });
  const body = await readBody(request);
  const next = String(body.status || "");
  const note = String(body.response_note || "").slice(0, 3000);
  if (!(RR_FLOW[row.status] || []).includes(next)) throw new HttpError(409, `rr_transition_${row.status}_to_${next}_invalid`);
  if (RR_NOTE_REQUIRED.includes(next) && !note.trim()) throw new HttpError(409, "response_note_required");
  const needsNotice = next === "answered" || next === "closed";
  let rrMsg = `复核申请 ${id} 状态：${next}。答复见“复核申请”页（站内演示通知）。`;
  if (needsNotice && body.template_ref) {
    try {
      const tr = await resolveTemplateForSend(body.template_ref, "review_answer", { driver_id: String(row.driver_id || ""), alert_id: "", event_date: null, evidence_type: String(row.reason_code || ""), review_note: note.slice(0, 300) });
      rrMsg = tr.body + "\n（模板 " + tr.template_key + ":v" + tr.version + "；站内演示通知）";
    } catch (e) { if (String(e?.message) === "template_not_usable") throw new HttpError(409, "template_not_approved_or_disabled"); throw e; }
  }
  const acct = needsNotice ? (await dbRequest("get_binding_target", "GET", "app_users", { query: { driver_id: `eq.${row.driver_id}`, role: "eq.driver", account_status: "eq.active", binding_verified: "eq.true", select: "user_id", limit: 1 } })).data?.[0] : null;
  const at = nowIso();
  const changed = await dbRequest("patch_rr_row", "PATCH", "review_requests", {
    query: { request_id: `eq.${id}`, status: `eq.${row.status}`, updated_at: row.updated_at ? `eq.${row.updated_at}` : "is.null" },
    body: { status: next, review_note: note || row.review_note, reviewer_id: user.user_id, updated_at: at,
      ...(process.env.IE_LOCAL_SOURCE_ONLY === "1" && needsNotice ? { reminder_target_user_id: acct?.user_id || null, reminder_text: rrMsg } : {}) },
    headers: { Prefer: "return=representation" },
  });
  if (!changed.data?.length) throw new HttpError(409, "review_request_version_conflict");
  const notification = needsNotice ? await reviewRequestNotification({ ...row, status: next }, next, rrMsg) : { state: "not_needed" };
  const auditId = await appendAudit(ctx.principal, `review_request.${next}`, "review_request", id, row.status, next, ctx.requestId);
  sendJson(response, 200, { ok: true, request_id: id, old_status: row.status, new_status: next, reviewer_id: user.user_id, at, audit_id: auditId, notification, driver_notified: notification.notification_id || null, note: "源数据问题→仅 awaiting_data_owner 并注明转数据负责人；本接口无评分写路径" });
}


// ---------- Section: round-12 additions (handoff/note/contact, account admin, notes summary, egress probe) ----------
async function handleAlertPatch(request, response, url, ctx, alertId, kind) {
  const user = requireUser(ctx.principal);
  const alert = await loadAlert(alertId);
  const body = await readBody(request);
  const at = nowIso();
  if (kind === "handoff") {
    const to = String(body.to_user_id || "").slice(0, 60);
    const tu = await dbRequest("get_binding_user", "GET", "app_users", { query: { user_id: `eq.${to}`, select: "user_id,role,account_status", limit: 1 } });
    const tr = tu.data?.[0];
    if (!tr || tr.account_status !== "active" || !["safety_admin", "team_leader"].includes(tr.role)) throw new HttpError(409, "handoff_target_invalid");
    await dbRequest("patch_alert_fields", "PATCH", "alerts", { query: { alert_id: `eq.${alertId}` }, body: { owner_user_id: to, updated_at: at }, headers: { Prefer: "return=minimal" } });
    const auditId = await appendAudit(ctx.principal, "alert.handoff", "alert", alertId, alert.owner_user_id, to, ctx.requestId);
    return sendJson(response, 200, { ok: true, alert_id: alertId, owner_user_id: to, audit_id: auditId });
  }
  if (kind === "note") {
    const note = String(body.note || "").trim().slice(0, 2000);
    if (!note) throw new HttpError(400, "bad_request");
    // 内部备注：只进审计（司机端无 case/audit 读通道，天然不可见）
    const auditId = await appendAudit(ctx.principal, "alert.note", "alert", alertId, alert.status, alert.status, ctx.requestId);
    await dbRequest("patch_alert_fields", "PATCH", "audit_logs", { query: { audit_id: `eq.${auditId}` }, body: { detail_json: JSON.stringify({ internal_note: note, visible_to: "safety_admin" }) }, headers: { Prefer: "return=minimal" } }).catch(() => {});
    return sendJson(response, 200, { ok: true, audit_id: auditId, note: "内部备注已入审计；司机端不可见" });
  }
  if (kind === "contact") {
    const when = String(body.next_contact_at || "").slice(0, 40);
    if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(when)) throw new HttpError(400, "bad_request");
    await dbRequest("patch_alert_fields", "PATCH", "alerts", { query: { alert_id: `eq.${alertId}` }, body: { due_at: when, updated_at: at }, headers: { Prefer: "return=minimal" } });
    const auditId = await appendAudit(ctx.principal, "alert.contact_set", "alert", alertId, alert.due_at || null, when, ctx.requestId);
    return sendJson(response, 200, { ok: true, next_contact_at: when, audit_id: auditId });
  }
  throw new HttpError(404, "not_found");
}

async function handleAdminUserCreate(request, response, url, ctx) {
  requireUser(ctx.principal);
  const body = await readBody(request);
  const username = String(body.username || "").trim().toLowerCase();
  const role = String(body.role || "");
  if (!/^[a-z0-9_.-]{3,32}$/.test(username) || !["safety_admin", "team_leader", "driver"].includes(role)) throw new HttpError(400, "bad_request");
  if (String(ctx.principal.user.fleet_scope || "*") !== "*" && role === "safety_admin") throw new HttpError(403, "cannot_grant_admin_in_scope"); // 受限管理员不能再铸造管理员
  const exist = await dbRequest("get_user_by_name", "GET", "app_users", { query: { username: `eq.${username}`, select: "user_id", limit: 1 } });
  if (exist.data?.length) throw new HttpError(409, "username_exists");
  const pw = randomBytes(9).toString("base64url");
  const salt = randomBytes(16);
  const keyHex = (await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 })).toString("hex");
  const userId = newId("u");
  const at = nowIso();
  await dbRequest("insert_resource", "POST", "app_users", {
    body: [{ user_id: userId, username, password_hash: `scrypt$16384$8$1$${salt.toString("hex")}$${keyHex}`, display_name: String(body.display_name || username).slice(0, 60), role, fleet_scope: role === "safety_admin" ? "*" : null, account_status: "active", binding_verified: false, created_at: at, updated_at: at, created_by: ctx.principal.user.user_id }],
    headers: { Prefer: "return=minimal" },
  });
  const auditId = await appendAudit(ctx.principal, "account.create", "app_user", userId, null, "active", ctx.requestId);
  sendJson(response, 201, { ok: true, user_id: userId, username, role, ...(body.reveal_password === true ? { initial_password: pw } : { initial_password: "(redacted——需一次性查看请传 reveal_password=true，本演示页面不渲染口令)" }), audit_id: auditId, note: "初始口令仅返回一次，请让使用者登录后自改（SM01 改密在后续轮次）" });
}

async function assertAccountScope(principal, target) {
  const u = principal.user; const scope = String(u.fleet_scope || "*");
  if (scope === "*" || u.role !== "safety_admin") return;
  if (target.user_id === u.user_id) return;
  const s = await fleetScopeSets(scope);
  const mine = target.role !== "safety_admin" && ((target.driver_id && s.drv.includes(String(target.driver_id))) || String(target.fleet_scope || "") === scope);
  if (!mine) { try { await appendAudit(principal, "account.scope_refused", "app_user", String(target.user_id), null, "refused_scope", principal.requestId); } catch {} throw new HttpError(403, "out_of_fleet_scope"); }
}
async function handleAdminUserEdit(request, response, url, ctx, userId) {
  requireUser(ctx.principal, "manage.accounts");
  const body = await readBody(request);
  const tu = await dbRequest("get_user_by_id", "GET", "app_users", { query: { user_id: `eq.${userId}`, select: "user_id,username,role,display_name,fleet_scope,driver_id,binding_verified,account_status", limit: 1 } });
  const tr = tu.data?.[0]; if (!tr) throw new HttpError(404, "not_found");
  await assertAccountScope(ctx.principal, tr);
  const patch = {}; const changed = {};
  if (body.display_name !== undefined) { const dn = String(body.display_name).slice(0, 60); if (!dn.trim()) throw new HttpError(400, "display_name_required"); patch.display_name = dn; changed.display_name = [tr.display_name, dn]; }
  if (body.fleet_scope !== undefined) { const fs = String(body.fleet_scope).trim(); if (!/^[\w.-]{1,40}$/.test(fs) && fs !== "*") throw new HttpError(400, "bad_fleet_scope");
    if (fs !== "*") { const fl = await dbRequest("drv_exists", "GET", "drivers", { query: { fleet_id: `eq.${fs}`, select: "fleet_id", limit: 1 } }); if (!fl.data?.length) throw new HttpError(409, "unknown_fleet"); }
    patch.fleet_scope = fs; changed.fleet_scope = [tr.fleet_scope, fs]; }
  if (body.driver_id !== undefined) {
    const dv = String(body.driver_id).trim();
    if (dv) {
      if (!tr.binding_verified) throw new HttpError(409, "unverified_identity_cannot_bind");
      const dr = await dbRequest("drv_exists", "GET", "drivers", { query: { driver_id: `eq.${dv}`, select: "driver_id,gpsno", limit: 1 } });
      if (!dr.data?.length) throw new HttpError(409, "driver_not_found");
      const act = await dbRequest("bind_active_check", "GET", "app_users", { query: { driver_id: `eq.${dv}`, account_status: `eq.active`, select: "user_id", limit: 5 } });
      const clash = (act.data || []).filter((x) => x.user_id !== userId);
      if (clash.length) throw new HttpError(409, "driver_already_bound_active");
    }
    patch.driver_id = dv || null; changed.driver_id = [tr.driver_id, dv || null]; }
  if (body.clear_binding === true) { patch.driver_id = null; patch.binding_verified = false; changed.driver_id = [tr.driver_id, null]; changed.binding_verified = [tr.binding_verified, false]; }
  if (!Object.keys(patch).length) throw new HttpError(400, "no_fields");
  await dbRequest("user_edit", "PATCH", "app_users", { query: { user_id: `eq.${userId}` }, body: { ...patch, updated_at: nowIso() }, headers: { Prefer: "return=minimal" } });
  const auditId = await appendAudit(ctx.principal, "account.edit", "app_user", userId, tr.account_status, tr.account_status, ctx.requestId, null, { changed, actor_scope: ctx.principal.user.fleet_scope || "*" });
  sendJson(response, 200, { ok: true, user_id: userId, changed, audit_id: auditId, note: "口令类字段永不经此路径（USER_PUBLIC_COLS 无 password_hash）" });
}
async function handleAdminUserStatus(request, response, url, ctx, userId) {
  requireUser(ctx.principal);
  const body = await readBody(request);
  const next = String(body.account_status || "");
  if (!["active", "disabled"].includes(next)) throw new HttpError(400, "bad_request");
  const tu = await dbRequest("get_binding_user", "GET", "app_users", { query: { user_id: `eq.${userId}`, select: "user_id,account_status,username", limit: 1 } });
  const tr = tu.data?.[0];
  if (!tr) throw new HttpError(404, "not_found");
  await assertAccountScope(ctx.principal, tr);
  if (tr.user_id === ctx.principal.user.user_id && next === "disabled") throw new HttpError(409, "cannot_disable_self");
  await dbRequest("patch_binding_fields", "PATCH", "app_users", { query: { user_id: `eq.${userId}` }, body: { account_status: next, updated_at: nowIso() }, headers: { Prefer: "return=minimal" } });
  await dbRequest("delete_session", "DELETE", "app_sessions", { query: { user_id: `eq.${userId}` } }).catch(() => {}); // 停用即踢会话
  const auditId = await appendAudit(ctx.principal, "account.status_change", "app_user", userId, tr.account_status, next, ctx.requestId);
  sendJson(response, 200, { ok: true, user_id: userId, account_status: next, audit_id: auditId, note: "会话已清除：被停用账号立即无法读取业务数据" });
}

async function handleNotesSummary(request, response, url, ctx) {
  const user = requireUser(ctx.principal);
  if (user.role === "driver") requireVerifiedDriver(ctx.principal);
  const unread = await dbRequest("count_my_notes", "GET", "notification_events", { query: { target_user_id: `eq.${user.user_id}`, read_at: "is.null", limit: 1 }, headers: { Prefer: "count=exact,return=minimal" } });
  const notes = parseCount(unread.rangeHeader) ?? (unread.data || []).length;
  let todo = 0; let todoKey = null;
  if (user.role === "driver") {
    const a = await dbRequest("count_my_notes", "GET", "interventions", { query: { driver_id: `eq.${user.driver_id || "__none__"}`, status: "eq.sent", limit: 1 }, headers: { Prefer: "count=exact,return=minimal" } });
    const b = await dbRequest("count_my_notes", "GET", "training_tasks", { query: { driver_id: `eq.${user.driver_id || "__none__"}`, status: "in.(assigned,in_progress,returned)", limit: 1 }, headers: { Prefer: "count=exact,return=minimal" } });
    todo = (parseCount(a.rangeHeader) ?? 0) + (parseCount(b.rangeHeader) ?? 0);
    todoKey = "待回应消息与待完成培训";
  } else {
    const a = await dbRequest("count_alerts", "GET", "alerts", { query: { status: "in.(pending_review,confirmed,sent,read)", limit: 1 }, headers: { Prefer: "count=exact,return=minimal" } });
    const b = await dbRequest("count_alerts", "GET", "training_tasks", { query: { status: "eq.submitted", limit: 1 }, headers: { Prefer: "count=exact,return=minimal" } });
    const c = await dbRequest("count_alerts", "GET", "review_requests", { query: { status: "in.(submitted,checking,awaiting_data_owner)", limit: 1 }, headers: { Prefer: "count=exact,return=minimal" } });
    todo = (parseCount(a.rangeHeader) ?? 0) + (parseCount(b.rangeHeader) ?? 0) + (parseCount(c.rangeHeader) ?? 0);
    todoKey = "案卷/待复核培训/待处理申请";
  }
  sendJson(response, 200, { unread_notes: notes, todo_count: todo, todo_label: todoKey });
}

async function handleNoteRead(request, response, url, ctx, notifId) {
  const user = requireUser(ctx.principal);
  if (user.role === "driver") requireVerifiedDriver(ctx.principal);
  const { data } = await dbRequest("count_my_notes", "GET", "notification_events", { query: { notification_id: `eq.${notifId}`, target_user_id: `eq.${user.user_id}`, select: "notification_id,read_at" } });
  const row = data?.[0];
  if (!row) throw new HttpError(404, "not_found");
  if (row.read_at) return sendJson(response, 200, { ok: true, idempotent_replay: true, read_at: row.read_at });
  const at = nowIso();
  const changed = await dbRequest("patch_rr_row", "PATCH", "notification_events", { query: { notification_id: `eq.${notifId}`, target_user_id: `eq.${user.user_id}`, read_at: "is.null" }, body: { read_at: at }, headers: { Prefer: "return=representation" } });
  const saved = changed.data?.[0] || (await dbRequest("count_my_notes", "GET", "notification_events", { query: { notification_id: `eq.${notifId}`, target_user_id: `eq.${user.user_id}`, select: "notification_id,read_at" } })).data?.[0];
  if (!saved?.read_at) throw new HttpError(409, "notification_version_conflict");
  sendJson(response, 200, { ok: true, notification_id: notifId, read_at: saved.read_at, idempotent_replay: !changed.data?.length });
}

async function handleMyNotes(request, response, url, ctx) {
  const user = requireUser(ctx.principal);
  if (user.role === "driver") requireVerifiedDriver(ctx.principal);
  const r = await dbRequest("count_my_notes", "GET", "notification_events", { query: { target_user_id: `eq.${user.user_id}`, select: "notification_id,source_entity_type,source_entity_id,type,title,content,read_at,created_at", order: "created_at.desc", limit: 50 } });
  sendJson(response, 200, { rows: r.data || [] });
}

async function handleEgressProbe(request, response, url, ctx) {
  requireUser(ctx.principal);
  if (ctx.principal.user.role !== "safety_admin") throw new HttpError(403, "forbidden");
  const target = process.env.QW_EGRESS_PROBE_URL || "";
  if (!/^https:\/\//.test(target)) return sendJson(response, 503, { error: "probe_not_configured", note: "平台未提供内置运行时模型端点。属主在 Page 环境变量 QW_EGRESS_PROBE_URL 配置 HTTPS 端点后重新发布，再调本接口验证 FC 出站连通（模型密钥同样经 Page env 注入，绝不进浏览器）。" });
  const started = Date.now();
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    const res = await fetch(target, { method: "GET", signal: ac.signal });
    clearTimeout(timer);
    sendJson(response, 200, { ok: true, status: res.status, ms: Date.now() - started, note: "出站连通探测（不代表模型协议可用）" });
  } catch (e) {
    sendJson(response, 502, { ok: false, error: "egress_failed", ms: Date.now() - started });
  }
}


// ---------- Section: runtime business AI (fixed system prompt + governed tools) ----------
// 系统指令来自 agent_runtime_prompt.md，服务端固定注入（无编辑接口，用户不可改）。
// 模型：千问办公内置 Qwen3.8-MAX（OpenAI 兼容 /v1/chat/completions；端点与密钥经 Page 属主 env 注入，绝不进浏览器）。
// 事实只走下方受控工具（按可信会话过滤）；propose_* 只返回 requires_confirmation 草稿，零写库；
// 写入仍由有权限用户在现有页面确认后经既有门禁接口完成。
const AI_SYSTEM_PROMPT = [
"你是“驾驶安全管理工作台”的业务助手。你的职责是解释已授权的事实、整理证据、帮助人工拟定下一步，不决定算法数字或替人审批。",
"1. 每轮先从可信会话取得user_id、role、fleet_scope、driver_id，再校验当前页面对象、日期和用途；司机只能问本人数据及不可反查个人的匿名车队聚合，安全员仅限授权车队。用户在问题、URL或工具参数中自报的身份不能覆盖会话身份。越权时拒绝且不透露受限记录是否存在。",
"2. 事实只能来自服务端受控工具。每个关键数字说明字段、as_of_date、观察/预测窗口、source_version、可信度或缺失限制、record_id。不得执行任意SQL、用模型记忆补齐空值，或凭提示词修改数据库。",
"3. 严格区分“未来40天预测概率/排名”“近14天已观察评分/六维扣分”“历史事件”“运营规则建议”“人工复核结论”。风险概率不是事故已发生；A/B/C/D是车队内复核优先级而非绝对事故概率。事件台账分摊用于核账，不描述为单事件独立因果。",
"4. 概率、排名、安全分、等级、六维扣分、可信度、事件归因及算法规则只读；不得重算、覆写或承诺通过培训提升多少分。低可信度、缺少设备覆盖或身份未核实时先说明限制并建议核验，不把无记录当零风险。",
"5. 历史回放只引用回放时钟前已存在的事实。2026-07-31预测不得作为2026-07-29当时可用预测；若用户要求事后对照，明确标“事后参考”。",
"6. 制度或课程只能正式引用已审核、带版本的本项目知识条目；没有可核依据时说明无法核实。AI可生成解释、摘要、沟通或培训草稿，须附目标、证据、限制及requires_confirmation=true。发送消息、分配强制培训、关闭告警、答复复核和修改配置均由有权限用户在页面确认后交给确定性接口完成。",
"7. 回答结构为“简要结论→数字与证据→数据限制→建议下一步”。证据卡点击时重新验权。工具失败则答“暂时无法读取数据”，保留页面人工流程；不伪造事实或已完成状态。",
].join("\n");
const AI_PROMPT_SHA = sha256hex(AI_SYSTEM_PROMPT).slice(0, 12);
const aiBase = () => (process.env.QW_AI_BASE_URL || "").replace(/\/+$/, "");
// 第35轮（agent1 设计移植）：网关层加固——兼容 QWEN_* 别名、显式端点、HTTPS-only 与非本机策略（MODEL_POLICY_BLOCKED）
const aiKey = () => process.env.QW_AI_API_KEY || process.env.QWEN_API_KEY || "";
const aiModel = () => process.env.QW_AI_MODEL || process.env.QWEN_MODEL || "qwen3.7-plus";
const aiEndpoint = () => {
  if (process.env.QWEN_CHAT_ENDPOINT) return String(process.env.QWEN_CHAT_ENDPOINT);
  const b = aiBase(); if (!b) return "";
  return b + (b.endsWith("/v1") ? "/chat/completions" : "/v1/chat/completions");
};
const aiPolicyOk = () => { try { const u = new URL(aiEndpoint()); return u.protocol === "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname); } catch { return false; } };
const aiAvailable = () => aiPolicyOk() && aiKey().length > 8;

async function aiQ(resource, params, principal) {
  const u = new URL("http://internal/?" + new URLSearchParams(params || {}));
  return listResource(principal, resource, u);
}
async function overviewCore(principal) {
  const metrics = [];
  for (const m of OVERVIEW_METRICS) {
    try {
      const r = await dbRequest("count_resource", "GET", m.table, { query: Object.assign({ select: m.query.select, limit: 1 }, m.query), headers: { Prefer: "count=exact,return=minimal" } });
      metrics.push({ key: m.key, label: m.label, count: parseCount(r.rangeHeader) });
    } catch { metrics.push({ key: m.key, label: m.label, count: null }); }
  }
  let asOf = null;
  try { const r = await dbRequest("list_resource", "GET", "score_snapshots", { query: { select: "as_of_date", order: "as_of_date.desc", limit: 1 } }); asOf = r.data?.[0]?.as_of_date || null; } catch {}
  return { dataImported: Boolean(asOf), asOfDate: asOf, metrics };
}
async function caseCore(alertId, principal) {
  const alert = await loadAlert(String(alertId).slice(0, 80));
  const iv = await dbRequest("get_intervention_row", "GET", "interventions", { query: { alert_id: `eq.${alert.alert_id}`, select: "intervention_id,status,sent_at,read_at,replied_at", order: "updated_at.asc" } });
  const tv = await dbRequest("get_alert_evidence", "GET", "training_tasks", { query: { alert_id: `eq.${alert.alert_id}`, select: "task_id,course_id,status" } });
  const ids = [alert.alert_id, ...(iv.data || []).map((x) => x.intervention_id)].map((x) => `"${x}"`).join(",");
  const t2 = await dbRequest("list_audit", "GET", "audit_logs", { query: { entity_id: `in.(${ids})`, select: "audit_id,action,old_status,new_status,occurred_at", order: "occurred_at.asc", limit: 40 } });
  return { alert, interventions: iv.data || [], trainings: tv.data || [], timeline: t2.data || [] };
}
function factPick(row, cols) { const o = {}; if (row) for (const c of cols) if (row[c] !== undefined) o[c] = row[c]; return o; }
async function ownGpsOf(principal) {
  const own = principal?.user?.driver_id; if (!own) return null;
  const r = await dbRequest("get_binding_target", "GET", "drivers", { query: { driver_id: `eq.${own}`, select: "gpsno", order: "mapping_end.desc", limit: 1 } });
  return r.data?.[0]?.gpsno || null;
}
const DENY = { status: "refused_no_scope", data: null, fact_refs: [], data_limitations: "会话身份不允许该数据；不透露受限记录是否存在" };

const AI_TOOLS = {
  async get_my_evaluation(a, p) {
    if (p.user.role !== "driver" || !p.user.driver_id) return DENY;
    const s = await aiQ("my.score", { limit: 2 }, p).catch(() => ({ rows: [] }));
    const h = await aiQ("my.score_history", { limit: 10 }, p).catch(() => ({ rows: [] }));
    const l0 = s.rows[0];
    return { status: l0 ? "ok" : "empty", as_of_date: l0?.as_of_date || null, source_version: l0?.source_version || null, data: { latest: hPick(l0), history: h.rows.map((x) => factPick(x, ["as_of_date", "safety_score", "risk_level", "confidence_level"])) }, fact_refs: s.rows.map((x) => "score:" + x.score_id), data_limitations: l0?.confidence_level === "low" ? "低可信度：建议先核验设备/数据覆盖" : null };
  },
  async get_driver_evaluation(a, p) {
    if (p.user.role === "driver") return AI_TOOLS.get_my_evaluation({}, p);
    const q = { limit: 2 };
    if (a.driver_id) q.driver_id = String(a.driver_id).slice(0, 60); else if (a.gpsno) q.gpsno = String(a.gpsno).slice(0, 40); else return { status: "bad_args", data: null, fact_refs: [], data_limitations: "需要 driver_id 或 gpsno" };
    const s = await aiQ("admin.score_snapshots", q, p).catch(() => ({ rows: [] }));
    const r0 = s.rows[0];
    return { status: r0 ? "ok" : "not_found_no_leak", as_of_date: r0?.as_of_date, source_version: r0?.source_version, source: "近14天观察", data: factPick(r0, ["driver_id", "gpsno", "safety_score", "rank", "risk_level", "confidence_score", "confidence_level", "score_change_7d", "top_reason_1", "primary_risk_dimension", "forecast_40d_risk_prob"]), fact_refs: s.rows.map((x) => "score:" + x.score_id), data_limitations: r0?.confidence_level === "low" ? "低可信度对象：先核验设备/数据" : null };
  },
  async get_fleet_summary(a, p) {
    if (p.user.role === "driver") {
      const h = await aiQ("my.score_history", { limit: 10 }, p).catch(() => ({ rows: [] }));
      return { status: "ok", data: { note: "司机端仅提供匿名聚合，不可反查个人", own_history_span: h.rows.length ? h.rows[0].as_of_date + "…" + h.rows[h.rows.length - 1].as_of_date : null }, fact_refs: [], data_limitations: "车队匿名分布待 overview 聚合端点开放" };
    }
    return { status: "ok", as_of_date: "2026-07-31", source_version: "snapshot_ffbc02143fcb", data: await overviewCore(p), fact_refs: [], data_limitations: "计数为真实库读数；未导入表显示空态" };
  },
  async get_risk_snapshot(a, p) {
    const gps = String(a.gpsno || "").slice(0, 40); if (!gps) return { status: "bad_args", data: null, fact_refs: [], data_limitations: "需要 gpsno" };
    if (p.user.role === "driver") { const g = await ownGpsOf(p); if (g !== gps) return DENY; }
    const r = await aiQ("admin.risk_snapshots", { gpsno: gps, limit: 2 }, p).catch(() => ({ rows: [] }));
    const r0 = r.rows[0];
    return { status: r0 ? "ok" : "not_found_no_leak", as_of_date: "2026-07-31", source_version: r0?.source_version, source: "未来40天预测", data: factPick(r0, ["gpsno", "risk_prob", "risk_rank", "as_of_date", "horizon_days", "source_version"]), fact_refs: r.rows.map((x) => "risk_snapshot:" + x.snapshot_id), data_limitations: "概率=预测非事故已发生；2026-07-29 回放时点此项只能作事后参考" };
  },
  async get_evidence(a, p) {
    const gps = String(a.gpsno || "").slice(0, 40);
    if (p.user.role === "driver") { const g = await ownGpsOf(p); if (!g || g !== gps) return DENY; }
    const q = { gpsno: gps, limit: 20 }; if (a.dimension) q.dimension = String(a.dimension).slice(0, 40);
    const l = await aiQ("admin.deduction_ledger", q, p).catch(() => ({ rows: [] }));
    return { status: l.rows.length ? "ok" : "empty", as_of_date: "2026-07-31", source: "历史事件台账分摊", data: l.rows.map((x) => factPick(x, ["ledger_id", "event_type", "dimension", "event_count", "allocated_points", "as_of_date", "source_version"])), fact_refs: l.rows.map((x) => "ledger_id:" + x.ledger_id), data_limitations: l.rows.length ? "台账分摊用于核账；非单事件独立因果效应" : "无台账行：可能无已记录事件或覆盖不足，不得推断零风险/有覆盖" };
  },
  async get_review_queue(a, p) {
    if (p.user.role === "driver") return DENY;
    const q = { limit: 25 }; if (a.gpsno) q.gpsno = String(a.gpsno).slice(0, 40); if (a.review_queue) q.review_queue = String(a.review_queue).slice(0, 40);
    const r = await aiQ("admin.review_queue", q, p).catch(() => ({ rows: [] }));
    return { status: r.rows.length ? "ok" : "empty", as_of_date: "2026-07-31", source_version: r.rows[0]?.source_version, data: r.rows.slice(0, 10).map((x) => factPick(x, ["queue_id", "gpsno", "safety_score", "risk_level", "forecast_40d_risk_prob", "review_queue", "confidence_level", "top_reason_1"])), fact_refs: r.rows.slice(0, 10).map((x) => "queue_id:" + x.queue_id), data_limitations: "队列=管理优先级排序，不产生新风险分" };
  },
  async get_alert(a, p) {
    if (p.user.role === "driver") return DENY;
    try {
      const cv = await caseCore(a.alert_id, p);
      return { status: "ok", alert_id: cv.alert.alert_id, data: { alert: factPick(cv.alert, ["alert_id", "gpsno", "driver_id", "rule_code", "rule_version", "evidence_id", "occurred_at", "status", "owner_user_id", "due_at", "close_reason"]), interventions: cv.interventions, trainings: cv.trainings, timeline_len: cv.timeline.length }, fact_refs: ["alert_id:" + cv.alert.alert_id, ...cv.interventions.map((i) => "intervention_id:" + i.intervention_id)], data_limitations: null };
    } catch { return { status: "not_found_no_leak", data: null, fact_refs: [], data_limitations: "记录不可得（越权与不存在同语义）" }; }
  },
  async get_interventions(a, p) {
    if (p.user.role === "driver") { const mi = await aiQ("my.interventions", { limit: 20 }, p).catch(() => ({ rows: [] })); return { status: mi.rows.length ? "ok" : "empty", data: mi.rows.map((x) => factPick(x, ["intervention_id", "status", "sent_text", "sent_at", "read_at", "replied_at", "reply_text"])), fact_refs: mi.rows.map((x) => "intervention_id:" + x.intervention_id), data_limitations: "演示绑定与站内通知，非外部渠道送达" }; }
    const q = { limit: 20 }; if (a.alert_id) q.alert_id = String(a.alert_id).slice(0, 80);
    const r = await aiQ("admin.interventions", q, p).catch(() => ({ rows: [] }));
    return { status: r.rows.length ? "ok" : "empty", data: r.rows.map((x) => factPick(x, ["intervention_id", "alert_id", "driver_id", "status", "sent_at", "read_at", "replied_at"])), fact_refs: r.rows.map((x) => "intervention_id:" + x.intervention_id), data_limitations: null };
  },
  async get_tasks(a, p) {
    if (p.user.role === "driver") { const my = await aiQ("my.trainings", { limit: 20 }, p).catch(() => ({ rows: [] })); return { status: my.rows.length ? "ok" : "empty", data: my.rows.map((x) => factPick(x, ["task_id", "course_id", "status", "due_at", "submitted_at", "review_note"])), fact_refs: my.rows.map((x) => "task_id:" + x.task_id), data_limitations: null }; }
    const q = { limit: 20 }; if (a.status) q.status = String(a.status).slice(0, 20);
    const r = await aiQ("admin.trainings", q, p).catch(() => ({ rows: [] }));
    return { status: r.rows.length ? "ok" : "empty", data: r.rows.map((x) => factPick(x, ["task_id", "driver_id", "course_id", "status", "due_at", "submitted_at", "reviewed_at"])), fact_refs: r.rows.map((x) => "task_id:" + x.task_id), data_limitations: "completed/reviewed 不宣称因果改善" };
  },
  async get_review_request(a, p) {
    if (p.user.role === "driver") { const my = await aiQ("my.review_requests", { limit: 10 }, p).catch(() => ({ rows: [] })); return { status: my.rows.length ? "ok" : "empty", data: my.rows.map((x) => factPick(x, ["request_id", "score_id", "status", "review_note"])), fact_refs: my.rows.map((x) => "request_id:" + x.request_id), data_limitations: null }; }
    const q = { limit: 10 }; if (a.request_id) q.request_id = String(a.request_id).slice(0, 60);
    const r = await aiQ("admin.review_requests", q, p).catch(() => ({ rows: [] }));
    return { status: r.rows.length ? "ok" : "empty", data: r.rows.map((x) => factPick(x, ["request_id", "driver_id", "status", "reason_code", "reviewer_id"])), fact_refs: r.rows.map((x) => "request_id:" + x.request_id), data_limitations: null };
  },
  async rules_read(a, p) {
    if (p.user.role !== "safety_admin") return DENY;
    try {
      const rows = await listRows("er_current", "evaluation_rules", { select: "dimension,dimension_name,weight,window_days,score_method,editable,source_version", order: "dimension.asc" });
      const sv = rows[0]?.source_version || "";
      return { status: "ok", data: { rules: rows.map((x) => ({ dimension: x.dimension, weight: x.weight, window_days: x.window_days, method: x.score_method, editable: x.editable, source_version: x.source_version })), drafts_excluded: "evaluation_rule_drafts 仅在『批准→生效』后才进入现行表；未生效草案永不作为参数" }, fact_refs: ["rules@" + sv], data_limitations: "现行生效口径（SM05 同源；权重可经草案→批准→生效更新为新 ruleset 版本；历史快照为各时点口径离线所算，不回算不重算）" };
    } catch { return { status: "tool_unavailable", data: null, fact_refs: [], data_limitations: "暂时无法读取数据" }; }
  },
  async knowledge_search(a, p) {
    try {
      const kwRaw = String(a.keyword || "").toLowerCase();
      const kw = kwRaw.replace(/[\\()%,.*^$]/g, " ");
      const official = await officialKnowledgeRows(p, kw);
      const { latest } = await knowledgeLatestMap();
      const draftish = [...latest.values()].filter((x) => x.review_status !== "approved" && (!kw || (String(x.title) + " " + x.article_id).toLowerCase().includes(kw))).slice(0, 6).map((x) => ({ article_id: x.article_id, version_no: x.version_no, title: x.title, review_status: x.review_status }));
      if (!official.length) return { status: "no_official_knowledge", data: { non_official_visible_as_draft_only: draftish }, fact_refs: [], data_limitations: "无 approved 正式知识版本可引用；下列为草案/待审条目，仅可陈述存在性与审核状态，不得作为正式制度、已批准建议或评分依据引用" };
      return { status: "ok", data: { official: official.map((x) => ({ article_id: x.article_id, version_no: x.version_no, title: x.title, dimension: x.dimension, source_note: x.source_note, version: x.version })), non_official_visible_as_draft_only: draftish }, fact_refs: official.map((x) => "knowledge:" + x.article_id + "." + x.version_no), data_limitations: "正式引用仅限 approved 最新版本（含版本号）；草案/待审/停用不构成正式依据" };
    } catch { return { status: "tool_unavailable", data: null, fact_refs: [], data_limitations: "暂时无法读取数据" }; }
  },
  async propose_intervention(a, p) {
    if (p.user.role !== "safety_admin") return DENY;
    let cv; try { cv = await caseCore(a.alert_id, p); } catch { return { status: "not_found_no_leak", data: null, fact_refs: [], data_limitations: "案卷不可得（越权与不存在同语义）" }; }
    const al = cv.alert;
    let sc = []; try { sc = (await aiQ("admin.score_snapshots", { gpsno: String(al.gpsno), limit: 1 }, p)).rows; } catch {}
    const s0 = sc[0] || {};
    const low = String(s0.confidence_level || "") === "low";
    const tone = String(a.tone || "standard").slice(0, 20);
    const opener = low ? "【核验优先】该对象近14天可信度为 low，建议先完成设备与数据覆盖核验再讨论行为结论；" : "";
    const draft = `${opener}您好：车辆${al.gpsno}（司机${al.driver_id || "—"}）进入${al.rule_code}复核（证据 ${al.evidence_id}，事实日期 ${al.occurred_at}；近14天安全分 ${s0.safety_score ?? "见案卷"}，等级 ${s0.risk_level ?? "—"}，可信度 ${s0.confidence_level ?? "—"}）。${tone==="gentle"?"请方便时说明当日行车情况并回复本消息。":"请说明当日行车情况并于24小时内回复。"}【AI 草稿：未经确认不会发送】`;
    const limitations = [ "草稿不构成送达；发送需安全员在 RM03 点击确认并写 sent_text/sent_at", low ? "低可信度：先设备/数据核验，禁止自动奖惩或惩罚性课程" : "数值均来自只读快照（record_id=snapshot/score）" ];
    return { status: "draft", requires_confirmation: true, draft_action: { kind: "intervention", alert_id: al.alert_id, driver_id: al.driver_id, draft_text: draft, tone, facts: { alert: al.alert_id, evidence_id: al.evidence_id, rule: `${al.rule_code}@${al.rule_version}`, score_id: s0.score_id || null, safety_score: s0.safety_score ?? null, risk_level: s0.risk_level ?? null, confidence_level: s0.confidence_level ?? null, as_of_date: s0.as_of_date || null, source_version: s0.source_version || null }, fill_to: { form: "rm3_draft", route: `#/rm-alerts?alert_id=${al.alert_id}`, alert_id: al.alert_id, draft_text: draft, note: "填入 RM03 草稿表单：可逐项编辑；保存草稿仅建 draft 状态，确认发送才写正式" } }, fact_refs: ["alert_id:" + al.alert_id, "queue_id:" + al.evidence_id, ...(s0.score_id ? ["score:" + s0.score_id] : [])], data_limitations: limitations.join("；") };
  },
  async propose_training(a, p) {
    if (p.user.role !== "safety_admin") return DENY;
    const drv = String(a.driver_id || "").slice(0, 60);
    const cs = await aiQ("admin.training_courses", { limit: 10 }, p).catch(() => ({ rows: [] }));
    let sc = []; try { sc = (await aiQ("admin.score_snapshots", { driver_id: drv, limit: 1 }, p)).rows; } catch {}
    const s0 = sc[0] || {};
    let opsDays = 7; try { const oc = await dbRequest("get_config_row", "GET", "operation_config", { query: { config_id: "eq.training_start_days", select: "value", limit: 1 } }); opsDays = Number(oc.data?.[0]?.value) || 7; } catch {}
    const dueAt = new Date(Date.now() + opsDays * 86400000).toISOString().slice(0, 10);
    const approved = (cs.rows || []).filter(x => x.content_status === "approved");
    const low = String(s0.confidence_level || "") === "low";
    const alertId = String(a.alert_id || "").slice(0, 80);
    const mp3 = await loadMandatePolicy(); const lvl3 = mp3 ? String(s0.risk_level || "") : ""; const mandSug = Boolean(mp3 && lvl3 && mp3.policy[lvl3] === "mandatory"); const mandNote = mp3 && lvl3 ? `现行映射v${mp3.config_version}: ${lvl3}=${mp3.policy[lvl3]}` : "无等级映射配置（缺省非强制）";
    const candidates = approved.map(c => ({ course_id: c.course_id, content_status: "approved", title: c.title }));
    const draft_summary = { mandatory_suggested: mandSug, mandate_policy: mandNote, kind: "training", driver_id: drv, course_id: candidates[0]?.course_id || null, goal: s0.primary_risk_dimension ? `结合只读事实（score_id ${s0.score_id}：${s0.top_reason_1 || s0.primary_risk_dimension}）完成课程短路径：事实回顾→核心知识→情境问题→本人行动计划→反馈` : "结合已核实证据制定短路径（当前无该司机本人评分快照事实）", due_at: dueAt, mandatory: false, alert_id: alertId || null, facts: { score_id: s0.score_id || null, as_of_date: s0.as_of_date || null, source_version: s0.source_version || null }, fill_to: { form: "tr2", route: "#/tr-create", driver_id: drv, course_id: candidates[0]?.course_id || null, goal_candidates: candidates, due_at: dueAt, mandatory: false, alert_id: alertId || null, note: "填入 TR02：仅 approved 课程可提交；点击“确认分配”前不写 training_tasks" } };
    return { status: "draft", requires_confirmation: true, draft_action: { ...draft_summary }, fact_refs: [...(cs.rows || []).map(x => "course:" + x.course_id + "@" + x.content_status), ...(s0.score_id ? ["score:" + s0.score_id] : [])], data_limitations: (low ? "低可信度缺行为证据：优先设备/数据核验，不建议惩罚性课程；" : "") + (candidates.length ? `可分配候选=${candidates.map(c=>c.course_id).join("、")}；未审核课程提交将被 409 course_not_approved；分配确认走 TR02 原按钮` : "当前无 approved 课程：不可正式分配，先由团队完成 TR05 人工审核") };
  },
  async action_preplan(a, p) {
    if (p.user.role === "driver") return DENY;
    const gps = String(a.gpsno || "").slice(0, 40);
    let row = {}; try { row = ((await aiQ("admin.review_queue", { gpsno: gps, limit: 1 }, p)).rows || [])[0] || {}; } catch {}
    const low = row.confidence_level === "low";
    return { status: "preplan_only", requires_confirmation: true, draft_action: { paths: [
      { path: "① 先设备/数据核验", applies_if: low ? "成立：可信度 low" : "低优先：可信度不低", creates: "data_verification 待办案卷（人工点击）", does_not_create: "惩罚/培训/新分值" },
      { path: "② 先沟通干预", applies_if: "alert 已confirmed 且司机有有效绑定", creates: "干预草稿→确认发送→sent+站内通知", does_not_create: "AI自动发送" },
      { path: "③ 分配已审核课程", applies_if: "存在 approved 课程+绑定核实", creates: "training_task assigned", does_not_create: "未审核课分配；低可信不转惩罚培训" }], gpsno: gps, queue_row: factPick(row, ["queue_id", "review_queue", "confidence_level", "risk_level"]) }, fact_refs: row.queue_id ? ["queue_id:" + row.queue_id] : [], data_limitations: "纯预演：未写入任何数据库记录；执行需页面确认" };
  },
  async get_root_causes(a, p) {
    if (p.user.role === "driver") return DENY;
    try {
      const out = await computeRootCauses(p, String(a.cohort || "cd") === "d" ? "d" : "cd");
      if (out.data_status !== "ok") return { status: "empty", data: out, fact_refs: [], data_limitations: out.note || "无数据" };
      const refs = [...out.dimensions.slice(0, 3).map((x) => "ledger_dim:" + x.dimension), ...out.top_objects.slice(0, 3).map((x) => x.score_id ? "score:" + x.score_id : "queue:" + x.gpsno)];
      return { status: "ok", as_of_date: out.as_of_date, source_version: out.source_version, data: { cohort: out.cohort, cohort_count: out.cohort_count, pool_avg: out.pool_avg, low_conf_in_pool: out.low_conf_in_pool, dimensions: out.dimensions.slice(0, 6), event_types: out.event_types.slice(0, 8), top_objects: out.top_objects.slice(0, 5), ruleset_source_version: out.ruleset_source_version }, fact_refs: refs.slice(0, 10), data_limitations: out.note };
    } catch { return { status: "tool_unavailable", data: null, fact_refs: [], data_limitations: "暂时无法读取数据" }; }
  },
};
function hPick(l0) { return l0 ? { safety_score: l0.safety_score, rank: l0.rank, risk_level: l0.risk_level, confidence_level: l0.confidence_level, confidence_score: l0.confidence_score, score_change_7d: l0.score_change_7d, top_reason_1: l0.top_reason_1, forecast_40d_risk_prob: l0.forecast_40d_risk_prob, as_of_date: l0.as_of_date, window: (l0.window_start || "") + "→" + (l0.as_of_date || ""), source_version: l0.source_version, score_id: l0.score_id } : null; }
const AI_TOOL_SCHEMAS = [
  ["get_my_evaluation", "读取当前登录司机本人近14天评分与历史（无参数；服务端会话决定）", {}],
  ["get_driver_evaluation", "管理员读取指定司机本人评分", { driver_id: "string", gpsno: "string" }],
  ["get_fleet_summary", "管理员车队总览真实计数/分布；司机仅见说明性聚合限制", {}],
  ["get_risk_snapshot", "未来40天预测快照（gpsno；司机仅限本人车辆）", { gpsno: "string" }],
  ["get_evidence", "扣分台账证据（gpsno；司机仅本人车）", { gpsno: "string", dimension: "string" }],
  ["get_review_queue", "复核队列（管理员）", { gpsno: "string", review_queue: "string" }],
  ["get_alert", "案卷详情+时间轴（管理员）", { alert_id: "string" }],
  ["get_interventions", "干预消息（管理员按alert；司机=本人）", { alert_id: "string" }],
  ["get_tasks", "培训任务（管理员；司机=本人）", { status: "string" }],
  ["get_review_request", "复核申请（管理员；司机=本人）", { request_id: "string" }],
  ["knowledge_search", "正式引用仅返回 approved 最新版本（含版本号）；待审/草案/停用只能陈述存在，不得作为正式制度引用", { keyword: "string" }],
  ["rules_read", "读取现行冻结 evaluation_rules 权重/窗口（只读，草案排除）", {}],
  ["propose_intervention", "生成沟通草稿（requires_confirmation，零写库）", { alert_id: "string", tone: "string" }],
  ["propose_training", "生成培训草稿（校验课程审核态；零写库）", { driver_id: "string" }],
  ["action_preplan", "三种管理路径并排预演（未写入）", { gpsno: "string" }],
  ["get_root_causes", "车队高风险对象根因聚合（台账分摊口径，结构性归因非因果；管理员）", { cohort: "string" }],
].map(([name, description, props]) => ({ type: "function", function: { name, description, parameters: { type: "object", properties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, { type: v }])) , required: [] } } }));

// ===== 第35轮：agent1 式引擎升级（源自 IE-Agent codex/agent1-backend-external-models 的机制移植） =====
// ①技能路由（skills/registry.routeSkill 思想）：按问题语义选择“技能指令”，引导工具组合与回答结构；
//   技能是软引导与消费预算，不是安全边界——越权仍由 ROLE_CAPABILITIES/listResource/工具内白名单强制。
// ②工具契约（contracts/agent-contracts.json 思想）：入参枚举/长度白名单+夹紧（clamp 而非硬拒，模型错参降级为缺省）。
// ③幂等重放（AgentRuntime.#requests 思想）：client_request_id + 内容哈希；同键同问=回放原响应，同键异问=409。
// ④验权回执（EvidenceVerifier 思想）：证据卡带 verification_id（5 分钟、属主绑定、LRU 1000），重验时按当前会话再授权。
const AI_SKILLS = [
  { id: "case-followup-review", title: "案卷跟进与复核进度", tools: ["get_alert", "get_interventions", "get_tasks", "get_review_request", "get_driver_evaluation"],
    rx: /复核|进度|处理到哪|还差什么|跟进|跟到|回复|异议|申诉|闭环/,
    instructions: "以 alert/review_request 为主线用只读工具串联真实时间轴；区分“等待司机/等待复核/已关闭”；下一步给页面入口，不替人工下结论，不宣称已完成处置；司机角色仅本人记录。" },
  { id: "personalized-training", title: "培训与课程", tools: ["get_tasks", "get_driver_evaluation", "propose_training", "knowledge_search"],
    rx: /培训|课程|学习|测验|练习|考试|分配.*课|考核|答题/,
    instructions: "仅 approved 课程可进分配链（未审核分配服务端 409）；propose_training 产出 requires_confirmation 草稿并在 TR02 人工确认；不承诺提升多少分、不宣称已完成学习；司机问本人任务用 get_tasks。" },
  { id: "risk-intervention", title: "沟通与干预草稿", tools: ["get_alert", "get_driver_evaluation", "get_interventions", "propose_intervention", "action_preplan"],
    rx: /沟通|干预|提醒|催办|起草|拟.*(消息|话术|通知)|发.*消息|发.*提醒/,
    instructions: "先 get_alert 核案卷状态与前提（confirmed 才可建草稿；closed 案卷按真实状态说明不可再处置），再 propose_intervention 产出草稿；绝不宣称已发送/已送达；低可信度先核验后沟通；发送由安全员在 RM03 独立确认。" },
  { id: "fleet-safety-triage", title: "车队分析与待办", tools: ["get_fleet_summary", "get_review_queue", "get_driver_evaluation", "get_root_causes", "knowledge_search"],
    rx: /车队|整体|大盘|先处理谁|先关注谁|优先.*(司机|对象|处理)|周报|总览|多少.*(人|车)|根因|原因.*(集中|分布)/,
    instructions: "先 get_fleet_summary 取真实计数与分布；问'为什么高风险对象集中/根因'时用 get_root_causes（台账分摊的结构性归因，需同步引用其限制声明）；具体对象再 get_review_queue/get_driver_evaluation；排序只决定先看谁，不重排不造队列；待办=对象+原因+证据+下一步入口；司机角色只允许匿名聚合结论，不得输出任何他人明细。" },
  { id: "explain-safety-score", title: "评分与预测解释", tools: ["get_my_evaluation", "get_driver_evaluation", "get_risk_snapshot", "get_evidence", "rules_read", "knowledge_search"],
    rx: /评分|扣分|为什么.*(分|降|差|高)|六维|可信度|预测|概率|排名|等级|安全分/,
    instructions: "先取本人/指定司机评分证据包（get_my_evaluation 或 get_driver_evaluation），按需补 get_risk_snapshot 与 get_evidence；14天评分=已观察行为，40天概率=复合预测，可信度=数据支持程度；台账/IMU 分摊不作单事件因果；无对比快照不插值；给管理者的核查步骤与给司机的改善建议分列。" },
];
function routeSkill(message, role, page) {
  const s = String(message || "").slice(0, 400);
  for (const k of AI_SKILLS) if (k.rx.test(s)) return k;
  if (role === "driver" && /my-|driver-|ev04|rm04|tr04/.test(String(page || ""))) return AI_SKILLS.find((x) => x.id === "personalized-training");
  return AI_SKILLS[AI_SKILLS.length - 1];
}
const AI_TOOL_CONTRACTS = {
  get_my_evaluation: {},
  get_driver_evaluation: { driver_id: { t: "s", max: 60 }, gpsno: { t: "s", max: 40 } },
  get_fleet_summary: {},
  get_risk_snapshot: { gpsno: { t: "s", max: 40, req: true } },
  get_evidence: { gpsno: { t: "s", max: 40, req: true }, dimension: { t: "enum", vals: ["history", "fatigue_distraction", "driving_stability", "road_rule", "management", "imu_evidence"] } },
  get_review_queue: { gpsno: { t: "s", max: 40 }, review_queue: { t: "enum", vals: ["priority_review", "behavior_coaching", "prediction_review", "data_quality_review", "routine"] } },
  get_alert: { alert_id: { t: "s", max: 80, req: true } },
  get_interventions: { alert_id: { t: "s", max: 80 } },
  get_tasks: { status: { t: "enum", vals: ["assigned", "in_progress", "submitted", "reviewed", "returned", "observation", "interview", "completed"] } },
  get_review_request: { request_id: { t: "s", max: 60 } },
  knowledge_search: { keyword: { t: "s", max: 60 } },
  rules_read: {},
  propose_intervention: { alert_id: { t: "s", max: 80, req: true }, tone: { t: "enum", vals: ["standard", "gentle"] } },
  propose_training: { driver_id: { t: "s", max: 60, req: true }, alert_id: { t: "s", max: 80 } },
  action_preplan: { gpsno: { t: "s", max: 40 } },
  get_root_causes: { cohort: { t: "enum", vals: ["cd", "d"] } },
};
function clampToolArgs(name, raw) {
  const c = AI_TOOL_CONTRACTS[name];
  if (!c) return {};
  const out = {};
  for (const [k, spec] of Object.entries(c)) {
    const v = raw ? raw[k] : undefined;
    if (v === undefined || v === null || v === "") continue;
    if (spec.t === "s") out[k] = String(v).slice(0, spec.max || 60);
    else if (spec.t === "enum") { const s0 = String(v); if ((spec.vals || []).includes(s0)) out[k] = s0; }
  }
  return out;
}
const AI_TOOL_BUDGET = 8; // 每轮工具执行预算（agent1 max_tool_calls_per_run 思想）
const AI_CHAT_REPLAYS = new Map();
const AI_CHAT_REPLAY_TTL = 600000;
const AI_VERIFICATIONS = new Map();
const AI_VERIFICATION_TTL = 300000;
function aiReplayKey(user, rid) { return String(user?.user_id || "?") + ":" + String(rid || ""); }
function aiSweepMaps() {
  const now = Date.now();
  for (const [k, v] of AI_CHAT_REPLAYS) if (now - v.at > AI_CHAT_REPLAY_TTL) AI_CHAT_REPLAYS.delete(k);
  for (const [k, v] of AI_VERIFICATIONS) if (now - v.at > AI_VERIFICATION_TTL) AI_VERIFICATIONS.delete(k);
  while (AI_VERIFICATIONS.size > 1000) AI_VERIFICATIONS.delete(AI_VERIFICATIONS.keys().next().value);
  while (AI_CHAT_REPLAYS.size > 500) AI_CHAT_REPLAYS.delete(AI_CHAT_REPLAYS.keys().next().value);
}
function aiVerRegister(user, ref, page) {
  aiSweepMaps();
  const id = newId("ver");
  // user 可信来源：兼容 principal 与 principal.user 两种入参（属主键=app_users.user_id）
  AI_VERIFICATIONS.set(id, { owner: user?.user?.user_id || user?.user_id || "?", ref: String(ref).slice(0, 120), page: String(page || "").slice(0, 60), at: Date.now() });
  return id;
}

let AI_LAST_UPSTREAM_DETAIL = "";
async function aiUpstreamOnce(body, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms || 100000);
  try {
    if (!aiPolicyOk()) throw new HttpError(503, "ai_policy_blocked"); // 端点必须是外部 HTTPS（agent1 MODEL_POLICY_BLOCKED 同语义）
    const res = await fetch(aiEndpoint(), { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + aiKey(), "accept": "application/json" }, body: JSON.stringify(body), signal: ac.signal });
    const txt = await res.text().catch(() => "");
    AI_LAST_UPSTREAM_DETAIL = String(txt || "").slice(0, 300);
    if (txt.length > 200000) throw new HttpError(502, "ai_upstream_invalid_output"); // agent1: 响应超限=无效输出
    let j = {}; try { j = JSON.parse(txt || "{}"); } catch {}
    if (!res.ok) { console.error("AI_UPSTREAM_DETAIL", res.status, txt.slice(0, 300)); throw new HttpError(502, "ai_upstream_error"); }
    return j;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, "ai_upstream_error");
  } finally { clearTimeout(timer); }
}
async function aiUpstream(body) {
  // 第36轮：qwen3.7 系默认思考模式单次调用 30-40s，公网网关会超时——统一 enable_thinking:false（实测秒级返回）；
  // 三段容错改为 60s/110s（原首段 8s 对非流式必失败纯属浪费）；若网关不认 enable_thinking 参数则自动去参重试一次。
  const attempts = [60000, 110000];
  let last = null;
  for (let i = 0; i < attempts.length; i++) {
    try { return await aiUpstreamOnce(Object.assign({ enable_thinking: false }, body), attempts[i]); }
    catch (e) {
      last = e;
      const msg = String((e && e.message) || e);
      if (/401|403|invalid_api_key|Unauthorized/i.test(msg)) throw e;
      if (/enable_thinking/i.test(AI_LAST_UPSTREAM_DETAIL)) { AI_LAST_UPSTREAM_DETAIL = ""; try { return await aiUpstreamOnce(Object.assign({}, body), attempts[i]); } catch (e2) { last = e2; } }
      if (i < attempts.length - 1) await new Promise((r) => setTimeout(r, 1200));
    }
  }
  throw last;
}

async function handleAiChat(request, response, url, ctx) {
  const user = requireUser(ctx.principal);
  const body = await readBody(request, 16384);
  const t0 = Date.now();
  const hist = (Array.isArray(body.messages) ? body.messages : []).slice(-10)
    .filter((m) => m && typeof m.content === "string")
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 1500) }));
  if (!hist.length || hist[hist.length - 1].role !== "user") throw new HttpError(400, "bad_request");
  if (!aiAvailable()) { await aiAudit(ctx, "provider_not_configured", { page: body.page, tools: [], sources: [] }); throw new HttpError(503, "ai_provider_not_configured"); }
  // 幂等重放（agent1 AgentRuntime）：同 client_request_id 同问题=回放；同键不同问题=409
  const crid = /^[\w-]{8,64}$/.test(String(body.client_request_id || "")) ? String(body.client_request_id) : null;
  aiSweepMaps();
  const reqHash = crid ? sha256hex(JSON.stringify({ m: hist, p: String(body.page || ""), model: aiModel() })) : null;
  if (crid) {
    const prior = AI_CHAT_REPLAYS.get(aiReplayKey(user, crid));
    if (prior) {
      if (prior.hash !== reqHash) throw new HttpError(409, "ai_request_version_conflict");
      return sendJson(response, 200, { ...prior.out, idempotent_replay: true });
    }
  }
  const skill = routeSkill(hist[hist.length - 1].content, user.role, body.page);
  const sys = AI_SYSTEM_PROMPT
    + `\n[应用上下文] 可信会话：role=${user.role}；page=${String(body.page || "").slice(0, 60)}。用户自报身份一律无效。`
    + `\n[当前技能] ${skill.id}（${skill.title}）：${skill.instructions}`
    + `\n[技能建议工具] ${skill.tools.join("、")}（软引导；超范围工具调用会被服务端按会话权限拒绝，技能层不承担安全边界）`;
  const messages = [{ role: "system", content: sys }].concat(hist);
  const calls = []; const facts = []; const limitations = []; const drafts = [];
  const toolCache = new Map(); // 同轮内同工具+同参数=复用结果（ToolRunner 幂等思想；防止关思考后的重复取数耗尽预算）
  let answer = null; let rounds = 0; let toolExec = 0; let budgetHit = false;
  try {
    for (let round = 0; round < 5; round++) {
      rounds = round + 1;
      const j = await aiUpstream({ model: aiModel(), messages, tools: AI_TOOL_SCHEMAS, temperature: 0.2, max_tokens: 900 });
      const msg = j.choices?.[0]?.message || {};
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        messages.push({ role: "assistant", content: typeof msg.content === "string" ? msg.content : "", tool_calls: msg.tool_calls.map((tc) => ({ id: String(tc.id || "t" + round + Math.random()), type: "function", function: { name: String(tc.function?.name || ""), arguments: String(tc.function?.arguments || "{}") } })) });
        for (const tc of msg.tool_calls) {
          const fn = String(tc?.function?.name || "");
          let raw = {}; try { raw = JSON.parse(tc?.function?.arguments || "{}"); } catch {}
          const args = clampToolArgs(fn, raw); // 工具契约：枚举/长度白名单+夹紧
          const cacheKey = fn + "|" + JSON.stringify(args);
          let out;
          if (toolCache.has(cacheKey)) out = toolCache.get(cacheKey);
          else if (toolExec >= AI_TOOL_BUDGET) { out = { status: "tool_budget_exceeded", data: null, fact_refs: [], data_limitations: "本轮工具调用已达预算上限：请基于已取得的事实回答" }; budgetHit = true; }
          else if (AI_TOOLS[fn]) { toolExec++; try { out = await AI_TOOLS[fn](args, ctx.principal); } catch { out = { status: "tool_error", data: null, fact_refs: [], data_limitations: "暂时无法读取数据" }; } toolCache.set(cacheKey, out); }
          else out = { status: "unknown_tool", data: null, fact_refs: [], data_limitations: null };
          calls.push({ name: fn, toolId: tc.id, out });
          for (const f2 of out.fact_refs || []) facts.push(f2);
          if (out.data_limitations) limitations.push(out.data_limitations);
          if (out.requires_confirmation && out.draft_action) drafts.push({ tool: fn, requires_confirmation: true, ...out.draft_action, limitations: out.data_limitations || null });
          messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(out).slice(0, 7000) });
        }
        continue;
      }
      answer = String(msg.content || "").slice(0, 4000); break;
    }
  } catch (e) {
    if (!(e instanceof HttpError)) console.error("AI_DEBUG", String(e && e.stack || e).slice(0, 500));
    const state = e instanceof HttpError && e.code === "ai_upstream_error" ? "upstream_error" : e instanceof HttpError && e.code === "ai_policy_blocked" ? "policy_blocked" : "chat_internal_error";
    await aiAudit(ctx, state, { page: body.page, tools: calls.map((c) => ({ name: c.name, status: c.out?.status, refs: (c.out?.fact_refs || []).length })), sources: [], rounds, skill: skill.id });
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, "chat_internal_error");
  }
  if (answer == null) answer = (budgetHit ? "本轮工具调用达到预算上限，请基于已取得证据继续或缩小问题。" : "本轮推理步数达到上限：请缩小问题；") + "人工流程不受影响（未写入任何数据）。";
  const refused = calls.filter((c) => c.out?.status === "refused_no_scope").length;
  const okFacts = calls.filter((c) => ["ok", "draft", "preplan_only", "preplan_only_not_written", "empty", "not_found_no_leak"].includes(c.out?.status === "empty" || c.out?.status === "not_found_no_leak" ? "empty" : c.out?.status)).length;
  const deniedOnly = refused > 0 && new Set(facts).size === 0;
  const partialDeny = refused > 0 && new Set(facts).size > 0;
  const state = calls.length === 0 ? "answered_no_tools" : deniedOnly ? "refused_no_scope" : partialDeny ? "answered_partial_refused" : drafts.length ? "draft_returned" : new Set(facts).size ? "answered_with_facts" : "answered_no_facts";
  const cards = collectCardsSafe(calls).map((c) => ({ ...c, verification_id: aiVerRegister(ctx.principal, c.ref, body.page) })); // 验权回执：5分钟内可凭 id 重验（EvidenceVerifier 思想）
  const aiCallId = await aiAudit(ctx, state, { page: body.page, tools: calls.map((c) => ({ name: c.name, status: c.out?.status, refs: (c.out?.fact_refs || []).length })), sources: [...new Set(facts)].slice(0, 16), has_draft: drafts.length > 0, rounds, skill: skill.id });
  const out = { ok: true, ai_call_id: aiCallId, result_state: state,
    answer: answer + (drafts.length ? "\n\n【含待确认草稿：任何“发送/分配/关闭/改配置”必须由有权限人员在页面确认后走业务接口写入，AI 不写库】" : ""),
    evidence_cards: cards, citations: [...new Set(facts)].slice(0, 40), data_limitations: [...new Set(limitations)],
    draft_preview: drafts.length ? drafts : null, requires_confirmation: drafts.length > 0,
    meta: { prompt_version: AI_PROMPT_SHA, model: aiModel(), engine: "agent1-inspired", skill: skill.id, skill_title: skill.title, tool_calls: calls.length, rounds, duration_ms: Date.now() - t0, auth: "server_session", write: "none_from_ai", audit: aiCallId ? "audit_logs#ai.chat" : "audit_write_failed" } };
  if (crid && reqHash) AI_CHAT_REPLAYS.set(aiReplayKey(user, crid), { hash: reqHash, at: Date.now(), out });
  sendJson(response, 200, out);
}
function collectCardsSafe(calls) {
  const seen = new Set(); const cards = [];
  for (const { name, out } of calls) { for (const c of cardsFromTool(name, out)) { if (!seen.has(c.ref) && cards.length < 10) { seen.add(c.ref); cards.push(c); } } }
  return cards;
}
// ===== R17：全局搜索 / SM05 规则草案 / SM06 知识管理 =====
const KN_COLS = "article_id,version_no,title,dimension,content,source_note,review_status,applicable_role,version,created_by,reviewed_by,reviewed_at,updated_at";
function cleanQuery(raw, max = 40) {
  const s = String(raw || "").trim().slice(0, max);
  const safe = s.replace(/[\\()%,.*^$]/g, " ").replace(/\s+/g, " ").trim();
  return safe;
}
async function listRows(op, table, query) {
  const q0 = query && query.query ? query.query : query;
  const q = Object.fromEntries(Object.entries(q0).filter(([, v]) => v !== undefined && v !== null));
  const { data } = await dbRequest(op, "GET", table, { query: q });
  return data || [];
}
async function knowledgeLatestMap() {
  const rows = await listRows("kn_list", "knowledge_articles", { select: KN_COLS, order: "article_id.asc,version_no.asc", limit: 300 });
  const latest = new Map();
  for (const r of rows) { const cur = latest.get(r.article_id); if (!cur || Number(r.version_no) > Number(cur.version_no)) latest.set(r.article_id, r); }
  return { rows, latest };
}
function knowledgeVisibleOfficial(p, kw) {
  return null; // 占位，实际用 async 版本
}
async function officialKnowledgeRows(p, kw) {
  const { latest } = await knowledgeLatestMap();
  const role = p.user.role;
  const out = [];
  for (const r of latest.values()) {
    if (r.review_status !== "approved") continue;
    const ar = String(r.applicable_role || "all");
    if (role === "driver" && !["all", "driver"].includes(ar)) continue;
    if (!["all", "safety_admin", "team_leader", "driver"].includes(ar) && ar !== role) continue;
    if (kw && !(String(r.title) + " " + String(r.article_id) + " " + String(r.content || "")).toLowerCase().includes(kw)) continue;
    out.push(r);
  }
  return out;
}
async function countList(op, table, query, range) {
  const r = await dbRequest(op, "GET", table, { query, headers: { Prefer: "count=exact" }, range });
  const total = parseCount(r.headers?.["content-range"] ?? r.rangeHeader) ?? (r.data ? r.data.length : 0);
  return { rows: r.data || [], total };
}
async function handleGlobalSearch(request, response, url, ctx) {
  const user = requireUser(ctx.principal);
  const q = cleanQuery(url.searchParams.get("q"));
  if (!q) throw new HttpError(400, "invalid_query");
  const like = `ilike.%${q}%`;
  const groups = [];
  const isStaff = ["safety_admin", "team_leader"].includes(user.role);
  const myDriver = String(user.driver_id || "");
  const myBound = user.role === "driver" ? Boolean(user.binding_verified) && Boolean(myDriver) : false;
  if (isStaff) {
    const query = { select: "driver_id,gpsno,display_name,fleet_id,identity_status,mapping_end", or: `(driver_id.${like},gpsno.${like},display_name.${like})`, order: "driver_id.asc,version_no?", limit: 8 };
    delete query.order;
    if (user.fleet_scope && user.fleet_scope !== "*") query.fleet_id = `eq.${user.fleet_scope}`;
    const r = await countList("search_read", "drivers", query, 0, 7);
    groups.push({ type: "drivers", total: r.total, items: r.rows.map((x) => ({ record_id: `${x.driver_id}:${x.gpsno}`, title: `${x.driver_id} · 车 ${x.gpsno}`, summary: `${x.display_name || "—"} · ${x.fleet_id || "—"} · 身份:${x.identity_status || "—"}${x.mapping_end ? " · 至" + x.mapping_end : ""}`, route: `#/ev-fleet?driver_id=${encodeURIComponent(x.driver_id)}` })) });
    const ra = await countList("search_read", "alerts", { select: "alert_id,gpsno,driver_id,rule_code,status,occurred_at", or: `(alert_id.${like},gpsno.${like},driver_id.${like},rule_code.${like})`, order: "occurred_at.desc", limit: 8 }, 0, 7);
    groups.push({ type: "alerts", total: ra.total, items: ra.rows.map((x) => ({ record_id: x.alert_id, title: `案卷 ${x.alert_id} · ${x.rule_code}`, summary: `车 ${x.gpsno} · ${x.driver_id || "未绑定"} · ${x.status} · ${x.occurred_at}`, route: `#/rm-alerts?alert_id=${encodeURIComponent(x.alert_id)}` })) });
    const rt = await countList("search_read", "training_tasks", { select: "task_id,driver_id,alert_id,course_id,goal,status,due_at", or: `(task_id.${like},driver_id.${like},course_id.${like},alert_id.${like},goal.${like})`, order: "updated_at.desc", limit: 8 }, 0, 7);
    groups.push({ type: "training_tasks", total: rt.total, items: rt.rows.map((x) => ({ record_id: x.task_id, title: `培训 ${x.task_id}`, summary: `${x.driver_id} · ${x.course_id} · ${x.status}${x.due_at ? " · 截止 " + x.due_at : ""} · ${String(x.goal || "").slice(0, 40)}`, route: `#/tr-ledger?task_id=${encodeURIComponent(x.task_id)}` })) });
  } else if (myBound) {
    const rd = await countList("search_read", "drivers", { select: "driver_id,gpsno,display_name,fleet_id,identity_status", driver_id: `eq.${myDriver}`, or: `(driver_id.${like},gpsno.${like},display_name.${like})`, order: "gpsno.asc", limit: 8 }, 0, 7);
    groups.push({ type: "drivers", total: rd.total, items: rd.rows.map((x) => ({ record_id: `${x.driver_id}:${x.gpsno}`, title: `${x.driver_id} · 车 ${x.gpsno}`, summary: "本人车辆", route: `#/ev-fleet?driver_id=${encodeURIComponent(x.driver_id)}` })) });
    const ra = await countList("search_read", "alerts", { select: "alert_id,gpsno,driver_id,rule_code,status,occurred_at", driver_id: `eq.${myDriver}`, or: `(alert_id.${like},gpsno.${like},driver_id.${like},rule_code.${like})`, order: "occurred_at.desc", limit: 8 }, 0, 7);
    groups.push({ type: "alerts", total: ra.total, items: ra.rows.map((x) => ({ record_id: x.alert_id, title: `案卷 ${x.alert_id} · ${x.rule_code}`, summary: `车 ${x.gpsno} · ${x.status}`, route: `#/rm-alerts?alert_id=${encodeURIComponent(x.alert_id)}` })) });
    const rt = await countList("search_read", "training_tasks", { select: "task_id,course_id,goal,status,due_at", driver_id: `eq.${myDriver}`, or: `(task_id.${like},course_id.${like},goal.${like})`, order: "updated_at.desc", limit: 8 }, 0, 7);
    groups.push({ type: "training_tasks", total: rt.total, items: rt.rows.map((x) => ({ record_id: x.task_id, title: `培训任务 ${x.task_id}`, summary: `${x.course_id} · ${x.status}${x.due_at ? " · 截止 " + x.due_at : ""}`, route: `#/?task_id=${encodeURIComponent(x.task_id)}` })) });
  }
  const official = await officialKnowledgeRows({ user }, q.toLowerCase());
  groups.push({ type: "knowledge_articles", total: official.length, items: official.slice(0, 8).map((x) => ({ record_id: `${x.article_id}:${x.version_no}`, title: `${x.article_id} · ${x.title}`, summary: `approved v${x.version_no} · ${x.dimension || "维度—"}`, route: `#/sm-knowledge?article_id=${encodeURIComponent(x.article_id)}` })) });
  sendJson(response, 200, { ok: true, q, groups, visible_types: groups.map((g) => g.type), note: user.role === "driver" && !myBound ? "未核实司机绑定：不返回个人对象与计数" : "结果均按当前会话授权过滤；点击目标路由后再验权" });
}
const ERD_STATUS = { draft: ["pending_review", "archived"], pending_review: ["draft", "archived"], archived: [] };
async function safeAuditWhere(url) {
  const w = { select: "audit_id,actor_id,actor_role,action,entity_type,entity_id,old_status,new_status,request_id,occurred_at", order: "occurred_at.desc" };
  const actor = String(url.searchParams.get("actor") || "").trim().slice(0, 64);
  const eid = String(url.searchParams.get("entity_id") || "").trim().slice(0, 80);
  const etype = String(url.searchParams.get("entity_type") || "").trim().slice(0, 40);
  const ap = String(url.searchParams.get("action_prefix") || "").trim().toLowerCase();
  const from = String(url.searchParams.get("from") || "").trim();
  const to = String(url.searchParams.get("to") || "").trim();
  if (actor) w.actor_id = `eq.${actor}`;
  if (eid) w.entity_id = `eq.${eid}`;
  if (etype && /^[\w.-]{1,40}$/.test(etype)) w.entity_type = `eq.${etype}`;
  if (ap && /^[a-z][a-z_.]{1,30}$/.test(ap)) w.action = `like.${ap}%`;
  if (/^[\dT:.Z-]{4,40}$/.test(from)) w.occurred_at = `${w.occurred_at ? w.occurred_at + "," : ""}gte.${from}`;
  if (/^[\dT:.Z-]{4,40}$/.test(to)) w.occurred_at = `${w.occurred_at || ""}${w.occurred_at ? "," : ""}lte.${to}`;
  return w;
}
async function queryAudits(url, limit, offset) {
  const query = await safeAuditWhere(url);
  query.limit = limit; query.offset = offset;
  const r = await dbRequest("audits_q", "GET", "audit_logs", { query, headers: { Prefer: "count=exact" } });
  return { rows: r.data || [], total: parseCount(r.rangeHeader) ?? (r.data ? r.data.length : 0) };
}
async function handleAuditConsole(request, response, url, ctx) {
  requireUser(ctx.principal, "view.audit");
  const fmt = String(url.searchParams.get("format") || "");
  const limit = Math.min(Number(url.searchParams.get("limit")) || 25, fmt === "csv" ? 500 : 100);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
  const { rows, total } = await queryAudits(url, limit, offset);
  if (fmt === "csv") {
    const head = "audit_id,occurred_at,actor_role,actor_id,action,entity_type,entity_id,old_status,new_status,request_id";
    const body = rows.map((x) => [x.audit_id, x.occurred_at, x.actor_role, x.actor_id, x.action, x.entity_type, x.entity_id, x.old_status ?? "", x.new_status ?? "", x.request_id ?? ""].join(",")).join("\n");
    response.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="audit_${Date.now()}.csv"` });
    response.end("\ufeff" + head + "\n" + body);
    return;
  }
  sendJson(response, 200, { ok: true, rows, total, limit, offset, note: "服务端过滤+分页+计数；不含 detail 正文与任何口令字段" });
}
async function handleAuditDetail(request, response, url, ctx, auditId) {
  requireUser(ctx.principal, "view.audit");
  const { data } = await dbRequest("audits_get", "GET", "audit_logs", { query: { audit_id: `eq.${auditId}`, limit: 1 } });
  const row = data?.[0]; if (!row) throw new HttpError(404, "not_found");
  let meta = null;
  try { const d = JSON.parse(row.detail_json || "null"); if (d && typeof d === "object") meta = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, /pw|password|token|answer|text|content|body/i.test(k) ? "(redacted)" : typeof v === "object" ? JSON.stringify(v).slice(0, 120) : String(v).slice(0, 120)])); } catch {}
  const { detail_json, evidence_refs, ...safe } = row;
  sendJson(response, 200, { ok: true, audit: safe, evidence_refs: (() => { try { return JSON.parse(evidence_refs || "[]"); } catch { return []; } })(), detail_meta: meta ?? null, redaction_note: "口令/完整问答/详情正文永不返回（写入时即为摘要）" });
}
async function handleOpsList(request, response, url, ctx) {
  requireUser(ctx.principal);
  if (ctx.principal.user.role === "driver") throw new HttpError(403, "forbidden");
  const rows = await listRows("ops_list", "operation_config", { select: "config_id,value,unit,config_version,updated_at", order: "config_id.asc", limit: 30 });
  sendJson(response, 200, { ok: true, rows });
}
async function handleCoursesBoard(request, response, url, ctx) {
  requireUser(ctx.principal);
  if (ctx.principal.user.role === "driver") throw new HttpError(403, "forbidden");
  const rows = await listRows("course_list", "training_courses", { select: "course_id,title,dimension,content,completion_requirement,content_status,version_no,source_version,updated_at", order: "course_id.asc", limit: 40 });
  const au = await dbRequest("audits_q", "GET", "audit_logs", { query: { entity_type: "eq.training_course", select: "audit_id,actor_id,actor_role,action,entity_id,old_status,new_status,occurred_at", order: "occurred_at.asc", limit: 400 } });
  const byCourse = {};
  for (const a of au.data || []) { (byCourse[a.entity_id] ||= []).push(a); }
  const merged = rows.map((c) => {
    const ev = byCourse[c.course_id] || [];
    const created = ev.find(x => ["course.create", "import.upsert"].includes(x.action));
    const lastReview = [...ev].reverse().find(x => x.new_status === "approved" || x.new_status === "disabled");
    return { ...c, authored_by: created?.actor_id || "导入基线", authored_at: created?.occurred_at || null, reviewed_by: lastReview?.actor_id || null, reviewed_at: lastReview?.occurred_at || null, review_trail: ev.map(x => ({ action: x.action, from: x.old_status, to: x.new_status, by: x.actor_id, at: x.occurred_at, audit_id: x.audit_id })) };
  });
  sendJson(response, 200, { ok: true, courses: merged, note: "作者/审核人/审核时间由 audit_logs 合成（training_courses 无该列，平台无 DDL 通道——用既有内容审核结构补齐，课程文本零丢失）" });
}
async function handleCourseDraft(request, response, url, ctx) {
  const user = requireUser(ctx.principal, "review.content");
  const body = await readBody(request);
  const at = nowIso();
  if (request.method === "POST" && body.action === "create") {
    const courseId = String(body.course_id || "").trim().toUpperCase().slice(0, 30);
    const title = String(body.title || "").slice(0, 120), content = String(body.content || "").slice(0, 8000);
    if (!/^[A-Z0-9_.:-]{3,30}$/.test(courseId) || !title.trim() || !content.trim()) throw new HttpError(400, "course_id_title_content_required");
    const dup = await listRows("course_list", "training_courses", { course_id: `eq.${courseId}`, select: "course_id" });
    if (dup.length) throw new HttpError(409, "course_id_exists");
    await dbRequest("course_insert", "POST", "training_courses", {
      body: [{ course_id: courseId, title, dimension: String(body.dimension || "").slice(0, 40) || null, content, completion_requirement: String(body.completion_requirement || "提交本人的行动计划文本").slice(0, 200), content_status: "draft", version_no: 1, source_version: "r19_selfbuilt", updated_at: at }],
      headers: { Prefer: "return=minimal" } });
    const auditId = await appendAudit(ctx.principal, "course.create", "training_course", courseId, null, "draft", ctx.requestId);
    return sendJson(response, 201, { ok: true, course_id: courseId, content_status: "draft", audit_id: auditId, note: "自建课程初始 draft：不得被 TR02 分配、不得被 AI 当正式课引用" });
  }
  const courseId = String(body.course_id || "").trim(); if (!courseId) throw new HttpError(400, "bad_request");
  const cr = await listRows("course_list", "training_courses", { course_id: `eq.${courseId}` });
  const c = cr[0]; if (!c) throw new HttpError(404, "not_found");
  if (!["draft", "pending_review", "demo_draft_requires_team_review"].includes(String(c.content_status))) throw new HttpError(409, "only_unapproved_editable_approved_needs_disable_plus_new");
  if (c.content !== undefined && body.content !== undefined && !String(body.content).trim()) throw new HttpError(400, "content_required");
  await dbRequest("course_patch", "PATCH", "training_courses", {
    query: { course_id: `eq.${courseId}` },
    body: { title: body.title !== undefined ? String(body.title).slice(0, 120) : c.title, dimension: body.dimension !== undefined ? String(body.dimension).slice(0, 40) : c.dimension, content: body.content !== undefined ? String(body.content).slice(0, 8000) : c.content, completion_requirement: body.completion_requirement !== undefined ? String(body.completion_requirement).slice(0, 200) : c.completion_requirement, version_no: (Number(c.version_no) || 0) + 1, updated_at: at },
    headers: { Prefer: "return=minimal" } });
  const auditId = await appendAudit(ctx.principal, "course.edit", "training_course", courseId, c.content_status, c.content_status, ctx.requestId, [], { version_no: (Number(c.version_no) || 0) + 1 });
  sendJson(response, 200, { ok: true, course_id: courseId, version_no: (Number(c.version_no) || 0) + 1, audit_id: auditId });
}
// ===== R37①司机个人资料维护（driver_profiles=迁移006；仅本人行；不改绑定/评分事实） =====
async function handleOwnProfile(request, response, url, ctx) {
  const user = requireUser(ctx.principal);
  if (user.role !== "driver") throw new HttpError(403, "profile_driver_only");
  if (request.method === "GET") {
    const r = await dbRequest("dp_get", "GET", "driver_profiles", { query: { user_id: `eq.${user.user_id}`, select: "user_id,phone,intro,prefs,updated_by,updated_at", limit: 1 } });
    return sendJson(response, 200, { ok: true, profile: r.data?.[0] || null, note: "司机自维护信息；不影响绑定身份、评分与预测事实" });
  }
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
  const body = await readBody(request, 4096);
  const provided = ["phone", "intro", "prefs"].filter((k) => body[k] !== undefined);
  if (!provided.length) throw new HttpError(400, "nothing_to_update");
  const phone = body.phone === undefined ? null : String(body.phone).trim().slice(0, 24);
  const intro = body.intro === undefined ? null : String(body.intro).trim().slice(0, 500);
  const prefs = body.prefs === undefined ? null : String(body.prefs).trim().slice(0, 800);
  if (phone && !/^[\d+() -]{5,24}$/.test(phone)) throw new HttpError(409, "invalid_phone_format");
  if (prefs) { let pj = null; try { pj = JSON.parse(prefs); } catch {} if (!pj || typeof pj !== "object" || Array.isArray(pj)) throw new HttpError(409, "invalid_prefs_json"); }
  const at = nowIso();
  const patchBody = { updated_by: user.user_id, updated_at: at };
  if (body.phone !== undefined) patchBody.phone = phone || null;
  if (body.intro !== undefined) patchBody.intro = intro || null;
  if (body.prefs !== undefined) patchBody.prefs = prefs || null;
  const cur = await dbRequest("dp_get", "GET", "driver_profiles", { query: { user_id: `eq.${user.user_id}`, select: "user_id", limit: 1 } });
  if (cur.data?.length) {
    await dbRequest("dp_patch", "PATCH", "driver_profiles", { query: { user_id: `eq.${user.user_id}` }, body: patchBody, headers: { Prefer: "return=minimal" } });
  } else {
    await dbRequest("dp_insert", "POST", "driver_profiles", { body: [{ user_id: user.user_id, phone: patchBody.phone ?? null, intro: patchBody.intro ?? null, prefs: patchBody.prefs ?? null, updated_by: user.user_id, updated_at: at }], headers: { Prefer: "return=minimal" } });
  }
  const auditId = await appendAudit(ctx.principal, "account.profile_update", "driver_profile", user.user_id, null, "updated", ctx.requestId, [], { fields: provided });
  sendJson(response, 200, { ok: true, audit_id: auditId, saved: provided, note: "已保存（仅本次提交的字段）；页面与审计均不回显口令，管理员可在操作审计看到 profile_update 事件" });
}

// ===== R37③根因分析（只读聚合：台账分摊口径，结构性归因非因果；历史快照不回算） =====
const DIM_NAME_CN = { history: "历史事故与未遂", fatigue_distraction: "疲劳与分心", driving_stability: "驾驶稳定性", road_rule: "道路规则", management: "管理配合度", imu_evidence: "IMU 风险佐证" };
async function computeRootCauses(principal, cohort) {
  const user = requireUser(principal);
  if (user.role === "driver") throw new HttpError(403, "forbidden");
  const snaps = [];
  for (let off = 0; ; off += 200) { const r = await aiQ("admin.score_snapshots", { limit: 200, offset: off }, principal); snaps.push(...r.rows); if (r.rows.length < 200) break; }
  if (!snaps.length) return { ok: true, data_status: "no_data", note: "评分快照未导入：不输出任何聚合结论（不补造）" };
  const pool = snaps.filter((x) => x.safety_score != null && (cohort === "d" ? String(x.risk_level) === "D" : ["C", "D"].includes(String(x.risk_level))));
  const inPool = new Set(pool.map((x) => String(x.gpsno)));
  const led = [];
  for (let off = 0; off < 60000; off += 2000) {
    const r = await dbRequest("rc_led", "GET", "deduction_ledger", { query: { select: "ledger_id,gpsno,dimension,event_type,event_count,allocated_points,as_of_date", order: "ledger_id.asc", limit: 2000, offset: off } });
    const rows = r.data || []; led.push(...rows); if (rows.length < 2000) break;
  }
  const dimPts = {}, dimEv = {}, evPts = {}, drvPts = {}; let sumAp = 0, coveredGps = new Set();
  for (const l of led) {
    if (!inPool.has(String(l.gpsno))) continue;
    const ap = Number(l.allocated_points) || 0; sumAp += ap;
    dimPts[l.dimension] = (dimPts[l.dimension] || 0) + ap;
    dimEv[l.dimension] = (dimEv[l.dimension] || 0) + (Number(l.event_count) || 0);
    evPts[l.dimension + "|" + l.event_type] = (evPts[l.dimension + "|" + l.event_type] || 0) + ap;
    drvPts[l.gpsno] = (drvPts[l.gpsno] || 0) + ap; coveredGps.add(String(l.gpsno));
  }
  const dims = Object.entries(dimPts).sort((a, b) => b[1] - a[1]).map(([d, v]) => ({ dimension: d, dimension_name: DIM_NAME_CN[d] || d, allocated_points: +v.toFixed(4), share_pct: sumAp ? +(v / sumAp * 100).toFixed(1) : null, events: dimEv[d] || 0 }));
  const events = Object.entries(evPts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => { const [d, e] = k.split("|"); return { dimension: d, dimension_name: DIM_NAME_CN[d] || d, event_type: e, allocated_points: +v.toFixed(4) }; });
  const drivers = Object.entries(drvPts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([gps, pts]) => { const s = snaps.find((x) => String(x.gpsno) === gps) || {}; return { gpsno: gps, driver_id: s.driver_id || null, allocated_points: +pts.toFixed(4), safety_score: s.safety_score ?? null, risk_level: s.risk_level || null, confidence_level: s.confidence_level || null, score_id: s.score_id || null }; });
  const sumW = await listRows("rc_er", "evaluation_rules", { select: "dimension,weight,source_version", order: "dimension.asc" }).catch(() => []);
  return { ok: true, data_status: "ok", as_of_date: snaps[0].as_of_date || null, source_version: snaps[0].source_version || null,
    ruleset_source_version: [...new Set(sumW.map((x) => String(x.source_version)))].join("、") || null,
    cohort: cohort === "d" ? "risk_level=D" : "risk_level∈{C,D}", cohort_count: pool.length,
    low_conf_in_pool: pool.filter((x) => x.confidence_level === "low").length,
    pool_avg: pool.length ? +(pool.reduce((a, x) => a + Number(x.safety_score), 0) / pool.length).toFixed(2) : null,
    ledger_total_allocated_in_pool: +sumAp.toFixed(4), ledger_rows_in_pool: led.filter((l) => inPool.has(String(l.gpsno))).length,
    gps_covered_in_pool: coveredGps.size, gps_without_ledger_in_pool: pool.length - coveredGps.size,
    dimensions: dims, event_types: events, top_objects: drivers,
    note: "按 deduction_ledger 分摊(allocated_points)聚合的结构性归因：不构成任何单事件的独立因果效应；无台账行的池内对象可能是覆盖不足，须结合可信度判断（不当作零风险）；低可信度对象先设备/数据核验再定因；本分析只读，不创建告警/任务，历史快照与分值不因分析而改写" };
}
async function handleRootCauses(request, response, url, ctx) {
  const cohort = String(url.searchParams.get("cohort") || "cd") === "d" ? "d" : "cd";
  const out = await computeRootCauses(ctx.principal, cohort);
  sendJson(response, 200, out);
}
// ===== R37④风险等级→强制性培训映射（运营配置域内；生效版本+审计；分配时缺省自动套用，人工可显式改判并留痕） =====
function parseMandatePolicy(raw) {
  let j = null; try { j = JSON.parse(String(raw)); } catch { return null; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const ks = Object.keys(j); if (!ks.length || ks.some((k) => !["A", "B", "C", "D"].includes(k))) return null;
  if (ks.some((k) => !["mandatory", "optional"].includes(String(j[k])))) return null;
  return Object.fromEntries(ks.map((k) => [k, String(j[k])]));
}
async function loadMandatePolicy() {
  try { const r = await dbRequest("get_config_row", "GET", "operation_config", { query: { config_id: "eq.training_mandate_policy", select: "value,config_version" } }); const row = r.data?.[0]; if (!row) return null; const p = parseMandatePolicy(row.value); return p ? { policy: p, config_version: Number(row.config_version) || 0 } : null; } catch { return null; }
}
async function driverLatestLevel(driverId) {
  try { const r = await dbRequest("ma_lvl", "GET", "score_snapshots", { query: { driver_id: `eq.${String(driverId).slice(0, 60)}`, select: "risk_level", order: "as_of_date.desc", limit: 1 } }); return r.data?.[0]?.risk_level || null; } catch { return null; }
}

async function handleRuleDrafts(request, response, url, ctx, draftId) {
  const user = requireUser(ctx.principal, "manage.rule_drafts");
  if (request.method === "GET") {
    const drafts = await listRows("erd_list", "evaluation_rule_drafts", { select: "draft_id,base_version,dimension,proposal,status,approval_note,review_note,created_by,created_at,updated_at,reviewed_by,reviewed_at", order: "updated_at.desc", limit: 60 });
    const current = await listRows("er_current", "evaluation_rules", { select: "dimension,dimension_name,weight,window_days,score_method,editable,source_version", order: "dimension.asc" });
    return sendJson(response, 200, { ok: true, current, drafts, note: "current=现行生效口径（历史行原值 source_version=出数快照；经『草案→人工批准→确认生效』更新的维度显示 ruleset_vN）；草案在批准并显式生效前永不作为现行参数被页面/AI 使用；生效不改写任何历史快照/台账/预测" });
  }
  const body = await readBody(request);
  const action = String(body.action || "");
  if (request.method === "POST" && !draftId) {
    const dimension = String(body.dimension || "");
    const cur0 = await listRows("er_dims", "evaluation_rules", { select: "dimension", order: "dimension.asc" }).catch(() => []);
    const DIMS = cur0.map((x) => String(x.dimension));
    if (!DIMS.includes(dimension)) throw new HttpError(409, "unknown_dimension");
    const proposal0 = String(body.proposal || "").slice(0, 6000);
    const hasWeights = body.weights && typeof body.weights === "object" && !Array.isArray(body.weights) && Object.keys(body.weights).length;
    let proposal = proposal0;
    if (hasWeights) {
      const wj = {}; for (const [k, v] of Object.entries(body.weights)) { if (!DIMS.includes(k)) throw new HttpError(409, "unknown_dimension"); const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 1) throw new HttpError(409, "weight_out_of_range"); wj[k] = n; }
      if (!Object.values(wj).some((v) => v > 0)) throw new HttpError(409, "proposal_no_weights");
      proposal = JSON.stringify({ kind: "weight_proposal", note: proposal0.slice(0, 2000), window_days: Number.isFinite(Number(body.window_days)) ? Math.min(Math.max(Number(body.window_days), 1), 90) : null, weights: wj });
    }
    if (!proposal.trim()) throw new HttpError(400, "proposal_required");
    const cur = await listRows("er_current", "evaluation_rules", { query: { dimension: `eq.${dimension}`, select: "source_version" } }).catch(() => []);
    const at = nowIso(); const id = newId("erd");
    await dbRequest("erd_insert", "POST", "evaluation_rule_drafts", {
      body: [{ draft_id: id, base_version: String(body.base_version || (cur[0]?.source_version || "")), dimension, proposal, status: "draft", approval_note: null, review_note: null, created_by: user.user_id, created_at: at, updated_at: at, reviewed_by: null, reviewed_at: null }],
      headers: { Prefer: "return=minimal" } });
    const auditId = await appendAudit(ctx.principal, "rule_draft.create", "evaluation_rule_draft", id, null, "draft", ctx.requestId, [], { dimension, structured: Boolean(hasWeights) });
    return sendJson(response, 201, { ok: true, draft_id: id, status: "draft", structured: Boolean(hasWeights), audit_id: auditId, note: hasWeights ? "结构化草案（含权重表）：批准后可走『生效为新口径』；未生效前任何页面/AI 不把它当现行参数" : "文本草案：不可生效，仅供评审批注；生效需结构化提案" });
  }
  if (!draftId) throw new HttpError(404, "not_found");
  const row0 = await listRows("erd_get", "evaluation_rule_drafts", { query: { draft_id: `eq.${draftId}`, select: "draft_id,status,created_by,review_note" } });
  const row = row0[0]; if (!row) throw new HttpError(404, "not_found");
  const at = nowIso(); let patch = null, audit = null, extraAudit = null;
  if (action === "submit" && row.status === "draft") patch = { status: "pending_review" }, audit = ["draft", "pending_review", "rule_draft.submit"];
  else if (action === "withdraw" && row.status === "pending_review") patch = { status: "draft" }, audit = ["pending_review", "draft", "rule_draft.withdraw"];
  else if (action === "note") { const rn = String(body.review_note || "").slice(0, 800); if (!rn.trim()) throw new HttpError(400, "review_note_required"); patch = { review_note: rn, reviewed_by: user.user_id, reviewed_at: at }; audit = [row.status, row.status, "rule_draft.note"]; }
  else if (action === "archive" && row.status !== "archived" && row.status !== "effectuated") patch = { status: "archived" }, audit = [row.status, "archived", "rule_draft.archive"];
  // R37②：批准（评审意见必填；同作者强制二次确认留痕——沿用知识门禁同一策略）
  else if (action === "approve" && row.status === "pending_review") {
    const rn = String(body.review_note || "").slice(0, 800); if (!rn.trim()) throw new HttpError(409, "approve_requires_review_note");
    const full0 = await listRows("erd_get2", "evaluation_rule_drafts", { query: { draft_id: `eq.${draftId}`, select: "created_by" } });
    const sameActor = full0[0]?.created_by === user.user_id;
    if (sameActor && body.confirm_same_actor !== true) throw new HttpError(409, "self_review_requires_explicit_confirm");
    patch = { status: "approved", reviewed_by: user.user_id, reviewed_at: at, approval_note: rn };
    audit = ["pending_review", "approved", "rule_draft.approve"];
    if (sameActor) extraAudit = { self_review_confirmed: true, note: "审阅者与起草人同为该管理员，已显式二次确认留痕" };
  }
  // R37②：生效——把已批准的结构化权重提案写为现行 evaluation_rules 新版本（属主 2026-10-27 授权开放配置；
  // 历史快照/台账/预测不因此改写；显式确认 + 权重和守卫 + 行数不变断言在测试里）
  else if (action === "effectuate" && row.status === "approved") {
    if (body.confirm_effectuate !== true) throw new HttpError(409, "effectuate_requires_explicit_confirm");
    const full = await listRows("erd_get3", "evaluation_rule_drafts", { query: { draft_id: `eq.${draftId}`, select: "dimension,proposal,base_version" } });
    const d = full[0]; let pj = null; try { pj = JSON.parse(String(d.proposal)); } catch {}
    if (!pj || pj.kind !== "weight_proposal" || !pj.weights || typeof pj.weights !== "object") throw new HttpError(409, "proposal_not_structured_for_effectuate");
    const curRows = await listRows("er_current2", "evaluation_rules", { select: "dimension,dimension_name,weight,window_days,source_version", order: "dimension.asc" });
    const dimSet = new Set(curRows.map((r0) => String(r0.dimension)));
    const updates = [];
    for (const [dim, w] of Object.entries(pj.weights)) {
      if (!dimSet.has(dim)) throw new HttpError(409, "unknown_dimension");
      const wn = Number(w); if (!Number.isFinite(wn) || wn < 0 || wn > 1) throw new HttpError(409, "weight_out_of_range");
      updates.push({ dimension: dim, weight: wn });
    }
    if (!updates.length) throw new HttpError(409, "proposal_no_weights");
    const merged = {}; for (const r0 of curRows) merged[String(r0.dimension)] = Number(r0.weight);
    for (const u of updates) merged[u.dimension] = u.weight;
    const sum = Object.values(merged).reduce((a, b) => a + (Number(b) || 0), 0);
    if (Math.abs(sum - 1) > 0.02 && body.allow_unnormalized !== true) throw new HttpError(409, "weights_sum_far_from_1");
    let vMax = 0; for (const r0 of curRows) { const m2 = /^ruleset_v(\d+)/.exec(String(r0.source_version || "")); if (m2) vMax = Math.max(vMax, Number(m2[1])); }
    const newSv = "ruleset_v" + (vMax + 1) + "_" + at.slice(0, 10).replace(/-/g, "");
    const changes = [];
    for (const u of updates) {
      const old = curRows.find((r0) => String(r0.dimension) === u.dimension);
      const b2 = { weight: u.weight, source_version: newSv };
      if (Number.isFinite(Number(pj.window_days))) b2.window_days = Math.min(Math.max(Number(pj.window_days), 1), 90);
      await dbRequest("er_patch_effect", "PATCH", "evaluation_rules", { query: { dimension: `eq.${u.dimension}` }, body: b2, headers: { Prefer: "return=minimal" } });
      changes.push({ dimension: u.dimension, old_weight: old?.weight ?? null, new_weight: u.weight, old_source_version: old?.source_version ?? null });
    }
    patch = { status: "effectuated", updated_at: at };
    audit = ["approved", "effectuated", "rule_draft.effectuate"];
    extraAudit = { new_source_version: newSv, changes, weights_sum: +sum.toFixed(6), allow_unnormalized: body.allow_unnormalized === true || undefined, note: String(body.note || "").slice(0, 500) || (pj.note ? String(pj.note).slice(0, 400) : null), invariant: "仅更新 evaluation_rules 既存 6 行的权重/窗口与口径版本；score_snapshots/score_history/deduction_ledger/risk_snapshots 行数与数值零改写；历史分值为旧口径离线所算，不回算" };
  }
  if (!patch) throw new HttpError(409, `rule_draft_action_${action || "none"}_invalid_from_${row.status}`);
  await dbRequest("erd_patch", "PATCH", "evaluation_rule_drafts", { query: { draft_id: `eq.${draftId}`, status: `eq.${row.status}` }, body: { ...patch, updated_at: at }, headers: { Prefer: "return=minimal" } });
  const auditId = await appendAudit(ctx.principal, audit[2], "evaluation_rule_draft", draftId, audit[0], audit[1], ctx.requestId, null, extraAudit);
  sendJson(response, 200, { ok: true, draft_id: draftId, old_status: audit[0], new_status: audit[1], audit_id: auditId, new_source_version: extraAudit?.new_source_version || undefined, self_review_confirmed: extraAudit?.self_review_confirmed || undefined, note: audit[2] === "rule_draft.effectuate" ? "已生效为新口径（现行列/AI 同源显示新版本）；历史快照不回算，重新出数由算法侧执行" : undefined });
}
async function handleKnowledgeAdmin(request, response, url, ctx, articleId) {
  const user = requireUser(ctx.principal, "manage.knowledge");
  if (request.method === "GET" && !articleId) {
    const { rows, latest } = await knowledgeLatestMap();
    return sendJson(response, 200, { ok: true, rows: rows.map((r) => ({ ...r, is_latest: latest.get(r.article_id)?.version_no === r.version_no, officially_referenceable: latest.get(r.article_id)?.review_status === "approved" && latest.get(r.article_id)?.version_no === r.version_no })), note: "正式引用=最新且 approved；历史版本仅可追溯" });
  }
  const body = await readBody(request);
  const action = String(body.action || "");
  const at = nowIso();
  if (request.method === "POST" && !articleId) {
    const title = String(body.title || "").slice(0, 160), content = String(body.content || "").slice(0, 20000);
    if (!title.trim() || !content.trim()) throw new HttpError(400, "title_content_required");
    const all = await knowledgeLatestMap();
    let n = 1; for (const k of all.latest.keys()) { const m = /^K(\d+)$/.exec(k); if (m) n = Math.max(n, Number(m[1]) + 1); }
    const article_id = "K" + n;
    await dbRequest("kn_insert", "POST", "knowledge_articles", {
      body: [{ article_id, version_no: 1, title, dimension: String(body.dimension || "").slice(0, 40) || null, content, source_note: String(body.source_note || "自建").slice(0, 500), review_status: "draft", applicable_role: ["all", "driver", "safety_admin"].includes(body.applicable_role) ? body.applicable_role : "all", version: "v1", created_by: user.user_id, reviewed_by: null, reviewed_at: null, updated_at: at }],
      headers: { Prefer: "return=minimal" } });
    const auditId = await appendAudit(ctx.principal, "knowledge.create", "knowledge_article", article_id, null, "draft", ctx.requestId, [], { version_no: 1 });
    return sendJson(response, 201, { ok: true, article_id, version_no: 1, status: "draft", audit_id: auditId });
  }
  if (!articleId) throw new HttpError(404, "not_found");
  const { latest } = await knowledgeLatestMap();
  const row = latest.get(articleId); if (!row) throw new HttpError(404, "not_found");
  const FKS = { draft: ["pending_review"], pending_review: ["draft", "approved", "disabled"], approved: ["disabled"], disabled: [] };
  if (action === "new_version") {
    if (!["approved", "disabled"].includes(row.review_status)) throw new HttpError(409, "new_version_requires_approved_base");
    const content = String(body.content || "").slice(0, 20000); if (!content.trim()) throw new HttpError(400, "content_required");
    const vn = Number(row.version_no) + 1;
    await dbRequest("kn_insert", "POST", "knowledge_articles", {
      body: [{ article_id: row.article_id, version_no: vn, title: String(body.title || row.title).slice(0, 160), dimension: String(body.dimension || row.dimension || ""), content, source_note: String(body.source_note || row.source_note || "").slice(0, 500), review_status: "draft", applicable_role: row.applicable_role, version: "v" + vn, created_by: user.user_id, reviewed_at: null, reviewed_by: null, updated_at: at }],
      headers: { Prefer: "return=minimal" } });
    const auditId = await appendAudit(ctx.principal, "knowledge.new_version", "knowledge_article", `${row.article_id}:${vn}`, row.review_status, "draft", ctx.requestId, [], { base_version: row.version_no });
    return sendJson(response, 200, { ok: true, article_id: row.article_id, version_no: vn, status: "draft", audit_id: auditId });
  }
  let patch = null, au = null;
  if (action === "submit") { if (!FKS.draft.includes("pending_review") || row.review_status !== "draft") throw new HttpError(409, "knowledge_transition_invalid"); patch = { review_status: "pending_review" }; au = ["draft", "pending_review", "knowledge.submit"]; }
  else if (action === "withdraw") { if (row.review_status !== "pending_review") throw new HttpError(409, "knowledge_transition_invalid"); patch = { review_status: "draft" }; au = ["pending_review", "draft", "knowledge.withdraw"]; }
  else if (action === "approve") {
    if (row.review_status !== "pending_review") throw new HttpError(409, "knowledge_transition_invalid");
    const sameActor = row.created_by === user.user_id;
    if (sameActor && body.confirm_same_actor !== true) throw new HttpError(409, "self_review_requires_explicit_confirm");
    patch = { review_status: "approved", reviewed_by: user.user_id, reviewed_at: at, version: String(row.version || "v" + row.version_no) };
    au = ["pending_review", "approved", "knowledge.approve"];
    if (sameActor) patch.review_note_guard = undefined; // 不落额外列：同作者确认写审计 detail
  }
  else if (action === "disable") { if (!FKS[row.review_status]?.includes("disabled")) throw new HttpError(409, "knowledge_transition_invalid"); patch = { review_status: "disabled", reviewed_by: user.user_id, reviewed_at: at }; au = [row.review_status, "disabled", "knowledge.disable"]; }
  else if (action === "edit") {
    if (row.review_status !== "draft") throw new HttpError(409, "edit_only_draft_versions");
    const content = String(body.content || "").slice(0, 20000); if (!content.trim()) throw new HttpError(400, "content_required");
    patch = { content, title: String(body.title || row.title).slice(0, 160), dimension: body.dimension !== undefined ? String(body.dimension).slice(0, 40) : row.dimension, source_note: body.source_note !== undefined ? String(body.source_note).slice(0, 500) : row.source_note };
    au = ["draft", "draft", "knowledge.edit"];
  }
  if (!patch) throw new HttpError(409, `knowledge_action_${action || "none"}_invalid_from_${row.review_status}`);
  await dbRequest("kn_patch", "PATCH", "knowledge_articles", { query: { article_id: `eq.${articleId}`, version_no: `eq.${row.version_no}`, review_status: `eq.${row.review_status}` }, body: { ...patch, updated_at: at }, headers: { Prefer: "return=minimal" } });
  const sameConf = action === "approve" && row.created_by === user.user_id;
  const auditId = await appendAudit(ctx.principal, au[2], "knowledge_article", `${articleId}:${row.version_no}`, au[0], au[1], ctx.requestId, [], sameConf ? { self_review_confirmed: true, note: "审阅者与作者同为该管理员，已二次确认留痕" } : undefined);
  sendJson(response, 200, { ok: true, article_id: articleId, version_no: row.version_no, old_status: au[0], new_status: au[1], audit_id: auditId, self_review_confirmed: sameConf || undefined });
}
async function handleAiSelftest(request, response, url, ctx) {
  const u = requireUser(ctx.principal);
  if (u.role !== "safety_admin") throw new HttpError(403, "forbidden");
  const count = async (table, sel) => { const r = await dbRequest("count_resource", "GET", table, { query: { select: sel, limit: 1 }, headers: { Prefer: "count=exact,return=minimal" } }); return parseCount(r.rangeHeader); };
  const pre = { alerts: await count("alerts", "alert_id"), iv: await count("interventions", "intervention_id"), tt: await count("training_tasks", "task_id"), nf: await count("notification_events", "notification_id") };
  const seq = [["get_fleet_summary", {}], ["get_review_queue", { review_queue: "priority_review" }], ["get_driver_evaluation", { driver_id: "DEMO_D0149" }], ["get_risk_snapshot", { gpsno: "95301325" }], ["get_evidence", { gpsno: "95301325" }], ["get_alert", { alert_id: "alert-1e7ec09935dd735b" }], ["get_interventions", {}], ["get_tasks", {}], ["get_review_request", {}], ["knowledge_search", {}], ["propose_intervention", { alert_id: "alert-1e7ec09935dd735b" }], ["propose_training", { driver_id: "DEMO_D0149" }], ["action_preplan", { gpsno: "95302616" }], ["get_risk_snapshot", { gpsno: "95302616" }], ["get_root_causes", { cohort: "cd" }]];
  const tools = [];
  for (const [n, a] of seq) {
    try { const r = await AI_TOOLS[n](a, ctx.principal); tools.push({ tool: n, status: r.status, refs: (r.fact_refs || []).length, requires_confirmation: r.requires_confirmation === true }); }
    catch { tools.push({ tool: n, status: "tool_error" }); }
  }
  let preplan = {};
  try {
    const al = await dbRequest("get_alert_row", "GET", "alerts", { query: { status: "eq.confirmed", select: "alert_id", order: "updated_at.desc", limit: 1 } });
    const aid = al.data?.[0]?.alert_id;
    if (aid) { const ri = await AI_TOOLS.propose_intervention({ alert_id: aid, tone: "standard" }, ctx.principal); if (ri?.draft_action?.fill_to) preplan.intervention = ri.draft_action; }
  } catch {}
  try { const rt = await AI_TOOLS.propose_training({ driver_id: "DEMO_D0149" }, ctx.principal); if (rt?.draft_action?.fill_to) preplan.training = rt.draft_action; } catch {}
  const post = { alerts: await count("alerts", "alert_id"), iv: await count("interventions", "intervention_id"), tt: await count("training_tasks", "task_id"), nf: await count("notification_events", "notification_id") };
  const same = JSON.stringify(pre) === JSON.stringify(post);
  aiSweepMaps();
  sendJson(response, 200, { ok: true, preplan, prompt_version: AI_PROMPT_SHA, provider: aiAvailable() ? aiModel() : "provider_not_configured (chat 将 503；本自检不依赖模型)", tools, counts_before: pre, counts_after: post, writes: same ? "zero_confirmed" : "COUNTS_CHANGED",
    engine: { name: "agent1-inspired", skills: AI_SKILLS.map((x) => x.id), tool_contracts: Object.keys(AI_TOOL_CONTRACTS).length, tool_budget: AI_TOOL_BUDGET, replay_ttl_ms: AI_CHAT_REPLAY_TTL, verification_ttl_ms: AI_VERIFICATION_TTL, verifications_active: AI_VERIFICATIONS.size }, note: "工具层契约自检=真实执行受控工具链路（非对话模拟、非静态聊天）" });
}

// ---------- Section: AI call audit (§8.8) + evidence cards (AI02) ----------
// 等效扩展：audit_logs（既有表，不触碰19表业务契约）。ai.chat 行=调用事件（entity_id=ai_call_id）；
// ai.confirm 行=人工确认事件（同 entity_id=ai_call_id，detail 关联实际业务ID）；原始 ai.chat 行为 append-only 不被改写。
// 不保存用户原文/完整提示词；refused 仅记状态与工具名，不记被拒对象。
const AI_CARD_ROUTES_ADMIN = { score: (r) => `#/ev-fleet?driver_id=${encodeURIComponent(String(r.driver_id || ""))}`, score_history: () => "#/ev-week", risk: () => "#/rm-queue", ledger: (r) => `#/ev-fleet?gpsno=${encodeURIComponent(String(r.gpsno || ""))}`, queue: (r) => `#/rm-queue?gpsno=${encodeURIComponent(String(r.gpsno || ""))}`, alert: (r) => `#/rm-alerts?alert_id=${encodeURIComponent(String(r.alert_id || ""))}`, knowledge: () => "#/sm-knowledge", course: () => "#/tr-courses", task: (r) => `#/tr-ledger?task=${encodeURIComponent(String(r.task_id || ""))}` };

async function aiAudit(ctx, state, info) {
  if (!ctx?.principal?.user) return null;
  const auditId = newId("aud");
  const detail = {
    kind: "ai_chat", result_state: String(state).slice(0, 40), model: aiAvailable() ? aiModel() : "provider_not_configured",
    prompt_version: AI_PROMPT_SHA, page: String(info.page || "").slice(0, 60), skill: String(info.skill || "").slice(0, 40),
    duration_ms: Math.min(Number(info.duration_ms) || 0, 600000),
    tools: (info.tools || []).slice(0, 16).map((x) => ({ n: String(x.name).slice(0, 42), s: String(x.status).slice(0, 30), r: Math.min(Number(x.refs) || 0, 99) })),
    sources: (info.sources || []).slice(0, 16).map((s2) => String(s2).slice(0, 90)),
    requires_confirmation: Boolean(info.has_draft), rounds: Math.min(Number(info.rounds) || 0, 9),
  };
  try {
    await dbRequest("ai_audit_insert", "POST", "audit_logs", {
      body: [{ audit_id: auditId, actor_id: ctx.principal.user.user_id, actor_role: ctx.principal.user.role, action: "ai.chat", entity_type: "ai_call", entity_id: auditId, old_status: null, new_status: String(state).slice(0, 40), detail_json: JSON.stringify(detail), request_id: ctx.requestId || null, occurred_at: nowIso() }],
      headers: { Prefer: "return=minimal" },
    });
    return auditId;
  } catch { return null; }
}

function rowToCard(kind, row) {
  if (!row) return null;
  const g = (k) => (row[k] === undefined || row[k] === null || row[k] === "" ? null : row[k]);
  const rid = String(g("score_id") || g("snapshot_id") || g("ledger_id") || g("queue_id") || g("alert_id") || g("article_id") || g("course_id") || g("request_id") || "");
  if (!rid) return null;
  const TABLES = { score: "score_snapshots", score_history: "score_history", risk: "risk_snapshots", ledger: "deduction_ledger", queue: "review_queue", alert: "alerts", knowledge: "knowledge_articles", course: "training_courses" };
  let field = "record_id", value = rid, windowTxt = null;
  if (kind === "score") { field = "近14天安全分(safety_score)"; value = g("safety_score"); windowTxt = g("window_start") && g("as_of_date") ? `观察窗 ${g("window_start")}→${g("as_of_date")}` : null; }
  else if (kind === "risk") { field = "40天风险概率(risk_prob)"; value = g("risk_prob"); windowTxt = `预测窗 未来${g("horizon_days") ?? 40}天`; }
  else if (kind === "ledger") { field = "分摊扣分(allocated_points)"; value = g("allocated_points"); windowTxt = g("as_of_date") ? `截止 ${g("as_of_date")} · 维度 ${g("dimension")} · 事件 ${String(g("event_type") ?? "—")}${g("event_count") !== null ? `×${g("event_count")}` : ""}` : null; }
  else if (kind === "queue") { field = "复核队列分(safety_score)"; value = g("safety_score"); windowTxt = g("as_of_date") ? `队列快照 ${g("as_of_date")}` : null; }
  else if (kind === "alert") { field = "案卷状态(status)"; value = g("status"); windowTxt = g("occurred_at") ? `事实日期 ${g("occurred_at")} · 规则 ${String(g("rule_code") ?? "—")}` : null; }
  else if (kind === "knowledge") { field = "审核状态(review_status)"; value = g("review_status"); windowTxt = g("version") ? `版本 ${g("version")}` : null; }
  else if (kind === "course") { field = "课程状态(content_status)"; value = g("content_status"); windowTxt = g("completion_requirement") ? `完成条件：${String(g("completion_requirement")).slice(0, 60)}` : null; }
  else if (kind === "score_history") { field = "当日评分(safety_score)"; value = g("safety_score"); windowTxt = g("as_of_date") ? `日终快照 ${g("as_of_date")}` : null; }
  if (value === null && !["knowledge", "course"].includes(kind)) return null; // 空值不出卡（显示0禁止）
  return { ref: `${kind}:${rid}`, table: TABLES[kind] || kind, field, value, window: windowTxt,
    as_of_date: g("as_of_date") || g("occurred_at") || null, source_version: g("source_version") || null,
    confidence: kind === "score" || kind === "score_history" || kind === "queue" ? g("confidence_level") : null,
    limitations: ["knowledge", "course"].includes(kind) ? "未人工审核条目：仅草稿参考，不作正式制度/课程依据" : kind === "risk" ? "预测≠事故已发生；非回放时点当时已知" : kind === "ledger" ? "台账分摊用于核账，非单事件独立因果" : null };
}
function cardsFromTool(name, out) {
  if (!out || ["refused_no_scope", "not_found_no_leak", "bad_args", "unknown_tool", "tool_error", "empty"].includes(out.status)) return [];
  const d = out.data;
  const rows = name === "get_my_evaluation" ? [d?.latest, ...(d?.history || []).slice(-1)] : name === "get_alert" ? [(d?.alert ? { ...d.alert, alert_id: d.alert.alert_id } : null)] : Array.isArray(d) ? d : d ? [d] : [];
  const kind = name === "get_my_evaluation" ? "score" : name === "get_driver_evaluation" ? "score" : name === "get_risk_snapshot" ? "risk" : name === "get_evidence" ? "ledger" : name === "get_review_queue" ? "queue" : name === "get_alert" ? "alert" : name === "knowledge_search" ? "knowledge" : name === "propose_training" ? "course" : null;
  if (!kind) return [];
  return rows.slice(0, 5).map((x) => rowToCard(x && String(x.score_id || "").length === 20 ? "score_history" : kind, x)).filter(Boolean);
}

// 证据核验核心：HTTP ?ref= 通道与 /api/agent1/evidence-check（verification_id 回执）共用同一套当前会话再授权逻辑
async function evidenceCheckCore(ref, ctx) {
  const user = requireUser(ctx.principal);
  const cix = ref.indexOf(":");
  const kind = ref.slice(0, cix); const id = ref.slice(cix + 1);
  const NOLEAK = { error: "not_found_or_stale", hint: "记录不存在、已失效或超出授权——不透露受限记录的存在性；请重新向 AI 查询（卡片数据不缓存）" };
  const sanitize = (s2) => String(s2).slice(0, 42).replace(/[^\w:.\-]/g, "_");
  const TABLE_KEY = { score: ["score_snapshots", "score_id"], score_history: ["score_history", "score_id"], risk: ["risk_snapshots", "snapshot_id"], ledger: ["deduction_ledger", "ledger_id"], queue: ["review_queue", "queue_id"], alert: ["alerts", "alert_id"], knowledge: ["knowledge_articles", "article_id"], course: ["training_courses", "course_id"] };
  const def = TABLE_KEY[kind];
  if (!def || !/^[\w:.,-]{1,100}$/.test(id)) { try { await appendAudit(ctx.principal, "ai.evidence_check", "ai_check", sanitize(kind) + ":rejected_ref", null, "bad_ref", ctx.requestId); } catch {} return { code: 404, payload: NOLEAK }; }
  try {
    if (kind === "knowledge") {
      const [aid, vtag] = String(id).split(".");
      const { latest } = await knowledgeLatestMap();
      const kr = latest.get(aid);
      if (!kr || kr.review_status !== "approved" || (user.role === "driver" && !["all", "driver"].includes(String(kr.applicable_role || "all")))) { try { await appendAudit(ctx.principal, "ai.evidence_check", "ai_check", "knowledge:non_official", null, "refused_scope", ctx.requestId); } catch {} return { code: 404, payload: NOLEAK }; }
      if (vtag && vtag !== String(kr.version_no)) return { code: 400, payload: { ok: false, ref, error: "stale_version", hint: `引用版本已更新：当前 approved 为 v${kr.version_no}` } };
      return { code: 200, payload: { ok: true, ref, route: `#/sm-knowledge?article_id=${encodeURIComponent(aid)}`, fresh: { article_id: aid, version_no: kr.version_no, review_status: "approved", title: kr.title } } };
    }
    const q = { select: "*", [def[1]]: `eq.${id}`, limit: 1 };
    if (user.role === "driver") {
      if (kind === "score") { delete q.select; q.select = "score_id,driver_id"; q.driver_id = `eq.${user.driver_id || "__none__"}`; }
      else if (kind === "ledger") { const gps = await ownGpsOf(ctx.principal); if (!gps) return { code: 404, payload: NOLEAK }; q.gpsno = `eq.${gps}`; }
      else if (kind === "risk") { const gps = await ownGpsOf(ctx.principal); if (!gps) return { code: 404, payload: NOLEAK }; q.gpsno = `eq.${gps}`; }
      else if (kind === "course") { q.content_status = "eq.approved"; }
      else if (["queue", "alert", "score_history", "knowledge"].includes(kind)) { try { await appendAudit(ctx.principal, "ai.evidence_check", "ai_check", kind + ":scope", null, "refused_scope", ctx.requestId); } catch {} return { code: 404, payload: NOLEAK }; }
    }
    const r = await dbRequest("get_rr_row", "GET", def[0], { query: q });
    const hit = r.data?.[0] || null;
    if (hit && ["safety_admin", "team_leader"].includes(user.role) && String(user.fleet_scope || "*") !== "*") {
      const s = await fleetScopeSets(String(user.fleet_scope));
      const viol = hit.gpsno ? !s.gps.includes(String(hit.gpsno)) : (hit.driver_id ? !s.drv.includes(String(hit.driver_id)) : true);
      if (viol) { try { await appendAudit(ctx.principal, "ai.evidence_check", "ai_check", kind + ":out_of_fleet_scope", null, "refused_scope", ctx.requestId); } catch {} return { code: 404, payload: NOLEAK }; }
    }
    if (user.role === "driver") { try { await appendAudit(ctx.principal, "ai.evidence_check", "ai_check", kind + (hit ? ":ok" : ":miss"), null, hit ? "ok" : "not_found_or_stale", ctx.requestId); } catch {} }
    if (!hit) return { code: 404, payload: NOLEAK };
    let route = null;
    if (user.role === "driver") route = kind === "score" || kind === "course" ? null : kind === "ledger" || kind === "risk" ? null : null;
    else route = (AI_CARD_ROUTES_ADMIN[kind] || (() => null))(hit);
    return { code: 200, payload: { ok: true, ref, route, reauthorized: "server_session", fresh: { as_of_date: hit.as_of_date || hit.occurred_at || null, source_version: hit.source_version || null, status: hit.status || hit.content_status || hit.review_status || null } } };
  } catch { return { code: 404, payload: NOLEAK }; }
}

async function handleEvidenceCheck(request, response, url, ctx) {
  const ref = String(url.searchParams.get("ref") || "").slice(0, 120);
  const r = await evidenceCheckCore(ref, ctx);
  return sendJson(response, r.code, r.payload);
}
// 第35轮：agent1 EvidenceVerifier 移植——verification_id 回执重验（5 分钟、属主绑定；重验走当前会话再授权）
async function handleAgentEvidenceCheck(request, response, url, ctx) {
  const user = requireUser(ctx.principal);
  const body = await readBody(request, 1024);
  const vid = String(body?.verification_id || "").slice(0, 60);
  aiSweepMaps();
  const rec = AI_VERIFICATIONS.get(vid);
  if (!rec || rec.owner !== user.user_id) {
    try { await appendAudit(ctx.principal, "ai.evidence_check", "ai_check", "verification:" + (rec ? "owner_mismatch" : "unknown_id"), null, "refused_scope", ctx.requestId); } catch {}
    return sendJson(response, 404, { error: "not_found_or_stale", hint: "回执不存在、已过期（5分钟）或不属于当前会话——不透露任何记录存在性；请重新向 AI 查询" });
  }
  const r = await evidenceCheckCore(rec.ref, ctx);
  if (r.code === 200) return sendJson(response, 200, { ok: true, verification_id: vid, evidence_ref: rec.ref, route: r.payload.route || null, fresh: r.payload.fresh || null, verified_at: nowIso() });
  return sendJson(response, r.code, { ...r.payload, verification_id: vid });
}

async function handleAiConfirm(request, response, url, ctx) {
  const user = requireUser(ctx.principal);
  const body = await readBody(request);
  const callId = String(body.ai_call_id || "").slice(0, 60);
  const decision = String(body.decision || "");
  const bizEntity = String(body.business_entity || "").slice(0, 40);
  const bizId = String(body.business_id || "").slice(0, 80);
  const bizAudit = String(body.business_audit_id || "").slice(0, 60);
  if (!/^aud-[\w-]+$/.test(callId) || !["adopted", "discarded"].includes(decision)) throw new HttpError(400, "bad_request");
  if (decision === "adopted" && (!bizEntity || !bizId)) throw new HttpError(409, "business_reference_required");
  const cur = await dbRequest("ai_audit_get", "GET", "audit_logs", { query: { entity_type: "eq.ai_call", entity_id: `eq.${callId}`, action: "eq.ai.chat", select: "audit_id,detail_json,actor_id,new_status,request_id", limit: 1 } });
  const call = cur.data?.[0];
  if (!call) throw new HttpError(404, "not_found");
  if (call.actor_id !== user.user_id) throw new HttpError(403, "forbidden_only_caller_can_confirm");
  const dup = await dbRequest("ai_audit_get", "GET", "audit_logs", { query: { entity_type: "eq.ai_call", entity_id: `eq.${callId}`, action: "eq.ai.confirm", select: "audit_id,new_status,detail_json,occurred_at", order: "occurred_at.asc", limit: 1 } });
  if (dup.data?.[0]) return sendJson(response, 200, { ok: true, idempotent_replay: true, confirm_audit_id: dup.data[0].audit_id, confirmed: dup.data[0].new_status, at: dup.data[0].occurred_at });
  const confirmId = newId("aud");
  await dbRequest("ai_audit_insert", "POST", "audit_logs", {
    body: [{ audit_id: confirmId, actor_id: user.user_id, actor_role: user.role, action: "ai.confirm", entity_type: "ai_call", entity_id: callId, old_status: call.new_status, new_status: decision,
      detail_json: JSON.stringify({ ai_call_id: callId, chat_request_id: call.request_id, decision, business_entity: bizEntity || null, business_id: bizId || null, business_audit_id: bizAudit || null, note: "人工确认事件；业务写入本身由对应门禁接口完成并自带审计，原始 ai.chat 事件不被改写" }),
      request_id: ctx.requestId || null, occurred_at: nowIso() }],
    headers: { Prefer: "return=minimal" },
  });
  sendJson(response, 200, { ok: true, confirm_audit_id: confirmId, ai_call_id: callId, status: decision });
}

async function aiGetConfirmStatus(callIds) {
  if (!callIds.length) return {};
  const r = await dbRequest("ai_audit_get", "GET", "audit_logs", { query: { entity_type: "eq.ai_call", action: "eq.ai.confirm", entity_id: `in.(${callIds.map((x) => `"${x}"`).join(",")})`, select: "entity_id,new_status,occurred_at,detail_json", order: "occurred_at.asc", limit: 40 } });
  const out = {}; for (const x of r.data || []) if (!out[x.entity_id]) out[x.entity_id] = { decision: x.new_status, at: x.occurred_at, business: (() => { try { return JSON.parse(x.detail_json).business_id || null; } catch { return null; } })() };
  return out;
}

// ---------- Section: HTTP dispatcher ----------
const API_ROUTES = [
  { method: "POST", path: "/api/auth/login", needAuth: false, handler: handleLogin },
  { method: "POST", path: "/api/auth/logout", needAuth: true, handler: handleLogout },
  { method: "GET", path: "/api/me", needAuth: false, handler: handleMe },
  { method: "GET", path: "/api/me/profile", needAuth: true, handler: handleOwnProfile },
  { method: "POST", path: "/api/me/profile", needAuth: true, handler: handleOwnProfile },
  { method: "GET", path: "/api/analysis/root-causes", needAuth: true, handler: handleRootCauses },
  { method: "GET", path: "/api/driver/fleet-summary", needAuth: true, handler: handleDriverFleetSummary },
  { method: "GET", path: "/api/driver/reports/today", needAuth: true, handler: handleDailyReportToday },
  { method: "GET", path: "/api/driver/reports/history", needAuth: true, handler: handleDailyReportHistory },
  { method: "GET", pathPrefix: "/api/driver/reports/", needAuth: true, handler: handleDailyReportDetail },
  { method: "GET", path: "/api/driver/safety-goals", needAuth: true, handler: handleDailySafetyGoals },
  { method: "POST", pathPrefix: "/api/driver/safety-goals/", needAuth: true, handler: handleDailyGoalFeedback },
  { method: "GET", path: "/api/driver/notifications", needAuth: true, handler: handleDailyReportNotifications },
  { method: "POST", path: "/api/admin/daily-reports/run", needAuth: true, handler: handleDailyReportRun },
  { method: "GET", path: "/api/admin/daily-reports/jobs", needAuth: true, handler: handleDailyReportJobs },
  { method: "GET", path: "/api/driver/action-center", needAuth: true, handler: handleDriverActionCenter },
  { method: "GET", path: "/api/driver/score-comparison", needAuth: true, handler: handleDriverScoreComparison },
  { method: "GET", path: "/api/driver/intervention", needAuth: true, handler: handleDriverInterventionView },
  { method: "GET", path: "/api/driver/risk-center", needAuth: true, handler: handleDriverRiskCenter },
  { method: "GET", path: "/api/driver/evidence", needAuth: true, handler: handleDriverEvidence },
  { method: "GET", path: "/api/driver/learning-report", needAuth: true, handler: handleLearningReport },
  { method: "GET", path: "/api/rm/drop7", needAuth: true, handler: handleDrop7 },
  { method: "GET", path: "/api/overview", needAuth: true, handler: handleOverview },
  { method: "GET", path: "/api/meta/history-dates", needAuth: true, handler: handleHistoryDates },
  { method: "POST", path: "/api/ai/chat", needAuth: true, handler: handleAiChat },
  { method: "GET", path: "/api/ai/selftest", needAuth: true, handler: handleAiSelftest },
  { method: "POST", path: "/api/ai/task-summary", needAuth: true, cap: "review.training_feedback", handler: handleTaskSummary },
  { method: "GET", path: "/api/ai/preplan", needAuth: true, handler: handleAiPreplan },
  { method: "POST", path: "/api/ai/confirm", needAuth: true, handler: handleAiConfirm },
  { method: "GET", path: "/api/ai/evidence-check", needAuth: true, handler: handleEvidenceCheck },
  { method: "POST", path: "/api/agent1/evidence-check", needAuth: true, handler: handleAgentEvidenceCheck },
  { method: "GET", path: "/api/ai/calls", needAuth: true, handler: async (request, response, url, ctx) => {
    const user = requireUser(ctx.principal);
    const ids = String(url.searchParams.get("ids") || "").split(",").map((x) => x.trim()).filter((x) => /^aud-[\w-]+$/.test(x)).slice(0, 12);
    const confirms = {};
    for (const callId of ids) {
      const own = await dbRequest("ai_audit_get", "GET", "audit_logs", { query: { entity_type: "eq.ai_call", entity_id: `eq.${callId}`, action: "eq.ai.chat", select: "actor_id", limit: 1 } });
      if (!own.data?.length || own.data[0].actor_id !== user.user_id) continue;
      const cf = await dbRequest("ai_audit_get", "GET", "audit_logs", { query: { entity_type: "eq.ai_call", entity_id: `eq.${callId}`, action: "eq.ai.confirm", select: "new_status,occurred_at,detail_json", order: "occurred_at.asc", limit: 1 } });
      const c0 = cf.data?.[0];
      if (c0) { let biz = null; try { biz = JSON.parse(c0.detail_json || "{}").business_id || null; } catch {} confirms[callId] = { decision: c0.new_status, at: c0.occurred_at, business: biz }; }
    }
    sendJson(response, 200, { confirms });
  } },
  { method: "GET", pathPrefix: "/api/data/", needAuth: true, handler: handleData },
  { method: "POST", path: "/api/import/check", needAuth: true, cap: "import.data", handler: handleImportCheck },
  { method: "POST", path: "/api/import/commit", needAuth: true, cap: "import.data", handler: handleImportCommit },
  { method: "POST", path: "/api/admin/bindings", needAuth: true, cap: "manage.bindings", handler: handleBindingSet },
  { method: "GET", path: "/api/admin/bindings", needAuth: true, cap: "manage.bindings", handler: handleBindingsList },
  { method: "GET", path: "/api/admin/binding-conflicts", needAuth: true, cap: "manage.bindings", handler: handleBindingPreview },
  { method: "POST", path: "/api/admin/binding-reschedule", needAuth: true, cap: "manage.bindings", handler: (r, s, u, c) => handleBindingReschedule(r, s, u, c, null) },
  { method: "POST", path: "/api/admin/binding-delete", needAuth: true, cap: "manage.bindings", handler: handleBindingDelete },
  { method: "POST", path: "/api/admin/course-review", needAuth: true, cap: "review.content", handler: handleCourseReview },
  { method: "GET", path: "/api/admin/courses", needAuth: true, handler: handleCoursesBoard },
  { method: "GET", path: "/api/admin/ops", needAuth: true, handler: handleOpsList },
  { method: "GET", path: "/api/admin/templates", needAuth: true, cap: "manage.knowledge", handler: handleTemplatesAdmin },
  { method: "POST", path: "/api/admin/templates", needAuth: true, cap: "manage.knowledge", handler: handleTemplatesAdmin },
  { method: "GET", path: "/api/admin/template-preview", needAuth: true, cap: "manage.knowledge", handler: handleTemplatePreview },
  { method: "POST", path: "/api/admin/course-draft", needAuth: true, cap: "review.content", handler: handleCourseDraft },
  { method: "PATCH", path: "/api/admin/course-draft", needAuth: true, cap: "review.content", handler: handleCourseDraft },
  { method: "GET", path: "/api/admin/audit", needAuth: true, cap: "view.audit", handler: handleAuditConsole },
  { method: "POST", path: "/api/admin/ops-config", needAuth: true, cap: "manage.operation_config", handler: handleOpsConfigUpdate },
  { method: "POST", path: "/api/admin/training-assign", needAuth: true, cap: "assign.training", handler: handleTrainingAssign },
  { method: "POST", path: "/api/alerts/confirm", needAuth: true, cap: "handle.alert", handler: handleAlertConfirm },
  { method: "POST", path: "/api/review-requests", needAuth: true, cap: "submit.score_challenge", handler: handleRRCreate },
  { method: "POST", path: "/api/admin/users", needAuth: true, cap: "manage.accounts", handler: handleAdminUserCreate },
  { method: "GET", path: "/api/notes/summary", needAuth: true, handler: handleNotesSummary },
  { method: "GET", path: "/api/meta/egress-probe", needAuth: true, handler: handleEgressProbe },
  { method: "GET", path: "/api/search", needAuth: true, cap: "global.search", handler: handleGlobalSearch },
  { method: "GET", path: "/api/admin/rule-drafts", needAuth: true, cap: "manage.rule_drafts", handler: handleRuleDrafts },
  { method: "POST", path: "/api/admin/rule-drafts", needAuth: true, cap: "manage.rule_drafts", handler: handleRuleDrafts },
  { method: "GET", path: "/api/admin/knowledge", needAuth: true, cap: "manage.knowledge", handler: handleKnowledgeAdmin },
  { method: "POST", path: "/api/admin/knowledge", needAuth: true, cap: "manage.knowledge", handler: handleKnowledgeAdmin },
  { method: "PATCH", path: "/api/admin/knowledge", needAuth: true, cap: "manage.knowledge", handler: handleKnowledgeAdmin },
  { method: "POST", path: "/api/admin/evaluation-rules", needAuth: true, handler: async () => { throw new HttpError(410, "frozen_rules_not_writable"); } },
  { method: "PATCH", path: "/api/admin/evaluation-rules", needAuth: true, handler: async () => { throw new HttpError(410, "frozen_rules_not_writable"); } },
];


const CASE_ROUTES = [
  { method: "PATCH", re: /^\/api\/alerts\/([^/]+)\/status$/, h: handleAlertStatus },
  { method: "PATCH", re: /^\/api\/admin\/rule-drafts\/([^/]+)$/, h: (req, res, url, ctx, id) => handleRuleDrafts(req, res, url, ctx, decodeURIComponent(String(id))) },
  { method: "PATCH", re: /^\/api\/admin\/knowledge\/([^/]+)$/, h: (req, res, url, ctx, id) => handleKnowledgeAdmin(req, res, url, ctx, decodeURIComponent(String(id))) },
  { method: "POST", re: /^\/api\/alerts\/([^/]+)\/intervention$/, h: handleInterventionDraft },
  { method: "PATCH", re: /^\/api\/interventions\/([^/]+)\/draft$/, h: handleDraftEdit },
  { method: "POST", re: /^\/api\/interventions\/([^/]+)\/send$/, h: handleInterventionSend },
  { method: "POST", re: /^\/api\/interventions\/([^/]+)\/read$/, h: handleInterventionRead },
  { method: "POST", re: /^\/api\/interventions\/([^/]+)\/reply$/, h: handleInterventionReply },
  { method: "GET", re: /^\/api\/cases\/([^/]+)$/, h: handleCaseView },
  { method: "POST", re: /^\/api\/training-tasks\/([^/]+)\/start$/, h: handleTaskStart },
  { method: "PATCH", re: /^\/api\/training-tasks\/([^/]+)\/draft$/, h: handleTaskDraftSave },
  { method: "POST", re: /^\/api\/training-tasks\/([^/]+)\/submit$/, h: handleTaskSubmit },
  { method: "POST", re: /^\/api\/training-tasks\/([^/]+)\/review$/, h: handleTaskReview, cap: "review.training_feedback" },
  { method: "POST", re: /^\/api\/training-tasks\/([^/]+)\/retry-notification$/, h: handleTaskNotificationRetry },
  { method: "GET", re: /^\/api\/training-tasks\/([^/]+)$/, h: handleTaskView },
  { method: "GET", re: /^\/api\/review-requests\/([^/]+)$/, h: handleRRView },
  { method: "POST", re: /^\/api\/review-requests\/([^/]+)\/advance$/, h: handleRRAdvance },
  { method: "POST", re: /^\/api\/alerts\/([^/]+)\/handoff$/, h: (q, r, u, cx, id) => handleAlertPatch(q, r, u, cx, id, "handoff") },
  { method: "POST", re: /^\/api\/alerts\/([^/]+)\/note$/, h: (q, r, u, cx, id) => handleAlertPatch(q, r, u, cx, id, "note") },
  { method: "POST", re: /^\/api\/alerts\/([^/]+)\/contact$/, h: (q, r, u, cx, id) => handleAlertPatch(q, r, u, cx, id, "contact") },
  { method: "POST", re: /^\/api\/admin\/users\/([^/]+)\/status$/, h: handleAdminUserStatus },
  { method: "GET", re: /^\/api\/admin\/audit\/([^/]+)$/, h: (req, res, url, ctx, id) => handleAuditDetail(req, res, url, ctx, decodeURIComponent(String(id))) },
  { method: "PATCH", re: /^\/api\/admin\/users\/([^/]+)$/,  h: (req, res, url, ctx, id) => handleAdminUserEdit(req, res, url, ctx, decodeURIComponent(String(id))) },
  { method: "PATCH", re: /^\/api\/admin\/templates\/([^/]+)$/, h: (req, res, url, ctx, id) => handleTemplatesAdmin(req, res, url, ctx, decodeURIComponent(String(id))) },
  { method: "POST", re: /^\/api\/notes\/([^/]+)\/read$/, h: handleNoteRead },
  { method: "GET", re: /^\/api\/notes$/, h: handleMyNotes },
];
function crOf(pn) {
  if (pn.startsWith("/api/interventions/") && pn.endsWith("/draft")) return "send.intervention";
  if (pn.endsWith("/retry-notification")) return "assign.training";
  if (pn.endsWith("/review")) return "review.training_feedback";
  if (pn.endsWith("/start") || pn.endsWith("/submit") || pn.endsWith("/draft")) return "view.my_training";
  if (pn.endsWith("/read") || pn.endsWith("/reply")) return null; // 司机本人路由内handler强制
  if (pn.includes("/api/interventions/")) return "send.intervention";
  if (pn.startsWith("/api/cases/")) return "view.alerts";
  if (pn.startsWith("/api/training-tasks/")) return null;
  if (pn === "/api/review-requests/undefined") return null;
  if (pn === "/api/notes" || pn.startsWith("/api/notes/")) return null; // 本人通道：handler内部按会话target强制
  if (pn.endsWith("/handoff") || pn.endsWith("/note") || pn.endsWith("/contact")) return "handle.alert";
  if (pn.endsWith("/status")) return "manage.accounts";
  if (pn.endsWith("/advance")) return "review.score_challenge";
  if (pn.startsWith("/api/review-requests/")) return null;
  return "handle.alert";
}
function matchCaseRoute(method, pathname) {
  for (const cr of CASE_ROUTES) {
    if (cr.method !== method) continue;
    const m = pathname.match(cr.re);
    if (m) {
      const id = decodeURIComponent(m[1]).slice(0, 80);
      if (!/^[\w:,.-]+$/.test(id)) return null;
      return { route: { needAuth: true, cap: (crOf(pathname)), handler: cr.h }, id };
    }
  }
  return null;
}

const server = createServer(async (request, response) => {
  const requestId = newId("req");
  try {
    const url = new URL(request.url ?? "/", "http://qwenwork.local");
    if (process.env.IE_LOCAL_SOURCE_ONLY === "1" && (/^\/api\/(ai|agent1)\//.test(url.pathname) || url.pathname === "/api/meta/egress-probe")) {
      sendJson(response, 503, { error: "local_source_only", note: "当前仅使用IE亮剑本地材料，不调用外部模型或数据服务。" }); return;
    }
    if (process.env.IE_LOCAL_SOURCE_ONLY === "1" && (url.pathname.startsWith("/api/import/") || url.pathname === "/api/admin/course-draft" || (request.method !== "GET" && /^\/api\/admin\/(knowledge|templates)/.test(url.pathname)))) {
      sendJson(response, 403, { error: "local_source_files_only", note: "本地候选仅使用IE亮剑已登记文件，不接收额外业务数据或专业内容。" }); return;
    }
    // 健康检查先于一切鉴权（部署验证探针）
    if (url.pathname === "/healthz" || url.pathname === "/api/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      let route = API_ROUTES.find((r) =>
        (r.path ? url.pathname === r.path : url.pathname.startsWith(r.pathPrefix)) && r.method === request.method);
      let caseId = null;
      if (!route) {
        const dyn = matchCaseRoute(request.method, url.pathname);
        if (dyn) { route = dyn.route; caseId = dyn.id; }
      }
      if (!route) { sendJson(response, 404, { error: "not_found" }); return; }
      const principal = await authenticate(request).catch(() => null);
      if (route.needAuth && !principal?.user) throw new HttpError(401, "unauthenticated");
      if (route.cap && !(ROLE_CAPABILITIES[principal.user.role] || new Set()).has(route.cap)) throw new HttpError(403, "forbidden");
      await route.handler(request, response, url, { principal, requestId, caseId }, caseId);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      sendRaw(response, 405, "Method Not Allowed", "text/plain; charset=utf-8");
      return;
    }
    const file = await resolveClientFile(url.pathname);
    if (!file) { sendRaw(response, 404, "Not Found", "text/plain; charset=utf-8"); return; }
    const body = request.method === "HEAD" ? undefined : await readFile(file);
    sendRaw(response, 200, body, contentTypes.get(extname(file).toLowerCase()) ?? "application/octet-stream");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const code = error instanceof HttpError ? error.code : "internal_error";
    if (status >= 500) console.error(`request failed request_id=${requestId} status=${status} stack=${(error && error.stack ? String(error.stack).slice(0,400) : error)}`);
    try { sendJson(response, status, { error: code, request_id: requestId }); } catch { /* already sent */ }
  }
});

server.listen(port, host, () => { console.log(`Crazy Logi-AI workbench server on http://${host}:${port}`); });
setInterval(() => { void dailyTick(); }, 60000).unref?.();
setTimeout(() => { void dailyTick(); }, 4000).unref?.();
