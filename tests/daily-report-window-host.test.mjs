// R64 简报生成区间：管理员端不再产出"全部未取得"的空简报。
// 覆盖：/api/admin/daily-reports/settings 下发数据可生成区间与默认日期；
//      早于观测覆盖的日期被拒（不入库、不通知）；区间内日期正常发布并带真实指标。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { startFixtureDatabase, passwordHash } from './fixtures/account-db.mjs';

const ROOT = new URL('../', import.meta.url);

test('daily report data-window guard (R64)', async (t) => {
  const schema = JSON.parse(readFileSync(new URL('./fixtures/cloud-schema.json', import.meta.url), 'utf8'));
  delete schema._comment;
  const db = await startFixtureDatabase({ schema });
  const t0 = db.tables;
  for (const n of Object.keys(schema)) t0[n] ||= [];
  for (const n of ['app_users', 'app_sessions', 'user_bindings', 'audit_logs', 'daily_safety_reports', 'daily_report_jobs', 'driver_safety_goals', 'score_history', 'score_snapshots', 'deduction_ledger', 'replay_events', 'training_courses', 'training_tasks', 'notification_events', 'drivers', 'vehicle_labels']) t0[n] = [];

  t0.app_users.push({ user_id: 'u-adm', username: 'r64_admin', display_name: '安全管理员', role: 'safety_admin', fleet_scope: '*', account_status: 'active', password_hash: passwordHash('R64Admin2026'), must_change_password: false, binding_verified: false });
  t0.app_users.push({ user_id: 'u-d', username: 'r64_drv', display_name: '司机', role: 'driver', fleet_scope: 'fleet-a', driver_id: 'DR1', account_status: 'active', binding_verified: true, password_hash: passwordHash('R64Drv2026'), must_change_password: false, binding_note: '已核实', avatar_url: null });
  t0.drivers.push({ driver_id: 'DR1', gpsno: 'G1', fleet_id: 'fleet-a', identity_status: '已核实', mapping_start: '2026-07-01', mapping_end: null, display_name: '司机一' });
  t0.vehicle_labels.push({ gpsno: 'G1', display_no: 1 }, { gpsno: 'G9', display_no: 9 });
  /* DR9：映射区间把全部观测排除在外——用于验证"没有可引用观测就不发布"的安全网 */
  t0.drivers.push({ driver_id: 'DR9', gpsno: 'G9', fleet_id: 'fleet-a', identity_status: '已核实', mapping_start: '2026-09-01', mapping_end: null, display_name: '司机九' });
  // 观测覆盖：只有 07-24 与 07-25 两天
  const day = (d, score) => ({ score_id: 'S_' + d, driver_id: 'DR1', gpsno: 'G1', as_of_date: d, safety_score: score, risk_level: score > 80 ? 'B' : 'C', confidence_level: 'high', score_status: 'usable', score_method: 'fixed_exposure_event_increment_v2', source_version: 'sv-r64', window_start: '2026-07-11' });
  t0.score_history.push(day('2026-07-24', 81.5), day('2026-07-25', 79.25));
  t0.score_snapshots.push(day('2026-07-24', 81.5), day('2026-07-25', 79.25));
  t0.replay_events.push({ event_id: 'E1', gpsno: 'G1', driver_id: 'DR1', event_time: '2026-07-25 09:12:00', event_type: '30000', event_name: '前碰撞预警', dimension: 'driving_stability', replay_date: '2026-07-25', is_replay: true, source_version: 'sv-r64' });
  t0.deduction_ledger.push({ ledger_id: 'L1', gpsno: 'G1', dimension: 'driving_stability', event_type: '30000', event_count: 1, decayed_severity: 4.5, allocated_points: 4.5, dimension_points: 4.5, as_of_date: '2026-07-25', source_version: 'sv-r64' });

  const sv = createServer(); await new Promise((r) => sv.listen(0, '127.0.0.1', r)); const port = sv.address().port; await new Promise((r) => sv.close(r));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL(ROOT), windowsHide: true,
    env: { HOST: '127.0.0.1', PORT: String(port), SUPABASE_URL: db.url, SUPABASE_ANON_KEY: 'test', SUPABASE_INSTANCE_ID: 'fixture' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; child.stderr.on('data', (x) => { log += x });
  const B = `http://127.0.0.1:${port}`;
  t.after(() => { child.kill(); db.close(); });
  for (let i = 0; i < 150; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch { } await new Promise((r) => setTimeout(r, 50)); }
  async function api(path, { cookie, method = 'GET', body } = {}) {
    const r = await fetch(B + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch { }
    return { status: r.status, body: j, cookie: r.headers.get('set-cookie')?.split(';')[0] };
  }
  const admin = (await api('/api/auth/login', { method: 'POST', body: { username: 'r64_admin', password: 'R64Admin2026' } })).cookie;
  assert.ok(admin, '管理员登录成功');

  await t.test('设置接口下发可生成区间（最早 = 首个观测日次日）', async () => {
    const r = await api('/api/admin/daily-reports/settings', { cookie: admin });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data_range?.observation_to, '2026-07-25', '最新观测日取自在线 score_history');
    assert.equal(r.body.data_range?.first_generatable, '2026-07-25', '07-24 的观测只能支撑 07-25 起的简报（截至前一日）');
    assert.equal(r.body.data_range?.last_generatable, '2026-07-26');
    assert.ok(r.body.default_date >= r.body.data_range.first_generatable && r.body.default_date <= r.body.data_range.last_generatable, '默认日期落在有数据的区间内，而不是"今天"：' + JSON.stringify(r.body));
    assert.equal(r.body.canEdit, false);
  });

  await t.test('早于观测覆盖的日期被拒，不入库不通知', async () => {
    const bad = await api('/api/admin/daily-reports/run', { cookie: admin, method: 'POST', body: { driver_id: 'DR1', report_date: '2026-06-23' } });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.error, 'daily_report_date_out_of_range');
    const noObs = await api('/api/admin/daily-reports/run', { cookie: admin, method: 'POST', body: { driver_id: 'DR1', report_date: '2026-07-24' } });
    assert.equal(noObs.status, 400, JSON.stringify(noObs.body));
    assert.equal(t0.daily_safety_reports.length, 0, '被拒的生成不得写入简报表');
    assert.equal(t0.notification_events.filter((n) => n.type === 'daily_report_ready').length, 0, '被拒的生成不得通知司机');
  });

  await t.test('区间内日期正常发布，无观测的司机被拦住', async () => {
    const ok = await api('/api/admin/daily-reports/run', { cookie: admin, method: 'POST', body: { driver_id: 'DR1', report_date: '2026-07-26' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const rep = ok.body.report;
    assert.ok(rep, '返回体含简报');
    assert.equal(Number(rep.metrics.personalScore), 79.25, '个人评分取最近一次可用观测');
    assert.equal(rep.metrics.personalScoreDate, '2026-07-25');
    assert.ok((rep.coverage?.observedDates || []).length >= 1, '有可引用观测日期');
    assert.equal(t0.daily_safety_reports.length, 1, '只写入这一条');
    assert.equal(t0.daily_safety_reports[0].status, 'published');
    assert.equal(JSON.parse(t0.daily_safety_reports[0].report_json).metrics.personalScore, 79.25, '入库的简报带真实指标，不是空壳');

    /* 无任何可引用观测的司机不得被发布成 current 简报 */
    const empty = await api('/api/admin/daily-reports/run', { cookie: admin, method: 'POST', body: { driver_id: 'DR9', report_date: '2026-07-26' } });
    assert.equal(empty.status, 409, JSON.stringify(empty.body).slice(0, 160));
    assert.equal(empty.body.error, 'daily_report_no_observations');
    assert.equal(t0.daily_safety_reports.filter((x) => x.driver_id === 'DR9').length, 0, '空简报不得入库');
  });

  assert.ok(!/TypeError|ReferenceError/.test(log), log.slice(-400));
});
