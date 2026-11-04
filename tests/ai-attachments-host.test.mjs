// R60 云端 AI 聊天附件 + 待确认清单宿主契约（保真夹具 + 桩模型，不真调外部模型）。
// 覆盖：/api/ai/upload 解析与权限、账号批执行链（校验→清单→人工确认→建号+绑定+一次性口令）、
// 课程草稿链（确认后仍是 draft，审核门禁不变）、培训清单链（对象范围放开到全部评级）、幂等回放与越权拒绝。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureDatabase, passwordHash } from './fixtures/account-db.mjs';
import { xlsxBytes, docxBytes, pptxBytes } from './fixtures/ooxml-mini.mjs';

const REPO = new URL('../', import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'r60-stub-'));
const preload = join(dir, 'ai-stub.cjs');
/* 桩模型：① 审计请求（system 含“回答审计智能体”）→ 判定幻觉=false，避免测试里二次噪声
 * ② 未回传工具结果 → 按最后一句用户话选工具；③ 已回传 → 出一句结论。 */
writeFileSync(preload, `
const real = globalThis.fetch;
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (url.startsWith('https://r60-ai-stub.invalid')) {
    let lastUser = '', hasToolResult = false, system = '', isCourseDraft = false;
    try {
      const payload = JSON.parse(init && init.body ? String(init.body) : '{}');
      const msgs = Array.isArray(payload.messages) ? payload.messages : [];
      system = String((msgs[0] && msgs[0].content) || '');
      hasToolResult = msgs.some((m) => m && m.role === 'tool');
      const toolMsg = msgs.find((m) => m && m.role === 'tool');
      const users = msgs.filter((m) => m && m.role === 'user').map((m) => String(m.content || ''));
      lastUser = users.length ? users[users.length - 1] : '';
      if (system.startsWith('你是驾驶安全培训课程编写助手')) {
        isCourseDraft = true;
        return json({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ text: '课程正文：连续驾驶不得超过4小时，出现困倦立即停车休息20分钟。', questions: [{ type: 'single', title: '连续驾驶最长不得超过几小时？', options: ['2小时', '4小时', '8小时'], answer: [1], explain: '实施条例规定4小时' }, { type: 'text', title: '请写出你的疲劳应对计划', options: [], answer: [], reference: '提前安排休息点' }] }) } }] });
      }
      if (system.startsWith('你是平台回答审计智能体')) {
        const claim = /已为你生成待确认清单/.test(lastUser) && /"确认清单数":0/.test(lastUser.replace(/\\s/g, ''));
        return json({ choices: [{ message: { role: 'assistant', content: claim ? '{"hallucination":true,"problems":["回答声称已生成确认清单，但本轮工具没有产出任何清单"]}' : '{"hallucination":false,"problems":[]}' } }] });
      }
      if (/假装已生成/.test(lastUser)) return json({ choices: [{ message: { role: 'assistant', content: '已为你生成待确认清单，请点击下方按钮确认。' } }] });
      if (hasToolResult) {
        const payload2 = JSON.parse(String(init.body));
        const ret = (payload2.messages || []).filter((m) => m.role === 'tool').map((m) => String(m.content || ''))[0] || '';
        return json({ choices: [{ message: { role: 'assistant', content: '已依据工具结果说明：' + String(JSON.parse(ret || '{}').plan_id || '') } }] });
      }
      const wantAccount = /批量创建账号|按表格/.test(lastUser);
      const wantCourse = /生成.*课程|据文件/.test(lastUser);
      const wantTraining = /发放培训|分配培训/.test(lastUser);
      const mup = lastUser.match(/upload_id=(aiu-[a-f0-9]{24})/); const uploadId = mup ? mup[1] : '';
      const name = wantAccount ? 'prepare_account_import_from_upload' : wantCourse ? 'prepare_course_from_upload' : wantTraining ? 'prepare_training_batch' : 'get_tasks';
      const args = wantAccount || wantCourse ? { upload_id: uploadId } : wantTraining ? { course_id: 'CRS_R60', cohort: 'all', due_at: '2099-01-01' } : {};
      void system; void isCourseDraft;
      return json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
    } catch { return json({ choices: [{ message: { role: 'assistant', content: '无法解析请求。' } }] }); }
  }
  return real(input, init);
};
`);

async function freePort() { const s = createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }

test('hosted AI attachments and action plans (R60)', async (t) => {
  const { readFileSync } = await import('node:fs');
  const schema = JSON.parse(readFileSync(new URL('./fixtures/cloud-schema.json', import.meta.url), 'utf8'));
  delete schema._comment;
  for (const need of ['ai_chat_uploads', 'ai_action_plans']) assert.ok(schema[need], `云端 schema 缺少 ${need}（迁移018 未应用或未刷新夹具）`);
  const db = await startFixtureDatabase({ schema });
  const tables = db.tables;
  for (const name of Object.keys(schema)) tables[name] ||= [];
  /* 夹具默认自带 2 台车/2 个账号（避免与用例编号冲突）：本用例从干净集合开始装配 */
  for (const n of ['app_users', 'app_sessions', 'user_bindings', 'audit_logs', 'training_tasks', 'notification_events', 'drivers', 'vehicle_labels', 'score_snapshots', 'training_courses', 'operation_config', 'ai_chat_uploads', 'ai_action_plans', 'review_queue', 'deduction_ledger', 'alerts']) tables[n] = [];
  tables.app_users.push(
    { user_id: 'u-admin', username: 'r60_admin', display_name: '安全管理员', role: 'safety_admin', fleet_scope: '*', account_status: 'active', password_hash: passwordHash('R60Admin2026'), must_change_password: false, avatar_url: null, binding_verified: false },
    { user_id: 'u-ofc', username: 'r60_officer', display_name: '本队安全员', role: 'safety_officer', fleet_scope: 'fleet-one', account_status: 'active', password_hash: passwordHash('R60Officer2026'), must_change_password: false, avatar_url: null, binding_verified: false },
    { user_id: 'u-drv', username: 'r60_driver', display_name: '已绑定司机', role: 'driver', fleet_scope: 'fleet-one', driver_id: 'D001', account_status: 'active', binding_verified: true, password_hash: passwordHash('R60Driver2026'), must_change_password: false, avatar_url: null },
    { user_id: 'u-drv2', username: 'r60_driver2', display_name: '二号司机', role: 'driver', fleet_scope: 'fleet-one', driver_id: 'D002', account_status: 'active', binding_verified: true, password_hash: passwordHash('R60Driver2026'), must_change_password: false, avatar_url: null },
    { user_id: 'u-drv5', username: 'r60_driver5', display_name: '五号司机', role: 'driver', fleet_scope: 'fleet-one', driver_id: 'D005', account_status: 'active', binding_verified: true, password_hash: passwordHash('R60Driver2026'), must_change_password: false, avatar_url: null },
    { user_id: 'u-taken', username: 'taken_name', display_name: '已有账号', role: 'driver', fleet_scope: 'fleet-one', account_status: 'active', binding_verified: false, password_hash: passwordHash('Xx12345678'), must_change_password: false, avatar_url: null },
  );
  tables.drivers.push(
    { driver_id: 'D001', gpsno: 'GPS0001', fleet_id: 'fleet-one', identity_status: 'verified', mapping_start: '2026-06-01', mapping_end: null },
    { driver_id: 'D002', gpsno: 'GPS0002', fleet_id: 'fleet-one', identity_status: 'verified', mapping_start: '2026-06-01', mapping_end: null },
    { driver_id: 'D003', gpsno: 'GPS0003', fleet_id: 'fleet-two', identity_status: 'verified', mapping_start: '2026-06-01', mapping_end: null },
    { driver_id: 'D004', gpsno: 'GPS0004', fleet_id: 'fleet-one', identity_status: 'verified', mapping_start: '2026-06-01', mapping_end: null },
    { driver_id: 'D005', gpsno: 'GPS0005', fleet_id: 'fleet-one', identity_status: 'verified', mapping_start: '2026-06-01', mapping_end: null },
  );
  tables.vehicle_labels.push({ gpsno: 'GPS0001', display_no: 1 }, { gpsno: 'GPS0002', display_no: 2 }, { gpsno: 'GPS0003', display_no: 3 }, { gpsno: 'GPS0004', display_no: 4 }, { gpsno: 'GPS0005', display_no: 5 });
  // 一辆 A 级（评级门禁放开后仍可发放）、一辆 C 级低可信度、一辆 D 级
  tables.score_snapshots.push(
    { score_id: 'S1', driver_id: 'D001', gpsno: 'GPS0001', risk_level: 'A', confidence_level: 'high', as_of_date: '2026-07-31', source_version: 'sv-r60' },
    { score_id: 'S2', driver_id: 'D002', gpsno: 'GPS0002', risk_level: 'C', confidence_level: 'low', as_of_date: '2026-07-31', source_version: 'sv-r60' },
    { score_id: 'S3', driver_id: 'D003', gpsno: 'GPS0003', risk_level: 'D', confidence_level: 'medium', as_of_date: '2026-07-31', source_version: 'sv-r60' },
    { score_id: 'S4', driver_id: 'D004', gpsno: 'GPS0004', risk_level: 'B', confidence_level: 'high', as_of_date: '2026-07-31', source_version: 'sv-r60' },
    { score_id: 'S5', driver_id: 'D005', gpsno: 'GPS0005', risk_level: 'C', confidence_level: 'high', as_of_date: '2026-07-31', source_version: 'sv-r60' },
  );
  tables.training_courses.push({ course_id: 'CRS_R60', title: '疲劳驾驶专项', dimension: 'fatigue_distraction', content: '正文', completion_requirement: '完成测验', content_status: 'approved', version_no: 2, source_version: 'sv-r60', updated_at: '2026-07-01T00:00:00Z' });

  const port = await freePort();
  const child = spawn(process.execPath, ['--require', preload, 'server.mjs'], {
    cwd: fileURLToPath(REPO), windowsHide: true,
    env: { HOST: '127.0.0.1', PORT: String(port), SUPABASE_URL: db.url, SUPABASE_ANON_KEY: 'test', SUPABASE_INSTANCE_ID: 'fixture', QW_AI_BASE_URL: 'https://r60-ai-stub.invalid', QW_AI_API_KEY: 'r60-stub-key-0123456789', QW_AI_MODEL: 'stub-model' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; child.stderr.on('data', (x) => { log += x });
  const base = `http://127.0.0.1:${port}`;
  t.after(() => { child.kill(); db.close(); });
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch { } await new Promise((r) => setTimeout(r, 50)); }

  async function api(path, { cookie, method = 'GET', body, headers } = {}) {
    const res = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...(headers || {}) }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    let j = null; try { j = await res.json(); } catch { }
    return { status: res.status, body: j, cookie: res.headers.get('set-cookie')?.split(';')[0] };
  }
  async function upload(cookie, filename, bytes) {
    const res = await fetch(base + '/api/ai/upload', { method: 'POST', headers: { cookie: cookie || '', 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(filename) }, body: bytes });
    let j = null; try { j = await res.json(); } catch { }
    return { status: res.status, body: j };
  }
  const admin = (await api('/api/auth/login', { method: 'POST', body: { username: 'r60_admin', password: 'R60Admin2026' } })).cookie;
  const officer = (await api('/api/auth/login', { method: 'POST', body: { username: 'r60_officer', password: 'R60Officer2026' } })).cookie;

  await t.test('AI 历史按当前账号持久化完整消息并保护版本', async () => {
    const empty = await api('/api/ai/history', { cookie: admin });
    assert.equal(empty.status, 200);
    assert.equal(empty.body.version_no, 0);
    const snapshot = { active: 'thread-1', items: [{ id: 'thread-1', title: '课程材料', updated: Date.now(), messages: [
      { role: 'user', content: '根据材料生成课程', attachments: [{ name: '材料.md', kind_label: 'Markdown', chars: 100 }] },
      { role: 'assistant', content: '已准备待确认清单', actionPlans: [{ id: 'plan-1', kind: 'course' }], cards: [{ ref: 'course:1' }], callId: 'aud-1' },
    ] }] };
    const saved = await api('/api/ai/history', { cookie: admin, method: 'PUT', body: { snapshot, expected_version: 0 } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const restored = await api('/api/ai/history', { cookie: admin });
    assert.deepEqual(restored.body.snapshot, snapshot, '所有消息和卡片数据应原样恢复');
    const reopened = (await api('/api/auth/login', { method: 'POST', body: { username: 'r60_admin', password: 'R60Admin2026' } })).cookie;
    assert.deepEqual((await api('/api/ai/history', { cookie: reopened })).body.snapshot, snapshot, '重新登录仍能取回历史');
    assert.equal((await api('/api/ai/history', { cookie: officer })).body.snapshot.items.length, 0, '其他账号不能看到历史');
    const stale = await api('/api/ai/history', { cookie: admin, method: 'PUT', body: { snapshot, expected_version: 0 } });
    assert.equal(stale.status, 409, '旧页面不得覆盖新版本');
  });

  await t.test('upload：xlsx/docx/pptx/md 解析、PDF 诚实拒绝、非法文件', async () => {
    const x = await upload(admin, '账号表.xlsx', xlsxBytes([['用户名', '显示名', '角色', '对应车辆'], ['r60_new1', '甲一', '司机', '车辆4'], ['r60_new2', '乙二', '司机', '']]));
    assert.equal(x.status, 201, JSON.stringify(x.body));
    assert.equal(x.body.kind, 'sheet');
    assert.equal(x.body.rows, 3, '表格行数应包含表头');
    assert.match(x.body.upload_id, /^aiu-[a-f0-9]{24}$/);
    assert.ok(x.body.hosted_note && /不保存原始文件/.test(x.body.hosted_note), '响应必须声明云端不保存原始文件');
    const d = await upload(admin, '材料.docx', docxBytes(['疲劳驾驶管控要点', '连续驾驶不得超过 4 小时'], [['时段', '要求'], ['夜间', '限速降低']]));
    assert.equal(d.status, 201);
    assert.equal(d.body.kind, 'document');
    const stored = tables.ai_chat_uploads.find((r) => r.upload_id === d.body.upload_id);
    assert.match(stored.text_content, /疲劳驾驶管控要点/);
    assert.match(stored.text_content, /时段 \| 要求/, 'docx 表格行应拼成一行');
    const p = await upload(admin, '课件.pptx', pptxBytes([['防御性驾驶', '保持三秒跟车距离']]));
    assert.equal(p.status, 201);
    const m = await upload(admin, 'note.md', Buffer.from('# 疲劳\n\n连续4小时必须休息\n', 'utf8'));
    assert.equal(m.status, 201);
    const pdf = await upload(admin, 'handout.pdf', Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n', 'ascii'));
    assert.equal(pdf.status, 415);
    assert.equal(pdf.body.error, 'pdf_not_supported_hosted');
    const bad = await upload(admin, 'a.exe', Buffer.from('MZ', 'ascii'));
    assert.equal(bad.status, 415);
    assert.equal(bad.body.error, 'file_type_not_supported');
    const legacy = await upload(admin, 'old.doc', Buffer.from('junk', 'ascii'));
    assert.equal(legacy.body.error, 'legacy_format_not_supported');
    const empty = await upload(admin, 'e.txt', Buffer.alloc(0));
    assert.equal(empty.status, 400);
    assert.equal(await (await fetch(base + '/api/ai/upload', { method: 'POST', 'x-file-name': 'x.txt', body: 'hi' })).status, 401, '未登录不得上传');
  });

  await t.test('聊天附件注入：账号清单确认前零写入，回答里只说待确认', async () => {
    const up = await upload(admin, '账号表.xlsx', xlsxBytes([['用户名', '显示名', '角色', '对应车辆'], ['r60_chat1', '甲一', '司机', '车辆4'], ['r60_chat2', '乙二', '司机', '']]));
    const before = tables.app_users.length;
    const r = await api('/api/ai/chat', { cookie: admin, method: 'POST', body: { messages: [{ role: 'user', content: `按表格批量创建账号（附件 upload_id=${up.body.upload_id}）` }], attachments: [up.body.upload_id] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.answer, /已准备待确认清单：账号导入 2 项/, '清单汇总文案要来自真实 action_plan');
    assert.equal(r.body.requires_confirmation, true);
    assert.equal(r.body.action_plans[0].kind, 'accounts');
    assert.equal(r.body.action_plans[0].source_attachment, '账号表.xlsx');
    assert.equal(tables.app_users.length, before, 'AI 与清单阶段绝不创建账号');
    assert.match(r.body.data_limitations.join('；'), /口令由服务端生成/);
  });

  await t.test('账号表校验失败：重复用户名不生成清单', async () => {
    const up = await upload(admin, 'dup.xlsx', xlsxBytes([['用户名', '显示名', '角色'], ['taken_name', '重复', '司机'], ['r60_dup2', '重复二', '司机']]));
    const r = await api('/api/ai/chat', { cookie: admin, method: 'POST', body: { messages: [{ role: 'user', content: `按表格批量创建账号（附件 upload_id=${up.body.upload_id}）` }], attachments: [up.body.upload_id] } });
    assert.equal(r.status, 200);
    assert.equal(r.body.action_plans?.length || 0, 0, '校验未通过时不得给出确认卡');
    assert.match(r.body.answer + (r.body.data_limitations || []).join(''), /用户名重复或已存在/);
  });

  await t.test('账号批量导入端到端：preview→确认执行→绑定→口令一次性→幂等回放', async () => {
    const preview = await api('/api/agent/accounts/preview', { cookie: admin, method: 'POST', body: { rows: [{ username: 'r60_imp1', display_name: '导入一', role: 'driver', vehicle: '车辆4' }, { username: 'r60_imp2', display_name: '导入二', role: 'safety_officer' }] } });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.valid, true, JSON.stringify(preview.body));
    assert.equal(preview.body.count, 2);
    assert.equal(preview.body.role_counts.driver, 1);
    assert.ok(!JSON.stringify(preview.body).includes('password'), '清单里绝不出现口令字段');
    const planId = preview.body.id;
    const denied = await api('/api/agent/execute', { cookie: admin, method: 'POST', body: { plan_id: planId } });
    assert.equal(denied.status, 409);
    assert.equal(denied.body.error, 'agent_confirmation_required', '未经人工确认不得写入');
    const exec = await api('/api/agent/execute', { cookie: admin, method: 'POST', body: { plan_id: planId, confirm: true } });
    assert.equal(exec.status, 200, JSON.stringify(exec.body));
    assert.equal(exec.body.count, 2);
    assert.equal(exec.body.one_time_credentials?.length, 2, '一次性初始口令随执行结果返回');
    const created = tables.app_users.filter((u) => String(u.username).startsWith('r60_imp'));
    assert.equal(created.length, 2);
    assert.equal(created[0].must_change_password, true);
    assert.match(created[0].password_hash, /^scrypt\$16384\$8\$1\$/, '口令必须是 scrypt 派生，绝不存明文');
    const bound = tables.app_users.find((u) => u.username === 'r60_imp1');
    assert.equal(bound.driver_id, 'D004', '对应车辆应解析为司机主键并绑定');
    assert.equal(bound.binding_verified, true);
    assert.equal(bound.fleet_scope, 'fleet-one');
    assert.ok(tables.user_bindings.some((b) => b.user_id === bound.user_id && b.driver_id === 'D004'), 'user_bindings 必须有有效绑定行');
    assert.ok(tables.audit_logs.some((a) => a.action === 'account.create' && a.entity_id === bound.user_id), '建号必须留审计');
    const replay = await api('/api/agent/execute', { cookie: admin, method: 'POST', body: { plan_id: planId, confirm: true } });
    assert.equal(replay.body.idempotent_replay, true);
    assert.equal(tables.app_users.filter((u) => String(u.username).startsWith('r60_imp')).length, 2, '重复确认不得重复建号');
    assert.equal(tables.user_bindings.filter((b) => b.account_status === 'active').length >= 1, true);
    const stored = tables.ai_action_plans.find((r) => r.plan_id === planId);
    assert.equal(stored.state, 'complete');
    assert.ok(!String(stored.result_json).includes('one_time_credentials'), '执行结果里不得留存口令');
    const credFile = await api('/api/agent/credentials?id=cred-1', { cookie: admin });
    assert.equal(credFile.body.error, 'credentials_not_stored', '云端不提供口令文件下载（不留存）');
    /* 车辆被他人已核实绑定 → 整批拒绝，不建任何账号 */
    const conflict = await api('/api/agent/accounts/preview', { cookie: admin, method: 'POST', body: { rows: [{ username: 'r60_imp3', display_name: '冲突', role: 'driver', vehicle: '车辆1' }] } });
    assert.equal(conflict.body.valid, false, '车辆1 已被 r60_driver 绑定');
    assert.match(JSON.stringify(conflict.body.errors), /该车辆已被其他司机账号绑定/);
    /* 安全员（车队范围）不得批量建号：需要全部车队权限 */
    const forb = await api('/api/agent/accounts/preview', { cookie: officer, method: 'POST', body: { rows: [{ username: 'r60_imp4', display_name: '越权', role: 'driver' }] } });
    assert.equal(forb.status, 403);
    assert.equal(forb.body.error, 'agent_global_admin_required');
  });

  await t.test('文件生成课程：确认只入库 draft，审核门禁不变；分配仍被拒', async () => {
    const up = await upload(admin, '培训材料.docx', docxBytes(['疲劳驾驶管控要点', '连续驾驶不得超过 4 小时，停车休息 20 分钟']));
    const r = await api('/api/ai/chat', { cookie: admin, method: 'POST', body: { messages: [{ role: 'user', content: `根据这份材料生成疲劳驾驶培训课程，出 2 道题（附件 upload_id=${up.body.upload_id}）` }], attachments: [up.body.upload_id] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const plan = r.body.action_plans?.[0];
    assert.ok(plan, '应生成课程草稿待确认清单');
    assert.equal(plan.kind, 'course');
    assert.equal(plan.count, 1);
    assert.equal(tables.training_courses.length, 1, '确认前不得入库课程');
    const exec = await api('/api/agent/execute', { cookie: admin, method: 'POST', body: { plan_id: plan.id, confirm: true } });
    assert.equal(exec.status, 200, JSON.stringify(exec.body));
    assert.equal(exec.body.kind, 'course');
    const courseId = exec.body.course_id;
    const row = tables.training_courses.find((c) => c.course_id === courseId);
    assert.equal(row.content_status, 'draft', 'AI 课程必须是待审核草稿，不会自动批准');
    assert.match(row.content, /editable_course_v1/);
    assert.ok(JSON.parse(row.content).questions.length >= 2, '题目数量按请求生成');
    assert.equal(row.source_version, 'ai_upload_draft', '来源要能区分 AI 生成');
    const assign = await api('/api/admin/training-assign', { cookie: admin, method: 'POST', body: { course_id: courseId, driver_id: 'D005', due_at: '2099-01-01' } });
    assert.equal(assign.status, 409, JSON.stringify(assign.body));
    assert.equal(assign.body.error, 'course_not_approved', '未审核课程不能分配（门禁不变）');
    const review = await api('/api/admin/course-review', { cookie: admin, method: 'POST', body: { course_id: courseId, new_status: 'pending_review' } });
    assert.equal(review.status, 200);
    const review2 = await api('/api/admin/course-review', { cookie: admin, method: 'POST', body: { course_id: courseId, new_status: 'approved', note: '人工通过' } });
    assert.equal(review2.status, 200, JSON.stringify(review2.body));
    const assign2 = await api('/api/admin/training-assign', { cookie: admin, method: 'POST', body: { course_id: courseId, driver_id: 'D005', due_at: '2099-01-01' } });
    assert.equal(assign2.status, 200, JSON.stringify(assign2.body));
    const assignA = await api('/api/admin/training-assign', { cookie: admin, method: 'POST', body: { course_id: courseId, driver_id: 'D001', due_at: '2099-01-01' } });
    assert.equal(assignA.body.error, 'training_cd_only', '手工分发入口保留 C/D 门禁（不随 Agent 放开）');
  });

  await t.test('Markdown 建课只调用一次模型且无需在消息里填写 upload_id', async () => {
    const up = await upload(admin, '课程材料.md', Buffer.from('# 安全停车\n疲劳时先停车休息。', 'utf8'));
    const r = await api('/api/ai/chat', { cookie: admin, method: 'POST', body: { messages: [{ role: 'user', content: '请根据上传的 md 文件生成培训课程，出 2 道题' }], attachments: [up.body.upload_id] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.meta.rounds, 1);
    assert.equal(r.body.meta.tool_calls, 1);
    assert.equal(r.body.action_plans?.[0]?.kind, 'course');
    assert.equal(r.body.requires_confirmation, true);
  });

  await t.test('培训清单：对象放开到所有评级与可信度，确认后才建任务+通知，重复确认幂等', async () => {
    /* 前面的用例已导入若干"车辆→账号"绑定，这里按夹具现算期望，避免与执行顺序耦合 */
    const boundCount = (driverId) => tables.app_users.filter((u) => u.role === 'driver' && u.account_status === 'active' && u.binding_verified === true && String(u.driver_id) === String(driverId)).length;
    const expectedReady = tables.score_snapshots.filter((x) => boundCount(x.driver_id) === 1).length;
    const expectedSelected = tables.score_snapshots.length;
    const notifBefore = tables.notification_events.filter((x) => x.type === 'task_assigned').length;
    const tasksBefore = tables.training_tasks.length;
    const r = await api('/api/agent/training/preview', { cookie: admin, method: 'POST', body: { course_id: 'CRS_R60', cohort: 'all', due_at: '2099-01-01', goal: '完成疲劳课程学习' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const plan = r.body.action_plan;
    assert.ok(plan && plan.id, 'training/preview 返回工具形结果：清单在 action_plan 里');
    assert.equal(plan.kind, 'training');
    assert.equal(plan.count, expectedReady, '已绑定唯一有效司机账号的车辆全部可发放（评级/可信度不再是 Agent 门禁）');
    assert.equal(plan.selected_count, expectedSelected);
    assert.ok(plan.skipped.every((x) => /未绑定唯一|多个司机账号/.test(x.reason)), '排除原因必须逐辆列出且只讲绑定事实：' + JSON.stringify(plan.skipped));
    assert.ok(plan.rows.some((x) => x.vehicle === '车辆1'), 'A级车辆可由 Agent 发放');
    assert.ok(plan.rows.some((x) => x.vehicle === '车辆2'), 'C级低可信度车辆可由 Agent 发放');
    assert.equal(r.body.data.skipped.length, plan.skipped.length, '工具 data.skipped 与清单一致');
    assert.match(r.body.data_limitations, /评级与可信度/, '限制声明要写清 Agent 对象口径');
    assert.equal(r.body.status, 'draft');
    assert.equal(r.body.requires_confirmation, true);    const exec = await api('/api/agent/execute', { cookie: admin, method: 'POST', body: { plan_id: plan.id, confirm: true } });
    assert.equal(exec.status, 200, JSON.stringify(exec.body));
    assert.equal(exec.body.count, expectedReady);
    assert.equal(tables.training_tasks.filter((x) => x.course_id === 'CRS_R60').length, expectedReady);
    assert.equal(tables.notification_events.filter((x) => x.type === 'task_assigned').length - notifBefore, expectedReady, '确认执行要逐个发站内通知（此前手工分配的通知我不算）');
    assert.ok(tables.training_tasks.every((x) => x.created_by === 'u-admin'));
    const replay = await api('/api/agent/execute', { cookie: admin, method: 'POST', body: { plan_id: plan.id, confirm: true } });
    assert.equal(replay.body.idempotent_replay, true);
    assert.equal(tables.training_tasks.filter((x) => x.course_id === 'CRS_R60').length, expectedReady, '重复确认不得重复建任务');
    /* 同课程允许独立新批次（11-03 决定）：再建一份清单仍可执行 */
    const r2 = await api('/api/agent/training/preview', { cookie: admin, method: 'POST', body: { course_id: 'CRS_R60', cohort: 'vehicle', gpsno: 'GPS0001', due_at: '2099-01-01' } });
    assert.equal(r2.body.action_plan.count, boundCount('D001') === 1 ? 1 : 0, '按车辆发放时仍需唯一有效绑定');
    assert.equal(r2.body.action_plan.skipped.length, boundCount('D001') === 1 ? 0 : 1);
    const exec2 = await api('/api/agent/execute', { cookie: admin, method: 'POST', body: { plan_id: r2.body.action_plan.id, confirm: true } });
    assert.equal(exec2.body.count, r2.body.action_plan.count);
    assert.equal(tables.training_tasks.filter((x) => x.course_id === 'CRS_R60').length, expectedReady + r2.body.action_plan.count, '同课程新批次允许创建（11-03 决定）');
    assert.ok(tables.training_tasks.length > tasksBefore);
    /* 课程未审核 / 课程版本变化 → 拒绝执行 */
    tables.training_courses.find((c) => c.course_id === 'CRS_R60').content_status = 'disabled';
    const r3 = await api('/api/agent/training/preview', { cookie: admin, method: 'POST', body: { course_id: 'CRS_R60', cohort: 'd', due_at: '2099-01-01' } });
    assert.equal(r3.status, 409, JSON.stringify(r3.body));
    assert.equal(r3.body.error, 'course_not_approved');
  });

  await t.test('附件边界：越权读取、过期、附件不入他人上下文', async () => {
    const up = await upload(admin, 'note.md', Buffer.from('# 只属于我\n', 'utf8'));
    const id = up.body.upload_id;
    const rows = tables.ai_chat_uploads.filter((r) => r.upload_id === id);
    assert.equal(rows.length, 1);
    rows[0].expires_at = '2000-01-01T00:00:00.000Z';
    const expired = await api('/api/ai/chat', { cookie: admin, method: 'POST', body: { messages: [{ role: 'user', content: '总结这份文件' }], attachments: [id] } });
    assert.equal(expired.status, 410);
    assert.equal(expired.body.error, 'attachment_expired');
    const up2 = await upload(admin, 'again.md', Buffer.from('# 还是我的\n', 'utf8'));
    const other = await api('/api/ai/chat', { cookie: officer, method: 'POST', body: { messages: [{ role: 'user', content: '总结这份文件' }], attachments: [up2.body.upload_id] } });
    assert.equal(other.status, 403, JSON.stringify(other.body));
    assert.equal(other.body.error, 'attachment_forbidden', '附件只属于上传者本人');
    const fake = await api('/api/ai/chat', { cookie: admin, method: 'POST', body: { messages: [{ role: 'user', content: '总结这份文件' }], attachments: ['aiu-' + '0'.repeat(24)] } });
    assert.equal(fake.body.error, 'attachment_not_found');
    const upA = await upload(admin, 'a.md', Buffer.from('# A\n', 'utf8'));
    const upB = await upload(admin, 'b.md', Buffer.from('# B\n', 'utf8'));
    const tooMany = await api('/api/ai/chat', { cookie: admin, method: 'POST', body: { messages: [{ role: 'user', content: '总结这些文件' }], attachments: [upA.body.upload_id, upB.body.upload_id, upA.body.upload_id, upB.body.upload_id, upA.body.upload_id] } });
    assert.equal(tooMany.status, 200, '超过 3 个由服务端夹紧取前 3');
    assert.match(tooMany.body.answer + (tooMany.body.data_limitations || []).join(';'), /24 小时|无法解析请求|附件/, '夹紧后仍能正常作答');
  });

  await t.test('回答审计：只读真台账不误报，声称型幻觉被确定性更正并入库', async () => {
    const ok = await api('/api/ai/chat', { cookie: admin, method: 'POST', body: { messages: [{ role: 'user', content: '培训任务进度如何' }] } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(!/【业务核对与建议】/.test(ok.body.answer), '查真实台账的只读回答不应被误报：' + ok.body.answer);
    const bad = await api('/api/ai/chat', { cookie: admin, method: 'POST', body: { messages: [{ role: 'user', content: '假装已生成培训清单' }] } });
    assert.equal(bad.status, 200);
    assert.match(bad.body.answer, /【业务核对与建议】/, '声称有清单但本轮无工具产物 → 必须追加更正：' + bad.body.answer);
    assert.equal(bad.body.meta.answer_audit.passed, false);
    assert.equal(bad.body.meta.answer_audit.llm_checked, true, '规则命中后要经模型复核');
    assert.ok(bad.body.meta.answer_audit.issues.length >= 1);
    const auditRow = tables.audit_logs.filter((a) => a.action === 'ai.chat' && JSON.parse(a.detail_json || '{}').answer_audit).pop();
    assert.ok(auditRow, 'ai.chat 审计行需留存回答审计结论');
    const detail = JSON.parse(auditRow.detail_json);
    assert.equal(detail.answer_audit.passed, false);
    assert.ok(Array.isArray(detail.answer_audit.issues) && detail.answer_audit.issues.length >= 1);
    assert.equal('text_content' in detail, false, '审计只存结论，不存附件正文');
  });

  await t.test('R62 账号表宽容度：同义表头可解析、无关列忽略并报告、密码列拒绝', async () => {
    /* 属主反馈"csv 批量创建后没有真正创建"：真实表头写法多样（绑定车辆/车号/岗位…），
     * 旧版整表判非法 → 清单根本不生成，看起来像"点了没反应"。现在只有缺必需列或含密码列才拒绝。 */
    const csv = '登录名,姓名,岗位,车牌号,备注\na1_user,甲一,驾驶员,车辆3,本轮忽略的说明列\na2_user,甲二,安全员,,另一列\n';
    const up = await upload(admin, '账号表-真实写法.csv', Buffer.from('\ufeff' + csv, 'utf8'));
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const r = await api('/api/ai/chat', { cookie: admin, method: 'POST', body: { messages: [{ role: 'user', content: `按表格批量创建账号（附件 upload_id=${up.body.upload_id}）` }], attachments: [up.body.upload_id] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const plan = r.body.action_plans?.[0];
    assert.ok(plan, '同义表头的账号表必须能生成待确认清单：' + JSON.stringify(r.body.data_limitations));
    assert.equal(plan.count, 2);
    assert.deepEqual(plan.rows.map((x) => x.role).sort(), ['driver', 'safety_officer'], '"驾驶员"→driver、"安全员"→safety_officer');
    assert.equal(plan.rows.find((x) => x.username === 'a1_user').vehicle, '车辆3', '“车牌号”列按对应车辆解析');
    assert.ok((plan.ignored_columns || []).length >= 1, '无关列被忽略但要如实报告：' + JSON.stringify(plan.ignored_columns));
    assert.match(plan.note, /已忽略表格中的非账号列/);
    const before = tables.app_users.length;
    assert.equal(tables.app_users.some((u) => String(u.username).startsWith('a1_')), false, '确认前不写库');
    const exec = await api('/api/agent/execute', { cookie: admin, method: 'POST', body: { plan_id: plan.id, confirm: true } });
    assert.equal(exec.status, 200, JSON.stringify(exec.body));
    assert.equal(exec.body.count, 2);
    assert.equal(tables.app_users.length, before + 2, '确认执行后账号确实落库');
    assert.ok(tables.audit_logs.some((a) => a.action === 'agent.apply' && String(a.entity_id) === plan.id), '人工确认执行要留 agent.apply 审计');
    /* R62 核心可见性修复：批量导入的账号必须立刻能在账号列表第一页看到（旧按 user_id 升序，随机新 id 沉底 → 看起来"没创建"） */
    const list0 = await api('/api/data/admin.accounts?limit=8', { cookie: admin });
    assert.equal(list0.status, 200, JSON.stringify(list0.body));
    const listed = (list0.body.rows || []).map((x) => String(x.username));
    assert.ok(listed.includes('a1_user') && listed.includes('a2_user'), '新建账号要出现在首页：' + listed.join(','));
    const created = (list0.body.rows || []).filter((x) => ['a1_user', 'a2_user'].includes(String(x.username)));
    assert.equal(created.length, 2);
    assert.ok(created.every((x) => String(x.created_at || '').length > 8 && String(x.updated_at || '').length > 8), '新建账号要带创建/更新时间（列表时间列不再永远空白）');
    assert.ok(!JSON.stringify(list0.body).includes('password_hash'), '投影绝不包含口令列');
    /* 密码列一律拒绝（红线：初始口令只能服务端生成） */
    const pw = await upload(admin, '带密码列.csv', Buffer.from('用户名,显示名,角色,初始密码\nx_user,某,司机,abc12345\n', 'utf8'));
    const r2 = await api('/api/ai/chat', { cookie: admin, method: 'POST', body: { messages: [{ role: 'user', content: `按表格批量创建账号（附件 upload_id=${pw.body.upload_id}）` }], attachments: [pw.body.upload_id] } });
    assert.equal(r2.body.action_plans?.length || 0, 0);
    assert.match((r2.body.data_limitations || []).join(''), /不能包含密码列|账号表无效/);
    /* 过期清单必须明确报错，不再"点了没反应" */
    const expiredPlan = await api('/api/agent/accounts/preview', { cookie: admin, method: 'POST', body: { rows: [{ username: 'a3_user', display_name: '甲三', role: 'driver' }] } });
    assert.equal(expiredPlan.status, 200);
    const row = tables.ai_action_plans.find((x) => x.plan_id === expiredPlan.body.id);
    assert.ok(Date.parse(row.expires_at) - Date.parse(row.created_at) > 20 * 3600000, '清单有效期已从 30 分钟延长到 24 小时');
    row.expires_at = new Date(Date.now() - 1000).toISOString();
    const late = await api('/api/agent/execute', { cookie: admin, method: 'POST', body: { plan_id: expiredPlan.body.id, confirm: true } });
    assert.equal(late.status, 410, JSON.stringify(late));
    assert.equal(late.body.error, 'agent_plan_expired');
  });

  await t.test('培训台账批量删除：管理员/安全员权限、混合批次整批拒绝、历史保留', async () => {
    const ofc = (await api('/api/auth/login', { method: 'POST', body: { username: 'r60_driver', password: 'R60Driver2026' } }));
    void ofc;
    /* 上一用例已把 CRS_R60 置为 disabled：这里用一门新的已审核课程，避免依赖前序用例的状态 */
    const at = new Date().toISOString();
    tables.training_courses.push({ course_id: 'CRS_DEL', title: '删除用例课程', dimension: 'management', content: '正文', completion_requirement: '完成学习', content_status: 'approved', version_no: 1, source_version: 'sv-r60', updated_at: at });
    const ownPlan = await api('/api/agent/training/preview', { cookie: admin, method: 'POST', body: { course_id: 'CRS_DEL', cohort: 'vehicle', gpsno: 'GPS0002', due_at: '2099-01-01' } });
    assert.equal(ownPlan.status, 200, JSON.stringify(ownPlan.body));
    const execOwn = await api('/api/agent/execute', { cookie: admin, method: 'POST', body: { plan_id: ownPlan.body.action_plan.id, confirm: true } });
    assert.equal(execOwn.status, 200, JSON.stringify(execOwn.body));
    const all = tables.training_tasks.filter((x) => x.course_id === 'CRS_DEL');
    const mine = all.find((x) => x.created_by === 'u-admin');
    assert.ok(mine, '夹具里应有可删除的任务样本');
    const badSelection = await api('/api/training-tasks/batch-delete', { cookie: admin, method: 'POST', body: { tasks: [{ task_id: String(mine.task_id) }] } });
    assert.equal(badSelection.body.error, 'invalid_task_selection', '必须携带 expected_updated_at 字段（缺失即拒绝，不静默删除）');
    const dup = await api('/api/training-tasks/batch-delete', { cookie: admin, method: 'POST', body: { tasks: [{ task_id: String(mine.task_id), expected_updated_at: null }, { task_id: String(mine.task_id), expected_updated_at: null }] } });
    assert.equal(dup.body.error, 'invalid_task_selection', '同一任务重复出现应整批拒绝');
    const wrongVersion = await api('/api/training-tasks/batch-delete', { cookie: admin, method: 'POST', body: { tasks: [{ task_id: String(mine.task_id), expected_updated_at: '1999-01-01T00:00:00.000Z' }] } });
    assert.equal(wrongVersion.status, 409, JSON.stringify(wrongVersion.body));
    assert.equal(wrongVersion.body.error, 'task_version_conflict');
    const ok = await api('/api/training-tasks/batch-delete', { cookie: admin, method: 'POST', body: { tasks: [{ task_id: String(mine.task_id), expected_updated_at: mine.updated_at ?? null }] } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.deleted, [String(mine.task_id)]);
    const row = tables.training_tasks.find((x) => x.task_id === mine.task_id);
    assert.equal(row.status, 'deleted', '删除是置为已删除，不是抹除历史行');
    assert.ok(tables.audit_logs.some((a) => a.action === 'training.delete' && a.entity_id === String(mine.task_id)));
    const driver = (await api('/api/auth/login', { cookie: undefined, method: 'POST', body: { username: 'r60_driver', password: 'R60Driver2026' } })).cookie;
    const byDriver = await api('/api/training-tasks/batch-delete', { cookie: driver, method: 'POST', body: { tasks: [] } });
    assert.equal(byDriver.status, 403, '司机不得删除培训任务');
  /* 安全员只能删"服务端记录的本人创建"任务：混合批次整批拒绝，一条都不删 */
  const officerAcct = { user_id: 'u-ofc2', username: 'r60_ofc2', display_name: '二队安全员', role: 'safety_officer', fleet_scope: '*', account_status: 'active', password_hash: passwordHash('R60Ofc22026'), must_change_password: false, binding_verified: false };
    tables.app_users.push(officerAcct);
    const ofc2 = (await api('/api/auth/login', { method: 'POST', body: { username: 'r60_ofc2', password: 'R60Ofc22026' } })).cookie;
    const otherTask = tables.training_tasks.find((x) => x.course_id === 'CRS_R60' && x.status !== 'deleted' && x.created_by === 'u-admin');
    const mixed = await api('/api/training-tasks/batch-delete', { cookie: ofc2, method: 'POST', body: { tasks: [{ task_id: String(otherTask.task_id), expected_updated_at: otherTask.updated_at ?? null }] } });
    assert.equal(mixed.status, 403, JSON.stringify(mixed.body));
    assert.match(mixed.body.error, /officer_can_only_delete_own_tasks|forbidden/);
    assert.notEqual(tables.training_tasks.find((x) => x.task_id === otherTask.task_id).status, 'deleted', '越权批次必须零写入');
    const singleDel = await api('/api/training-tasks/' + encodeURIComponent(String(otherTask.task_id)) + '/delete', { cookie: ofc2, method: 'POST', body: { expected_updated_at: otherTask.updated_at ?? null } });
    assert.equal(singleDel.status, 403, '单条删除同样受"仅本人创建"约束');
    const asAdmin = await api('/api/training-tasks/' + encodeURIComponent(String(otherTask.task_id)) + '/delete', { cookie: admin, method: 'POST', body: { expected_updated_at: tables.training_tasks.find((x) => x.task_id === otherTask.task_id).updated_at ?? null } });
    assert.equal(asAdmin.status, 200, JSON.stringify(asAdmin.body));
  });

  const officerCookie = (await api('/api/auth/login', { method: 'POST', body: { username: 'r60_ofc2', password: 'R60Ofc22026' } })).cookie;
  await t.test('账号删除入口：收回会话与绑定、保留历史、保护自己', async () => {
    const victim = tables.app_users.find((u) => u.username === 'r60_imp2');
    assert.ok(victim, '前面用例创建的账号可用于删除验证');
    const sessionsBefore = tables.app_sessions.length;
    tables.app_sessions.push({ session_id: 'sess-for-victim', user_id: victim.user_id, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString(), user_agent: null });
    const self = await api('/api/admin/users/u-admin', { cookie: admin, method: 'DELETE' });
    assert.ok(officerCookie, '安全员 cookie 就绪');
    assert.equal(self.status, 409, JSON.stringify(self.body));
    assert.equal(self.body.error, 'cannot_delete_self');
    const gone = await api('/api/admin/users/' + encodeURIComponent(String(victim.user_id)), { cookie: admin, method: 'DELETE' });
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.ok(!tables.app_users.some((u) => u.user_id === victim.user_id), '账号行应删除');
    assert.ok(!tables.app_sessions.some((x) => x.user_id === victim.user_id), '删除账号必须清除其登录会话');
    assert.ok(tables.audit_logs.some((a) => a.action === 'account.delete' && a.entity_id === victim.user_id));
    void sessionsBefore;
    /* 安全员不得删除管理员账号（u-ofc2 在上一用例已建） */
    const byOfficer = await api('/api/admin/users/u-admin', { cookie: officerCookie, method: 'DELETE' });
    assert.equal(byOfficer.body.error, 'cannot_delete_admin', JSON.stringify(byOfficer.body));
    /* 司机不得删除账号 */
    const drv = (await api('/api/auth/login', { method: 'POST', body: { username: 'r60_driver5', password: 'R60Driver2026' } })).cookie;
    const forb = await api('/api/admin/users/' + encodeURIComponent(String(tables.app_users.find((u) => u.username === 'r60_ui_ofc' || u.username === 'r60_dup2' || u.username === 'r60_case1' || u.username === 'r60_imp1').user_id)), { cookie: drv, method: 'DELETE' });
    assert.equal(forb.status, 403, '司机无权删除账号（cap=manage.accounts）');
    const ghost = await api('/api/admin/users/u-not-exist', { cookie: admin, method: 'DELETE' });
    assert.equal(ghost.status, 404);
  });

  assert.ok(!/Error:|SyntaxError|TypeError/.test(log.split('\n').filter((l) => /AI_DEBUG|request failed/.test(l)).join('\n')), `服务端日志出现异常：${log.slice(-600)}`);
});
