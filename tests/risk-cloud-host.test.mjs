// R54：云端风险面服务找回的宿主契约测试（隔离夹具库 + fetch 桩模型；不访问真实业务库/真实模型）。
// 覆盖：/api/risk/live·metadata 的诚实只读形、RM02 数据资源可见性、case-training 云端建议路径
// （无模型回退 / 桩模型成功 / 草案路径诚实 503 / 越权与司机角色拒绝）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureDatabase, passwordHash } from './fixtures/account-db.mjs';

const stubSrc = `
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (url.startsWith('https://ai-stub.invalid')) {
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ advice: '建议先与该司机核实设备遮挡情况，安排停车检查摄像头角度；证据核对完成前不判定行为。' }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return real(input, init);
};`;

async function boot(extraEnv = {}) {
  const db = await startFixtureDatabase();
  const day = '2026-07-29';
  for (const t of ['replay_events', 'alerts', 'training_tasks', 'training_courses', 'vehicle_labels', 'app_users', 'user_bindings', 'audit_logs', 'notification_events', 'daily_report_jobs']) db.tables[t] ||= [];
  db.tables.replay_events.push(
    { event_id: 'E1', gpsno: 'TEST-VEHICLE-RAW-01', driver_id: 'driver-one', event_time: day + ' 08:00:01', event_type: 30002, event_name: '左车道偏移', dimension: 'driving_stability', replay_date: day, is_replay: true, source_version: 'v1' },
    { event_id: 'E2', gpsno: 'TEST-VEHICLE-RAW-01', driver_id: 'driver-one', event_time: day + ' 08:10:02', event_type: 30002, event_name: '左车道偏移', dimension: 'driving_stability', replay_date: day, is_replay: true, source_version: 'v1' },
    { event_id: 'E3', gpsno: 'TEST-VEHICLE-RAW-02', driver_id: 'driver-two', event_time: day + ' 09:00:03', event_type: 30006, event_name: '疲劳迹象', dimension: 'fatigue_distraction', replay_date: day, is_replay: true, source_version: 'v1' },
  );
  db.tables.alerts.push({ alert_id: 'A1', gpsno: 'TEST-VEHICLE-RAW-01', driver_id: 'driver-one', rule_code: 'REPLAY_stability', evidence_id: 'E2', occurred_at: day + ' 08:10:02', status: 'pending_review', is_replay: true });
  db.tables.training_tasks.push({ task_id: 'T1', driver_id: 'driver-one', course_id: 'c1', status: 'reviewed', due_at: null, updated_at: '2026-08-01T00:00:00Z' });
  db.tables.training_courses.push({ course_id: 'c1', title: '车道保持基础', dimension: 'driving_stability', content_status: 'approved', version_no: 1, source_version: 'sv1', updated_at: '2026-08-01T00:00:00Z' });
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  let argv = ['server.mjs'], env = { HOST: '127.0.0.1', PORT: String(port), SUPABASE_URL: db.url, SUPABASE_ANON_KEY: 'test', SUPABASE_INSTANCE_ID: 'fixture' };
  if (extraEnv.stubAI) {
    const dir = mkdtempSync(join(tmpdir(), 'r54-stub-'));
    const preload = join(dir, 'ai-stub.cjs'); writeFileSync(preload, stubSrc);
    argv = ['--require', preload, 'server.mjs'];
    Object.assign(env, { QW_AI_BASE_URL: 'https://ai-stub.invalid', QW_AI_API_KEY: 'stub-key-abcdefghij', QW_AI_MODEL: 'stub-model' });
  }
  const child = spawn(process.execPath, argv, { cwd: new URL('../', import.meta.url), windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x);
  const base = `http://127.0.0.1:${port}`;
  async function call(path, { cookie, method = 'GET', body } = {}) {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch { }
    return { status: r.status, body: j, cookie: r.headers.get('set-cookie')?.split(';')[0] };
  }
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch { } await new Promise(r => setTimeout(r, 50)); }
  const adminCookie = (await call('/api/auth/login', { method: 'POST', body: { username: 'preview_admin', password: 'PreviewAdmin2026' } })).cookie;
  const driverCookie = (await call('/api/auth/login', { method: 'POST', body: { username: 'preview_driver', password: 'PreviewDriver2026' } })).cookie;
  return { db, child, call, adminCookie, driverCookie, base, get output() { return output; } };
}

test('cloud risk services: metadata/live honest read-only shape (R54)', async () => {
  const env = await boot();
  try {
    const m = await env.call('/api/risk/metadata', { cookie: env.adminCookie });
    assert.equal(m.status, 200, JSON.stringify(m.body));
    assert.equal(m.body.can_create, false);
    assert.equal(m.body.default_date, '2026-07-29');
    assert.ok(Array.isArray(m.body.vehicles) && m.body.vehicles.length >= 2);
    assert.ok(m.body.vehicles.every(v => typeof v.gpsno === 'string' && typeof v.bound === 'boolean'));
    assert.match(String(m.body.hosted_note), /RM02|本地/);
    const l = await env.call('/api/risk/live', { cookie: env.driverCookie }); // 司机端轮询也必须 200 静默
    assert.equal(l.status, 200);
    assert.deepEqual(l.body.sessions, []);
    assert.match(String(l.body.notice), /只读投影|本地/);
    assert.equal(l.body.offset, 0);
    const c = await env.call('/api/risk/create', { cookie: env.adminCookie, method: 'POST', body: { date: '2026-07-29', vehicles: ['TEST-VEHICLE-RAW-01'] } });
    assert.equal(c.status, 503);
    assert.equal(c.body.error, 'risk_local_data_required');
    const dm = await env.call('/api/risk/metadata', { cookie: env.driverCookie });
    assert.equal(dm.status, 403);
    const res = await env.call('/api/data/admin.replay_events?limit=50', { cookie: env.adminCookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.rows.length, 3);
  } finally { env.child.kill(); await env.db.close(); }
});

test('cloud case-training: fact fallback without model, stub model advice, honest boundaries', async () => {
  const env = await boot();
  try {
    const noAI = await env.call('/api/ai/case-training', { cookie: env.adminCookie, method: 'POST', body: { case_id: 'A1', advice_only: true } });
    assert.equal(noAI.status, 200, JSON.stringify(noAI.body).slice(0, 160));
    assert.equal(noAI.body.data.ai_generated, false);
    assert.match(noAI.body.data.advice, /关联当日事件约 2 条/); // E1/E2 同日同车
    assert.match(noAI.body.data.advice, /学习记录 1 项/);
    assert.equal(noAI.body.data.vehicle, '车辆1'); // 展示标签，不露原始 gpsno
    assert.ok(Array.isArray(noAI.body.data.evidence) && noAI.body.data.evidence[0].event_id === 'E2');
    assert.equal((await env.call('/api/ai/case-training', { cookie: env.adminCookie, method: 'POST', body: { case_id: 'A1' } })).body.error, 'case_draft_local_required');
    assert.equal((await env.call('/api/ai/case-training', { cookie: env.adminCookie, method: 'POST', body: { case_id: 'ZZ', advice_only: true } })).status, 404);
    assert.equal((await env.call('/api/ai/case-training', { cookie: env.driverCookie, method: 'POST', body: { case_id: 'A1', advice_only: true } })).status, 403);
  } finally { env.child.kill(); await env.db.close(); }
  const env2 = await boot({ stubAI: true });
  try {
    const withAI = await env2.call('/api/ai/case-training', { cookie: env2.adminCookie, method: 'POST', body: { case_id: 'A1', advice_only: true } });
    assert.equal(withAI.status, 200);
    assert.equal(withAI.body.data.ai_generated, true);
    assert.match(withAI.body.data.advice, /停车检查摄像头/);
  } finally { env2.child.kill(); await env2.db.close(); }
});
