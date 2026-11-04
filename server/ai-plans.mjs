// R60：AI 聊天的「待确认清单」（action plan）在云端的实现。
// 本地完整版放在 SQLite agent_plans；托管运行时文件系统是临时的，因此清单存页面隔离库 ai_action_plans（迁移018），
// 30 分钟过期、仅创建者本人可执行、口令绝不入清单（密码只在执行响应里一次性返回）。
// 业务写入仍由既有门禁接口完成（AI 零写库红线不变）。
import { randomUUID } from 'node:crypto';

/* 清单有效期 24 小时（原 30 分钟）：培训与课程清单常在下班前统一确认，窗口过短会表现为『确认不了／像没创建』；
 * 过期后仍拒绝执行（agent_plan_expired→410），必须重新查库生成新清单，不做无限期复用。 */
const PLAN_TTL_MS = 24 * 60 * 60 * 1000;
const fail = (code, detail) => { const e = new Error(code); e.code = code; if (detail) e.detail = detail; return e; };
const nowIso = () => new Date().toISOString();
const ACCOUNT_KEYS = ['username', 'display_name', 'role', 'vehicle'];
const ROLES = ['driver', 'team_leader', 'safety_admin', 'safety_officer'];

/* ---------- 清单存取 ---------- */
export function createAiPlans(db) {
  async function save(actor, kind, payload, preview, source) {
    const id = 'plan-' + randomUUID();
    const at = nowIso();
    const row = { plan_id: id, owner_user_id: String(actor.user_id), owner_scope: String(actor.fleet_scope || '*'), kind, state: 'pending', source: source || null, payload_json: JSON.stringify(payload), preview_json: JSON.stringify(preview), result_json: null, created_at: at, expires_at: new Date(Date.now() + PLAN_TTL_MS).toISOString() };
    await db.insert(row);
    try { await db.sweepExpired(at) } catch { /* 清理失败不影响本次清单 */ }
    return { id, kind, state: 'pending', expires_at: row.expires_at, ...preview };
  }
  async function get(id, actor) {
    const row = await db.load(String(id));
    if (!row) throw fail('agent_not_found');
    if (String(row.owner_user_id) !== String(actor.user_id)) throw fail('agent_forbidden');
    if (String(row.owner_scope || '*') !== String(actor.fleet_scope || '*')) throw fail('agent_scope_changed');
    if (String(row.expires_at) < nowIso() && row.state !== 'complete') throw fail('agent_plan_expired');
    let preview = {}; try { preview = JSON.parse(row.preview_json || '{}') } catch {}
    let result = null; try { result = row.result_json ? JSON.parse(row.result_json) : null } catch {}
    return { id: row.plan_id, kind: row.kind, state: row.state, expires_at: row.expires_at, payload: row.payload_json, ...preview, ...(result ? { result } : {}) };
  }
  async function markComplete(id, result) { await db.markComplete(id, JSON.stringify(result)) }
  return { save, get, load: (id) => db.load(String(id)), markComplete, PLAN_TTL_MS };
}

/* ---------- 账号表校验（与本地 agent-store.accountPlan 同规则，服务端权威） ----------
 * ctx: { actorRole, actorScope, usernameTaken(username)->bool, findVehicle(text,labelNo)->[{driver_id,gpsno,fleet_id,display_no}], vehicleBoundByOther(driver_id)->bool } */
export async function checkAccountRows(rows, ctx) {
  const errors = []; const seen = new Set(); const seenVehicles = new Set(); const normalized = [];
  if (!Array.isArray(rows)) throw fail('account_batch_size_invalid');
  if (rows.length < 1 || rows.length > 200) throw fail('account_batch_size_invalid', '请上传1–200行账号数据，另加一行表头');
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const username = String(r.username || '').trim().toLowerCase();
    const display_name = String(r.display_name || username).trim();
    const role = String(r.role || 'driver').trim();
    const no = i + 2;
    if (Object.keys(r).some((k) => !ACCOUNT_KEYS.includes(k))) errors.push({ row: no, reason: '仅允许用户名、显示名、角色、对应车辆；不要提供密码' });
    if (!/^[a-z0-9_.-]{3,32}$/.test(username)) errors.push({ row: no, reason: '用户名须为3–32位字母、数字、点、下划线或连字符' });
    if (!display_name || display_name.length > 60) errors.push({ row: no, reason: '显示名须为1–60字' });
    if (!ROLES.includes(role)) errors.push({ row: no, reason: '角色无效' });
    if (seen.has(username) || (await ctx.usernameTaken(username))) errors.push({ row: no, reason: '用户名重复或已存在' });
    if (role === 'safety_admin' && ctx.actorRole !== 'safety_admin') errors.push({ row: no, reason: '仅管理员可创建管理员' });
    if (role === 'safety_admin' && ctx.actorScope !== '*') errors.push({ row: no, reason: '受限范围管理员不能创建管理员' });
    seen.add(username);
    const vehicle = String(r.vehicle || '').trim();
    let binding = null;
    if (vehicle) {
      if (role !== 'driver') errors.push({ row: no, reason: '只有司机账号可以填写对应车辆' });
      const label = /^(?:车辆|车)?\s*(\d+)$/.exec(vehicle);
      const matches = await ctx.findVehicle(vehicle, label ? Number(label[1]) : -1);
      if (!Array.isArray(matches) || matches.length !== 1) errors.push({ row: no, reason: '对应车辆不存在或不唯一，请填写车辆编号，例如车辆152' });
      else {
        binding = matches[0];
        const key = String(binding.driver_id);
        if (seenVehicles.has(key)) errors.push({ row: no, reason: '同一车辆不能在表格中重复分配' });
        seenVehicles.add(key);
        if (await ctx.vehicleBoundByOther(key)) errors.push({ row: no, reason: '该车辆已被其他司机账号绑定' });
      }
    }
    normalized.push({ username, display_name, role, ...(binding ? { driver_id: binding.driver_id, gpsno: binding.gpsno, fleet_id: binding.fleet_id || null, vehicle: '车辆' + binding.display_no } : {}) });
  }
  if (errors.length) return { valid: false, count: rows.length, errors };
  return {
    valid: true,
    count: rows.length,
    rows: normalized.map(({ driver_id, gpsno, fleet_id, ...rest }) => ({ ...rest, vehicle: rest.vehicle || '稍后绑定' })),
    role_counts: Object.fromEntries(ROLES.map((k) => [k, normalized.filter((r) => r.role === k).length])),
    normalized,
  };
}

/* ---------- 培训对象筛选（2026-11-03 决定：内置 Agent 可发放对象 = 所有评级、所有可信度的有效绑定司机） ----------
 * 唯一硬前提：账号启用 + 司机角色 + 该车辆唯一已核实绑定。评级/可信度不再限制 Agent，
 * 手工分发（TR02）、分层计划与风险处置入口保留各自门禁（C/D、低可信度先核验），不因本条放开。
 * 低可信度对象可以学习课程，但不能据此认定行为风险或奖惩——由清单的 note/限制声明说明。
 * cohort：a/b/c/d/cd/low_confidence/all/vehicle（vehicle 需 gpsno）。 */
export function filterTrainingCohort(rows, cohort, gpsno) {
  const c = String(cohort || '');
  if (!['a', 'b', 'c', 'd', 'cd', 'low_confidence', 'all', 'vehicle'].includes(c)) throw fail('training_cohort_required');
  if (c === 'vehicle' && !gpsno) throw fail('training_vehicle_required');
  const out = (Array.isArray(rows) ? rows : []).filter((s) => c === 'a' ? s.risk_level === 'A' : c === 'b' ? s.risk_level === 'B' : c === 'c' ? s.risk_level === 'C' : c === 'd' ? s.risk_level === 'D'
    : c === 'cd' ? ['C', 'D'].includes(s.risk_level) : c === 'low_confidence' ? String(s.confidence_level) === 'low' : c === 'vehicle' ? String(s.gpsno) === String(gpsno) : true);
  if (c === 'vehicle' && !out.length) throw fail('training_vehicle_not_found');
  return out;
}
/* accountsOf(driver_id) → 该 Driver 当前有效绑定的司机账号数组（只能 1 个才纳入清单）。 */
export async function selectTrainingTargets(rows, labelsOf, accountsOf) {
  const ready = [], skipped = [];
  for (const r of rows) {
    const users = await accountsOf(r.driver_id);
    const label = '车辆' + (labelsOf(r.gpsno) || r.gpsno);
    if (!Array.isArray(users) || users.length !== 1) { skipped.push({ vehicle: label, reason: Array.isArray(users) && users.length > 1 ? '该车辆绑定多个司机账号，需先人工核实' : '未绑定唯一的有效司机账号' }); continue }
    ready.push({ gpsno: String(r.gpsno), driver_id: String(r.driver_id), user_id: String(users[0].user_id), vehicle: label, risk_level: r.risk_level || null, confidence_level: r.confidence_level || null, source_version: r.source_version || null });
  }
  return { ready, skipped };
}
/* mandatory：清单显式值优先，否则按现行 operation_config.training_mandate_policy（与手工分发同源）。 */
export function mandatoryFor(policy, level, explicit) {
  if (typeof explicit === 'boolean') return explicit;
  return String(policy?.[level] || '') === 'mandatory';
}
