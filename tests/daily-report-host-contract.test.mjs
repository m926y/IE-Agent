// R51：司机安全简报面板的宿主（PostgREST/Supabase）契约集成测试。
// 隔离夹具库（tests/fixtures/account-db.mjs），不访问真实业务库或模型服务。
// 覆盖：jobs 面板 UI 契约（drivers/help/matchedTotal/vehicle/report_id/settings.time/canEdit）、
// 车队范围、搜索与分页、目标求助处置（迁移014 三列）+通知+动作中心联动、adminDetail 角色闸门。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { startFixtureDatabase, passwordHash } from './fixtures/account-db.mjs';

test('hosted driver daily-report admin panel contract (R51)', async t => {
  const db = await startFixtureDatabase();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  // 种子：车队1（driver-one/driver-three/driver-four）与车队2（driver-two）；简报、任务、目标求助
  for (const t0 of ['daily_report_jobs','daily_safety_reports','driver_safety_goals','notification_events','training_tasks','review_requests','interventions','alerts','action_center_reads','action_center_hidden','training_courses','evaluation_actions']) db.tables[t0] ||= [];
  db.tables.drivers.push({ driver_id: 'driver-three', gpsno: 'TEST-VEHICLE-RAW-03', fleet_id: 'fleet-one' }, { driver_id: 'driver-four', gpsno: 'TEST-VEHICLE-RAW-04', fleet_id: 'fleet-one' });
  db.tables.vehicle_labels.push({ gpsno: 'TEST-VEHICLE-RAW-03', display_no: 3 }, { gpsno: 'TEST-VEHICLE-RAW-04', display_no: 4 });
  db.tables.daily_report_jobs.push(
    { id: 1, driver_id: 'driver-one', report_date: today, status: 'succeeded', attempts: 1, started_at: '2026-01-01T07:00:00Z', finished_at: '2026-01-01T07:01:00Z', error_message: null },
    { id: 2, driver_id: 'driver-two', report_date: today, status: 'succeeded', attempts: 1, started_at: null, finished_at: null, error_message: null },
    { id: 3, driver_id: 'driver-three', report_date: today, status: 'failed', attempts: 3, started_at: null, finished_at: null, error_message: 'boom' },
  );
  db.tables.daily_safety_reports.push(
    { id: 11, driver_id: 'driver-one', report_date: today, report_version: 1, status: 'published', is_current: true, published_at: '2026-01-01T07:01:00Z', source_fingerprint: 'f'.repeat(64), data_as_of: '2026-06-30', report_json: JSON.stringify({ title: '车辆1 简报', driverId: 'driver-one', reportDate: today, metrics: {} }) },
    { id: 12, driver_id: 'driver-two', report_date: today, report_version: 1, status: 'published', is_current: true, published_at: '2026-01-01T07:01:00Z', source_fingerprint: 'e'.repeat(64), data_as_of: '2026-06-30', report_json: JSON.stringify({ title: '车辆2 简报', driverId: 'driver-two', reportDate: today, metrics: {} }) },
    { id: 31, driver_id: 'driver-one', report_date: '2026-01-01', report_version: 1, status: 'published', is_current: false, published_at: '2026-01-01T07:00:00Z', source_fingerprint: 'd'.repeat(64), data_as_of: '2026-06-29', report_json: JSON.stringify({ title: '旧版', driverId: 'driver-one', reportDate: '2026-01-01' }) },
  );
  db.tables.driver_safety_goals.push(
    { id: 41, driver_id: 'driver-one', report_id: 31, goal_type: 'practice', goal_text: '减少急刹', status: 'active', feedback_code: 'need_help', feedback_text: '需要设备支持', created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-03T00:00:00Z', handled_at: null, handled_by: null, handled_note: null },
    { id: 42, driver_id: 'driver-two', report_id: 999, goal_type: 'practice', goal_text: '远离来源缺失', status: 'active', feedback_code: 'need_help', feedback_text: '旧版本', created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-03T00:00:00Z', handled_at: null, handled_by: null, handled_note: null },
  );
  db.tables.app_users.push({ user_id: 'test-officer', username: 'preview_officer', display_name: '安全员甲', role: 'safety_officer', fleet_scope: 'fleet-one', account_status: 'active', password_hash: passwordHash('PreviewOfficer2026'), must_change_password: false, avatar_url: null });

  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('../', import.meta.url), windowsHide: true,
    env: { HOST: '127.0.0.1', PORT: String(port), SUPABASE_URL: db.url, SUPABASE_ANON_KEY: 'test', SUPABASE_INSTANCE_ID: 'fixture' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x);
  const base = `http://127.0.0.1:${port}`;
  async function call(path, { cookie, method = 'GET', body } = {}) {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, body: json, cookie: res.headers.get('set-cookie')?.split(';')[0] };
  }
  const login = (u, p) => call('/api/auth/login', { method: 'POST', body: { username: u, password: p } });
  t.after(() => { child.kill(); db.close(); });

  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  const admin = (await login('preview_admin', 'PreviewAdmin2026')).cookie;
  const officer = (await login('preview_officer', 'PreviewOfficer2026')).cookie;
  const driver = (await login('preview_driver', 'PreviewDriver2026')).cookie;

  await t.test('settings 返回 UI 字段 time/canEdit', async () => {
    const r = await call('/api/admin/daily-reports/settings', { cookie: admin });
    assert.equal(r.status, 200);
    assert.match(String(r.body.time), /^\d{2}:\d{2}$/);
    assert.equal(r.body.canEdit, false);
  });

  await t.test('jobs 面板契约完整（drivers/help/matchedTotal/vehicle/report_id，每页10）', async () => {
    const r = await call(`/api/admin/daily-reports/jobs?date=${today}`, { cookie: admin });
    assert.equal(r.status, 200);
    assert.equal(r.body.limit, 10);
    assert.equal(r.body.total, 3);
    assert.deepEqual({ ...r.body.byStatus }, { succeeded: 2, failed: 1 });
    assert.equal(r.body.matchedTotal, 3);
    const labels = r.body.drivers.map(d => d.label).sort();
    assert.deepEqual(labels, ['车辆1', '车辆2', '车辆3', '车辆4']);
    assert.ok(r.body.drivers.every(d => d.id && /^车辆/.test(d.label)));
    const one = r.body.rows.find(x => x.driver_id === 'driver-one' && x.report_date === today);
    assert.equal(one.vehicle, '车辆1');
    assert.equal(one.report_id, 11);
    assert.ok('report_id' in r.body.rows.find(x => x.driver_id === 'driver-three'));
    assert.equal(r.body.rows.find(x => x.driver_id === 'driver-three').report_id, null);
    // help：求助行保留（本地 adminData 的 SQL JOIN 语义在宿主以 report_date:null 标注来源不可联，行仍可处置）
    assert.equal(r.body.help.length, 2);
    const h41 = r.body.help.find(x => x.id === 41), h42 = r.body.help.find(x => x.id === 42);
    assert.equal(h41.vehicle, '车辆1');
    assert.equal(h41.report_date, '2026-01-01');
    assert.equal(h41.handled_at, null);
    assert.equal(h42.report_date, null);
  });

  await t.test('安全员只见本车队（fleet-one）数据', async () => {
    const r = await call(`/api/admin/daily-reports/jobs?date=${today}`, { cookie: officer });
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 2); // driver-one 与 driver-three（fleet-one）
    assert.deepEqual(r.body.drivers.map(d => d.label).sort(), ['车辆1', '车辆3', '车辆4']);
    assert.equal(r.body.rows.every(x => ['driver-one', 'driver-three'].includes(x.driver_id)), true);
    assert.equal(r.body.help.length, 1);
    assert.equal(r.body.help[0].driver_id, 'driver-one');
  });

  await t.test('搜索与状态过滤、offset 分页', async () => {
    const q1 = await call(`/api/admin/daily-reports/jobs?date=${today}&search=车辆2`, { cookie: admin });
    assert.equal(q1.body.matchedTotal, 1);
    assert.equal(q1.body.rows[0].driver_id, 'driver-two');
    const qs = await call(`/api/admin/daily-reports/jobs?date=${today}&status=failed`, { cookie: admin });
    assert.equal(qs.body.matchedTotal, 1);
    assert.equal(qs.body.rows[0].driver_id, 'driver-three');
    assert.deepEqual({ ...qs.body.byStatus }, { succeeded: 2, failed: 1 }); // byStatus 不受过滤影响（与本地一致）
    const p2 = await call(`/api/admin/daily-reports/jobs?date=${today}&offset=2`, { cookie: admin });
    assert.equal(p2.body.rows.length, 3 - 2);
    const p3 = await call(`/api/admin/daily-reports/jobs?date=${today}&offset=3`, { cookie: admin });
    assert.equal(p3.body.rows.length, 0);
    assert.equal(p3.body.offset, 3);
  });

  await t.test('司机不能访问管理端 jobs/detail', async () => {
    assert.equal((await call(`/api/admin/daily-reports/jobs?date=${today}`, { cookie: driver })).status, 403);
    assert.equal((await call('/api/admin/daily-reports/detail?id=11', { cookie: driver })).status, 403);
    const a = await call('/api/admin/daily-reports/detail?id=11', { cookie: officer });
    assert.equal(a.status, 200);
    assert.equal(a.body.report.driverId, 'driver-one');
    assert.equal((await call('/api/admin/daily-reports/detail?id=12', { cookie: officer })).status, 404); // 跨车队越界
  });

  await t.test('目标求助处置：必填意见、权限、幂等通知、动作中心联动', async () => {
    assert.equal((await call('/api/admin/safety-goals/41/handle', { cookie: admin, method: 'POST', body: { note: '  ' } })).status, 400);
    assert.equal((await call('/api/admin/safety-goals/999/handle', { cookie: admin, method: 'POST', body: { note: 'x' } })).status, 404);
    assert.equal((await call('/api/admin/safety-goals/41/handle', { cookie: driver, method: 'POST', body: { note: 'x' } })).status, 403);
    assert.equal((await call('/api/admin/safety-goals/42/handle', { cookie: officer, method: 'POST', body: { note: '越界' } })).status, 404);
    const h = await call('/api/admin/safety-goals/42/handle', { cookie: admin, method: 'POST', body: { note: '已改派线下复核' } });
    assert.equal(h.status, 200);
    assert.equal((await call('/api/admin/safety-goals/41/handle', { cookie: admin, method: 'POST', body: { note: '已协调设备检测' } })).status, 200);
    assert.equal(h.body.ok, true);
    const g = db.tables.driver_safety_goals.find(x => x.id === 41);
    assert.ok(g.handled_at && g.handled_by === 'test-admin' && g.handled_note === '已协调设备检测');
    const notif = db.tables.notification_events.filter(n => n.type === 'driver_goal_answered');
    assert.equal(notif.length, 1);
    assert.equal(notif[0].target_user_id, 'test-driver');
    assert.equal(notif[0].source_entity_type, 'driver_safety_goal');
    const jobs = await call(`/api/admin/daily-reports/jobs?date=${today}`, { cookie: admin });
    assert.ok(jobs.body.help.find(x => x.id === 41)); // 已跟进仍展示（本地一致），handled_at 可见
    assert.equal(jobs.body.help.find(x => x.id === 41).handled_at, g.handled_at);
    const center = await call('/api/center/data', { cookie: admin });
    assert.equal(center.status, 200);
    assert.ok(!JSON.stringify(center.body).includes('goal:41'), '已处置目标不应再出现在待办');
    assert.ok(!JSON.stringify(center.body).includes('goal:42'), '来源缺失的求助不入待办');
  });

  assert.ok(!/punish/i.test(output) && !/DB_DETAIL/.test(String(output)), '宿主查询不应触发 WAF/DB 错误');
});

// R58：两项云端缺口修复的宿主契约。
// 1) /api/admin/daily-reports/evidence 的 UI 契约是 ?id=报告id&event_id=事件id（admin-driver-reports 只读预览、
//    ReportView readOnly 用它展开"值得关注的风险"证据）；旧宿主实现只认 ?ref=（AI 证据核验通道）→ 云端恒 404
//    not_found_or_stale，界面显示"无权查看"。修复=镜像本地 reportEvidence：staff 专用 + 车队范围 + 事件必须在报告
//    evidenceRefs 内 + 只回该司机在线回放事件。
// 2) AI 工具 get_driver_daily_report 此前只走 integratedRPC（云端恒 503 full_data_required），司机"让 AI 解读简报"
//    必然失败（显示无法读取数据）。修复=云端宿主分支读 daily_safety_reports：司机本人（今日或最近一份/指定 id），
//    管理人员需 id 或 driver_id（范围内校验）。
test('hosted briefing evidence (id+event_id) and AI daily-report tool contract (R58)', async t => {
  const db = await startFixtureDatabase();
  for (const t0 of ['daily_safety_reports','daily_report_jobs','driver_safety_goals','notification_events','training_tasks','training_courses','alerts','action_center_reads','action_center_hidden','replay_events','audit_logs']) db.tables[t0] ||= [];
  db.tables.replay_events.push(
    { event_id: 'EV-R58A', gpsno: 'TEST-VEHICLE-RAW-01', driver_id: 'driver-one', event_time: '2026-07-30T10:00:00+08:00', event_type: '41001', event_name: '疲劳报警', speed_kmh: 60, dimension: 'fatigue_distraction', replay_date: '2026-07-30', is_replay: true, source_version: 'sv1' },
    { event_id: 'EV-R58B', gpsno: 'TEST-VEHICLE-RAW-02', driver_id: 'driver-two', event_time: '2026-07-30T11:00:00+08:00', event_type: '41001', event_name: '疲劳报警', speed_kmh: 55, dimension: 'fatigue_distraction', replay_date: '2026-07-30', is_replay: true, source_version: 'sv1' },
  );
  db.tables.daily_safety_reports.push({ id: 501, driver_id: 'driver-one', report_date: '2026-07-31', report_version: 1, status: 'published', is_current: true, published_at: '2026-07-31T07:01:00Z', source_fingerprint: 'a'.repeat(64), data_as_of: '2026-07-30', report_json: JSON.stringify({ title: 'R58 简报', driverId: 'driver-one', reportDate: '2026-07-31', metrics: { personalScore: 70, personalScoreDate: '2026-07-30', scoreConfidence: 'high' }, risks: [{ eventType: '41001', eventName: '疲劳报警', observedCount: 1, evidenceRefs: ['event:EV-R58A'] }], cards: [], dataAsOf: '2026-07-30' }) });

  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  // AI 桩（同 r56 电池手法）：首轮要求调用 get_driver_daily_report，拿到工具结果后作答
  const STUB = `
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (url.startsWith('https://r58-ai-stub.invalid')) {
    let hasToolResult = false;
    try { const payload = JSON.parse(init && init.body ? String(init.body) : '{}'); hasToolResult = (payload.messages || []).some(m => m && m.role === 'tool'); } catch {}
    if (!hasToolResult) return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_driver_daily_report', arguments: '{}' } }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '已读取简报：个人评分70分（2026-07-30），本期最值得关注疲劳报警。' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return real(input, init);
};`;
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const stubDir = mkdtempSync(join(tmpdir(), 'r58-stub-'));
  const preload = join(stubDir, 'ai-stub.cjs');
  writeFileSync(preload, STUB);
  const child = spawn(process.execPath, ['--require', preload, 'server.mjs'], {
    cwd: new URL('../', import.meta.url), windowsHide: true,
    env: { HOST: '127.0.0.1', PORT: String(port), SUPABASE_URL: db.url, SUPABASE_ANON_KEY: 'test', SUPABASE_INSTANCE_ID: 'fixture', QW_AI_BASE_URL: 'https://r58-ai-stub.invalid', QW_AI_API_KEY: 'stub-key-abcdefghij', QW_AI_MODEL: 'stub-model' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x);
  const base = `http://127.0.0.1:${port}`;
  async function call(path, { cookie, method = 'GET', body } = {}) {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, body: json, cookie: res.headers.get('set-cookie')?.split(';')[0] };
  }
  const login = (u, p) => call('/api/auth/login', { method: 'POST', body: { username: u, password: p } });
  t.after(() => { child.kill(); db.close(); });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  const admin = (await login('preview_admin', 'PreviewAdmin2026')).cookie;
  const driver = (await login('preview_driver', 'PreviewDriver2026')).cookie;

  await t.test('管理员按 id+event_id 读简报证据：返回事件原始记录（旧实现恒 404）', async () => {
    const r = await call('/api/admin/daily-reports/evidence?id=501&event_id=EV-R58A', { cookie: admin });
    assert.equal(r.status, 200);
    assert.equal(r.body.kind, 'event');
    assert.equal(r.body.record.event_id, 'EV-R58A');
    assert.equal(r.body.record.event_name, '疲劳报警');
    assert.ok(!('gpsno' in r.body.record), '车辆键仅内部授权用，不下发');
    assert.equal(r.body.ledger_status, 'not_applicable');
  });

  await t.test('不在报告 evidenceRefs 内的事件与不存在报告都拒绝（不泄露存在性）', async () => {
    assert.equal((await call('/api/admin/daily-reports/evidence?id=501&event_id=EV-R58B', { cookie: admin })).status, 404);
    assert.equal((await call('/api/admin/daily-reports/evidence?id=999&event_id=EV-R58A', { cookie: admin })).status, 404);
  });

  await t.test('司机不能走管理端证据端点；本人 /api/driver/evidence 不受影响', async () => {
    assert.equal((await call('/api/admin/daily-reports/evidence?id=501&event_id=EV-R58A', { cookie: driver })).status, 403);
    const own = await call('/api/driver/evidence?kind=event&id=EV-R58A', { cookie: driver });
    assert.equal(own.status, 200);
    assert.equal(own.body.record.event_id, 'EV-R58A');
  });

  await t.test('?ref= 通道（AI 证据核验）仍按原语义工作', async () => {
    const r = await call('/api/ai/evidence-check?ref=daily_report:501', { cookie: driver });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.fresh.report_version, 1);
  });

  await t.test('AI 工具 get_driver_daily_report 云端可用：司机"让 AI 解读简报"读到真实简报（不再 full_data_required）', async () => {
    const r = await call('/api/ai/chat', { cookie: driver, method: 'POST', body: { messages: [{ role: 'user', content: '请解读我的安全简报，并说明我下一步应核对什么。' }] } });
    assert.equal(r.status, 200);
    const text = JSON.stringify(r.body);
    assert.ok(!/full_data_required|tool_error/.test(text), '不应再因缺本地集成分支报 full_data_required/tool_error：' + text.slice(0, 200));
    assert.match(String(r.body.answer), /疲劳报警|简报|评分/);
    const card = (r.body.evidence_cards || []).find(c => c.ref === 'daily_report:501');
    assert.ok(card, '应回传 daily_report:501 证据卡；实际响应=' + JSON.stringify(r.body).slice(0, 400));
    assert.equal(card.value, '第1版');
  });

  assert.ok(!/punish/i.test(output) && !/DB_DETAIL/.test(String(output)), '宿主查询不应触发 WAF/DB 错误');
});
