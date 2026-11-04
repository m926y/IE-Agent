// R52：AI 交接班宿主契约集成测试（隔离夹具库 + fetch 预加载桩模型，不真实外呼、不访问业务库）。
// 覆盖：data/candidates 本地同口径、历史 done/rule_fallback 输出翻译、generate 状态枚举与 summary 结构
// （ai_status=generated、summary.ai_overview/model、priorities 保留合法 refs）、日期回填护栏、
// 指派/接收/补充/删除权限矩阵与通知、预览接班人覆盖与展示格式、司机角色 403。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureDatabase, passwordHash } from './fixtures/account-db.mjs';

test('hosted shift-handover contract (R52)', async t => {
  const db = await startFixtureDatabase();
  const bjToday = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  for (const t0 of ['handover_settings', 'handover_reports', 'handover_notes', 'handover_note_deletions', 'notification_events', 'training_tasks', 'review_requests', 'interventions', 'alerts', 'risk_cases', 'score_snapshots', 'audit_logs', 'action_center_reads', 'action_center_hidden', 'driver_safety_goals', 'daily_safety_reports', 'daily_report_jobs', 'training_courses', 'evaluation_actions']) db.tables[t0] ||= [];
  db.tables.app_users.push(
    { user_id: 'test-admin2', username: 'preview_admin2', display_name: '管理员乙', role: 'safety_admin', fleet_scope: '*', account_status: 'active', password_hash: passwordHash('PreviewAdmin2026'), must_change_password: false, avatar_url: null },
    { user_id: 'test-ofc1', username: 'preview_ofc1', display_name: '安全员甲', role: 'safety_officer', fleet_scope: 'fleet-one', account_status: 'active', password_hash: passwordHash('PreviewOfficer2026'), must_change_password: false, avatar_url: null },
    { user_id: 'test-ofc2', username: 'preview_ofc2', display_name: '安全员乙', role: 'safety_officer', fleet_scope: 'fleet-two', account_status: 'active', password_hash: passwordHash('PreviewOfficer2026'), must_change_password: false, avatar_url: null },
  );
  db.tables.alerts.push({ alert_id: 'A-SEED', driver_id: 'driver-one', gpsno: 'TEST-VEHICLE-RAW-01', rule_code: 'R1', status: 'pending_review', occurred_at: new Date().toISOString(), is_replay: false });
  db.tables.handover_reports.push(
    { id: 'ho-legacy-done', owner_id: 'test-admin', scope: '*', report_date: '2026-10-29', cutoff_at: '2026-10-29T10:00:00Z', captured_at: '2026-10-29T10:01:00Z', trigger_kind: 'manual', snapshot: JSON.stringify({ counts: { new_cases: 0 }, items: [], limitations: [], score_reference: {} }), summary: JSON.stringify({ overview: '历史AI句', priorities: [{ text: '历史重点一', refs: [] }] }), ai_status: 'done', ai_error: null, recipient_id: null, status: 'unassigned', accepted_at: null, accepted_note: null },
    { id: 'ho-legacy-rule', owner_id: 'test-admin', scope: '*', report_date: '2026-10-28', cutoff_at: '2026-10-28T10:00:00Z', captured_at: '2026-10-28T10:01:00Z', trigger_kind: 'auto', snapshot: JSON.stringify({ counts: {}, items: [], limitations: [], score_reference: {} }), summary: JSON.stringify({ overview: '规则句', priorities: [] }), ai_status: 'rule_fallback', ai_error: null, recipient_id: null, status: 'accepted', accepted_at: '2026-10-28T11:00:00Z', accepted_note: '' },
  );

  // 桩模型：拦截 https://ai-stub.invalid 的 chat/completions；其余 fetch（夹具 REST）原样透传
  const dir = mkdtempSync(join(tmpdir(), 'r52-stub-'));
  const preload = join(dir, 'ai-stub.cjs');
  writeFileSync(preload, `
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (url.startsWith('https://ai-stub.invalid')) {
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ overview: '待复核案卷 1 项：车辆1 风险待处置（历史口径）。', priorities: [{ text: '优先处置车辆1 的风险案卷，接班后确认证据与设备状态。', refs: ['alert:A-SEED', 'bogus:REF-1'] }, '兼容字符串型重点项'], suggestion: '先确认证据，再沟通干预，最后验收培训。' }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return real(input, init);
};`);

  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['--require', preload, 'server.mjs'], {
    cwd: new URL('../', import.meta.url), windowsHide: true,
    env: { HOST: '127.0.0.1', PORT: String(port), SUPABASE_URL: db.url, SUPABASE_ANON_KEY: 'test', SUPABASE_INSTANCE_ID: 'fixture', QW_AI_BASE_URL: 'https://ai-stub.invalid', QW_AI_API_KEY: 'stub-key-abcdefghij', QW_AI_MODEL: 'stub-model' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x);
  const base = `http://127.0.0.1:${port}`;
  async function call(path, { cookie, method = 'GET', body } = {}) {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch { }
    return { status: res.status, body: json, cookie: res.headers.get('set-cookie')?.split(';')[0] };
  }
  const login = (u, p) => call('/api/auth/login', { method: 'POST', body: { username: u, password: p } });
  t.after(() => { child.kill(); db.close(); });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch { } await new Promise(r => setTimeout(r, 50)); }
  const admin = (await login('preview_admin', 'PreviewAdmin2026')).cookie;
  const admin2 = (await login('preview_admin2', 'PreviewAdmin2026')).cookie;
  const ofc1 = (await login('preview_ofc1', 'PreviewOfficer2026')).cookie;
  const driver = (await login('preview_driver', 'PreviewDriver2026')).cookie;

  await t.test('data：候选人口径与展示格式对齐本地；历史枚举翻译在行上可见', async () => {
    const d = await call('/api/handover/data', { cookie: admin });
    assert.equal(d.status, 200);
    assert.equal(d.body.settings.end_time, '18:00');
    const ids = d.body.candidates.map(c => c.id);
    assert.deepEqual([...ids].sort(), ['test-admin2', 'test-ofc1', 'test-ofc2']);
    assert.ok(d.body.candidates.find(c => c.id === 'test-ofc1').name.includes('（'));
    const done = d.body.reports.find(r => r.id === 'ho-legacy-done');
    assert.equal(done.ai_status, 'generated');
    const rule = d.body.reports.find(r => r.id === 'ho-legacy-rule');
    assert.equal(rule.ai_status, 'failed');
    assert.equal(rule.status, 'accepted');
    const o = await call('/api/handover/data', { cookie: ofc1 });
    assert.deepEqual(o.body.candidates.map(c => c.id).sort(), ['test-admin', 'test-admin2']); // 车队账号：全局同人可见、跨车队不可见
    assert.equal(o.body.reports.length, 0); // 车队账号对全局 scope 的历史/新单不可见（本地同款 permitted 口径）
  });

  await t.test('view：done→generated 且 ai_overview 平移；rule_fallback→failed+model_not_configured', async () => {
    const v = await call('/api/handover/view?id=ho-legacy-done', { cookie: admin });
    assert.equal(v.status, 200);
    assert.equal(v.body.ai_status, 'generated');
    assert.equal(v.body.summary.ai_overview, '历史AI句');
    assert.equal(v.body.summary.priorities[0].text, '历史重点一');
    const w = await call('/api/handover/view?id=ho-legacy-rule', { cookie: admin });
    assert.equal(w.body.ai_status, 'failed');
    assert.equal(w.body.ai_error, 'model_not_configured');
  });

  await t.test('R53：V41 前旧单 snapshot 缺字段也须可打开（补齐默认值，此前页脚 score_reference 崩溃）', async () => {
    db.tables.handover_reports.push({ id: 'ho-legacy-broken', owner_id: 'test-admin', scope: '*', report_date: '2026-10-05', cutoff_at: '2026-10-05T10:00:00Z', captured_at: '2026-10-05T10:01:00Z', trigger_kind: 'manual', snapshot: JSON.stringify({ counts: { new_cases: 1, pending_risks: 1 }, items: [{ id: 'alert:A-SEED', kind: 'alert', title: '风险案卷待复核', vehicle: '车辆1', status: 'pending_review', is_replay: false }] }), summary: JSON.stringify({ overview: '早期AI摘要句', priorities: [{ text: '复核车辆1', refs: ['alert:A-SEED'] }] }), ai_status: 'done', ai_error: null, recipient_id: null, status: 'open', accepted_at: null, accepted_note: null });
    const v = await call('/api/handover/view?id=ho-legacy-broken', { cookie: admin });
    assert.equal(v.status, 200, JSON.stringify(v.body).slice(0, 120));
    assert.equal(v.body.status, 'unassigned'); // open 且无接班人 → 待指定接班人（R53 细分）
    assert.ok(v.body.snapshot.score_reference && typeof v.body.snapshot.score_reference === 'object');
    assert.ok(Array.isArray(v.body.snapshot.chat) && typeof v.body.snapshot.chat_total === 'number' && v.body.snapshot.personal_actions && typeof v.body.snapshot.period_start === 'string');
    assert.equal(v.body.ai_status, 'generated');
    assert.equal(v.body.summary.ai_overview, '早期AI摘要句');
    assert.equal(v.body.snapshot.items.length, 1); // 已有字段不覆盖
    const list = await call('/api/handover/data', { cookie: admin });
    assert.equal(list.body.reports.find(r => r.id === 'ho-legacy-broken').status, 'unassigned');
  });

  await t.test('设置保存 + 到点日期闸门 + 回填护栏', async () => {
    const s = await call('/api/handover/settings', { cookie: admin, method: 'POST', body: { enabled: true, end_time: '00:00', ai_enabled: true, recipient_id: null } });
    assert.equal(s.status, 200);
    const row = db.tables.handover_settings.find(x => x.user_id === 'test-admin');
    assert.equal(row.end_time, '00:00');
    assert.equal(row.next_date, bjToday);
    const back = await call('/api/handover/generate', { cookie: admin, method: 'POST', body: { date: '2026-10-27' } });
    assert.equal(back.status, 400);
    assert.equal(back.body.error, 'handover_before_installation'); // R52：宿主补齐本地护栏（此前可任意补造历史单据）
    const bad = await call('/api/handover/settings', { cookie: admin, method: 'POST', body: { enabled: true, ai_enabled: true, end_time: '25:00' } });
    assert.equal(bad.status, 400);
  });

  let reportId = null;
  await t.test('generate：成功=generated，summary 含 model/ai_overview/规则 overview，refs 只保留真实条目', async () => {
    const g = await call('/api/handover/generate', { cookie: admin, method: 'POST', body: {} });
    assert.equal(g.status, 200);
    reportId = g.body.id;
    assert.equal(g.body.ai_status, 'generated');
    assert.equal(g.body.summary.model, 'stub-model');
    assert.ok(g.body.summary.ai_overview.includes('待复核案卷'));
    assert.notEqual(g.body.summary.overview, g.body.summary.ai_overview); // overview 保留规则句（本地同款双句）
    const pri = g.body.summary.priorities;
    assert.equal(pri.length, 2);
    assert.deepEqual(pri[0].refs, ['alert:A-SEED']); // 悬空 refs 被剔除（对齐 handover-ai 引用核验）
    assert.deepEqual(pri[1], { text: '兼容字符串型重点项', refs: [] });
    assert.equal(g.body.trigger, 'manual');
    const rep = await call('/api/handover/generate', { cookie: admin, method: 'POST', body: {} });
    assert.equal(rep.body.idempotent_replay, true);
    assert.equal(rep.body.id, reportId);
  });

  await t.test('assign：空=400/自选=409/跨车队=409/合法=200+通知；accept 后重复=幂等/已接收禁改派', async () => {
    assert.equal((await call('/api/handover/assign', { cookie: admin, method: 'POST', body: { id: reportId } })).status, 400);
    assert.equal((await call('/api/handover/assign', { cookie: admin, method: 'POST', body: { id: reportId, recipient_id: 'test-admin' } })).body.error, 'handover_recipient_unavailable');
    const o = await call('/api/handover/assign', { cookie: admin, method: 'POST', body: { id: reportId, recipient_id: 'bogus-user' } });
    assert.equal(o.status, 409);
    const a = await call('/api/handover/assign', { cookie: admin, method: 'POST', body: { id: reportId, recipient_id: 'test-admin2' } });
    assert.equal(a.status, 200);
    assert.ok(db.tables.notification_events.some(n => n.target_user_id === 'test-admin2' && n.type === 'handover_assigned'));
    const v = await call('/api/handover/view?id=' + reportId, { cookie: admin2 });
    assert.equal(v.status, 200);
    assert.equal(v.body.recipient_name, '管理员乙');
    const acc = await call('/api/handover/accept', { cookie: admin2, method: 'POST', body: { id: reportId, note: '收到' } });
    assert.equal(acc.status, 200);
    assert.equal((await call('/api/handover/accept', { cookie: admin2, method: 'POST', body: { id: reportId } })).body.idempotent_replay, true);
    assert.ok(db.tables.notification_events.some(n => n.target_user_id === 'test-admin' && n.type === 'handover_accepted'));
    const again = await call('/api/handover/assign', { cookie: admin, method: 'POST', body: { id: reportId, recipient_id: 'test-ofc1' } });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'handover_already_accepted');
    // 第三人（非 owner 非 recipient 且车队列不匹配）查看 → 404
    const cross = await call('/api/handover/view?id=' + reportId, { cookie: ofc1 });
    assert.equal(cross.status, 404); // officer1 fleet-one vs 单据 scope '*'：本地同款撤销口径
  });

  await t.test('note/delete_note：补记通知双方；仅作者可删自己写的接班重点；普通补充不可删', async () => {
    const nid = (await call('/api/handover/note', { cookie: admin2, method: 'POST', body: { id: reportId, content: '【接班重点】明晨复查设备' } })).body.id;
    assert.ok(nid);
    assert.ok(db.tables.notification_events.some(n => n.target_user_id === 'test-admin' && n.type === 'handover_note'));
    const deny = await call('/api/handover/delete_note', { cookie: admin, method: 'POST', body: { id: reportId, note_id: nid } });
    assert.equal(deny.status, 403);
    assert.equal(deny.body.error, 'handover_note_author_required');
    const plain = (await call('/api/handover/note', { cookie: admin, method: 'POST', body: { id: reportId, content: '普通补充说明' } })).body.id;
    assert.equal((await call('/api/handover/delete_note', { cookie: admin, method: 'POST', body: { id: reportId, note_id: plain } })).status, 404);
    const mine = (await call('/api/handover/note', { cookie: admin, method: 'POST', body: { id: reportId, content: '【接班重点】我自己的重点' } })).body.id;
    assert.equal((await call('/api/handover/delete_note', { cookie: admin, method: 'POST', body: { id: reportId, note_id: mine } })).status, 200);
    const vv = await call('/api/handover/view?id=' + reportId, { cookie: admin });
    assert.equal(vv.body.notes.length, 2); assert.ok(!vv.body.notes.some(n => n.content.includes('我自己的重点')));
    assert.ok(vv.body.notes.every(n => n.author_name));
  });

  await t.test('preview：接班人覆盖合法/非法、姓名格式；司机角色 403', async () => {
    const p = await call('/api/handover/preview', { cookie: admin, method: 'POST', body: { recipient_id: 'test-ofc1' } });
    assert.equal(p.status, 200);
    assert.equal(p.body.recipient_name, '安全员甲（preview_ofc1）');
    assert.equal(p.body.ai_status, 'disabled');
    const bad = await call('/api/handover/preview', { cookie: ofc1, method: 'POST', body: { recipient_id: 'test-ofc2' } });
    assert.equal(bad.status, 409); // 车队账号跨车队指定 → unavailable（合法候选人仅限全局/同车队）
    assert.equal((await call('/api/handover/data', { cookie: driver })).status, 403);
    assert.equal((await call('/api/handover/pick', { cookie: admin })).status, 404); // 未知 action
    assert.ok(!/punish|daily_tick_error/.test(output));
  });
});
