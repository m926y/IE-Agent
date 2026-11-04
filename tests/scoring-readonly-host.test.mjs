// R61 云端评分口径只读视图：GET /api/admin/score-weights 在托管模式回 200 + 当前生效权重（不再显示"重算服务不可用"），
// 但预览/生效/设计/历史对比仍是本地完整数据工作台专属（503），云端绝不重算或改写评分。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { startFixtureDatabase, passwordHash } from './fixtures/account-db.mjs';

const RULES = [
  { dimension: 'driving_stability', dimension_name: '驾驶稳定性', weight: 0.26599176948568987, window_days: 14, score_method: 'fixed_exposure_event_increment_v2', editable: false, source_version: 'snapshot_ffbc02143fcb' },
  { dimension: 'fatigue_distraction', dimension_name: '疲劳与分心', weight: 0.139679, window_days: 1, score_method: 'fixed_exposure_event_increment_v2', editable: false, source_version: 'ruleset_v13_20261102' },
  { dimension: 'history', dimension_name: '历史事故与未遂', weight: 0.26599176948568987, window_days: 14, score_method: 'fixed_exposure_event_increment_v2', editable: false, source_version: 'snapshot_ffbc02143fcb' },
  { dimension: 'imu_evidence', dimension_name: 'IMU风险佐证', weight: 0.1, window_days: 14, score_method: 'fixed_exposure_event_increment_v2', editable: false, source_version: 'snapshot_ffbc02143fcb' },
  { dimension: 'management', dimension_name: '管理配合度', weight: 0.15450512206513758, window_days: 14, score_method: 'fixed_exposure_event_increment_v2', editable: false, source_version: 'snapshot_ffbc02143fcb' },
  { dimension: 'road_rule', dimension_name: '道路规则风险', weight: 0.07383197351173076, window_days: 14, score_method: 'fixed_exposure_event_increment_v2', editable: false, source_version: 'snapshot_ffbc02143fcb' },
];

test('hosted read-only scoring view (R61)', async (t) => {
  const schema = JSON.parse(readFileSync(new URL('./fixtures/cloud-schema.json', import.meta.url), 'utf8'));
  delete schema._comment;
  assert.ok(schema.evaluation_rules, '夹具缺少 evaluation_rules');
  const db = await startFixtureDatabase({ schema });
  const tables = db.tables;
  for (const n of Object.keys(schema)) tables[n] ||= [];
  tables.app_users = [{ user_id: 'u-a', username: 'r61_admin', display_name: '管理员', role: 'safety_admin', fleet_scope: '*', account_status: 'active', password_hash: passwordHash('R61Admin2026'), must_change_password: false, binding_verified: false }];
  tables.audit_logs = []; tables.score_snapshots = [{ score_id: 'S1', driver_id: 'D001', gpsno: 'G1' }];
  tables.evaluation_rules = RULES.map((r) => ({ ...r }));
  const sv = createServer(); await new Promise((r) => sv.listen(0, '127.0.0.1', r)); const port = sv.address().port; await new Promise((r) => sv.close(r));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('../', import.meta.url), windowsHide: true,
    env: { HOST: '127.0.0.1', PORT: String(port), SUPABASE_URL: db.url, SUPABASE_ANON_KEY: 'test', SUPABASE_INSTANCE_ID: 'fixture' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; child.stderr.on('data', (x) => { log += x });
  const base = `http://127.0.0.1:${port}`;
  t.after(() => { child.kill(); db.close(); });
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch { } await new Promise((r) => setTimeout(r, 50)); }
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'r61_admin', password: 'R61Admin2026' }) });
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  async function get(path) { const r = await fetch(base + path, { headers: { cookie: cookie || '' } }); let j = null; try { j = await r.json(); } catch { } return { status: r.status, body: j } }
  async function post(path, body) { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookie || '' }, body: JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch { } return { status: r.status, body: j } }

  await t.test('当前权重以只读方式返回，不再报"重算服务不可用"', async () => {
    const r = await get('/api/admin/score-weights');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.hosted_readonly, true);
    assert.equal(Object.keys(r.body.weights).length, 6);
    const sum = Object.values(r.body.weights).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-6, '权重合计应为 1：' + sum);
    assert.equal(r.body.weights.imu_evidence, 0.1);
    assert.equal(r.body.active_version, 'original', '云端评分口径版本与 /api/score-version 一致');
    assert.equal(r.body.designs.length, 0);
    assert.match(r.body.hosted_note, /不在此页预览、重算或生效/);
    assert.equal(r.body.window_days, 14, '窗口来自随发行交付的冻结模型定义');
    assert.equal(r.body.dimension_windows.fatigue_distraction, 1, '各维度自身窗口如实透出（在线表即为 1）');
    assert.ok(Array.isArray(r.body.factors) && r.body.factors.length === 6, '因子按维度分组只读展示');
    assert.ok(r.body.factors.every((f) => f.events.every((e) => typeof e.severity === 'number')));
    assert.equal(r.body.model_config.half_life_days, 14);
    assert.deepEqual(r.body.model_config.level_ratios, { A: 20, B: 40, C: 30, D: 10 }, '等级占比取自冻结生效链（供只读展示）');
    assert.ok(r.body.reference && Object.values(r.body.reference).every((x) => x.tau !== null), '参考口径取自冻结文件');
    assert.equal(r.body.vehicle_count, 1);
  });

  await t.test('写入与重算入口在云端仍然关闭', async () => {
    const preview = await post('/api/admin/score-weights/preview', { weights: r61Weights(), base_version: 'original' });
    assert.equal(preview.status, 503);
    assert.equal(preview.body.error, 'scoring_service_unavailable');
    const apply = await post('/api/admin/score-weights/apply', { weights: r61Weights(), base_version: 'original', label: 'x', reason: 'y' });
    assert.equal(apply.status, 503);
    const design = await post('/api/admin/score-weights/design', { weights: r61Weights(), label: 'x', reason: 'y' });
    assert.equal(design.status, 503);
    const frozenRules = await post('/api/admin/evaluation-rules', { dimension: 'history', weight: 0.5 });
    assert.equal(frozenRules.status, 410, '冻结规则表任何模式都不可直接写');
    const version = await get('/api/score-version');
    assert.equal(version.body.version, 'original');
    /* 只读视图不得改动评分数据 */
    assert.equal(tables.score_snapshots.length, 1);
    assert.equal(tables.audit_logs.filter((a) => String(a.action).startsWith('scoring')).length, 0);
  });

  /* 503 是本轮预期结果（写入入口保持关闭），只断言没有真正的代码异常 */
  assert.equal(/TypeError|ReferenceError|SyntaxError/.test(log), false, log.slice(-400));
});
function r61Weights() { return Object.fromEntries(RULES.map((r) => [r.dimension, r.weight])); }
