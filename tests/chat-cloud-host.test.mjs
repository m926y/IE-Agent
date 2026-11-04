// R55：消息服务云端宿主契约（隔离夹具库；contacts 范围/发送幂等/冲突/游标分页/已读回执/业务引用/越权）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { startFixtureDatabase, passwordHash } from './fixtures/account-db.mjs';

test('hosted chat service (R55)', async t => {
  const db = await startFixtureDatabase();
  for (const t0 of ['chat_messages', 'chat_business_refs', 'training_tasks', 'audit_logs', 'notification_events']) db.tables[t0] ||= [];
  db.tables.app_users.push(
    { user_id: 'test-ofc1', username: 'preview_ofc1', display_name: '安全员甲', role: 'safety_officer', fleet_scope: 'fleet-one', account_status: 'active', password_hash: passwordHash('PreviewOfficer2026'), must_change_password: false, avatar_url: null },
    { user_id: 'test-driver2', username: 'preview_driver2', display_name: '司机二', role: 'driver', driver_id: 'driver-two', fleet_scope: 'fleet-two', binding_verified: true, account_status: 'active', password_hash: passwordHash('PreviewDriver2026'), must_change_password: false, avatar_url: null },
  );
  db.tables.training_tasks.push({ task_id: 'TQ1', driver_id: 'driver-one', course_id: 'c1', status: 'assigned', updated_at: '2026-11-01T00:00:00Z' });
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('../', import.meta.url), windowsHide: true,
    env: { HOST: '127.0.0.1', PORT: String(port), SUPABASE_URL: db.url, SUPABASE_ANON_KEY: 'test', SUPABASE_INSTANCE_ID: 'fixture' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stderr.on('data', x => output += x);
  const base = `http://127.0.0.1:${port}`;
  async function call(path, { cookie, method = 'GET', body } = {}) {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch { }
    return { status: r.status, body: j, cookie: r.headers.get('set-cookie')?.split(';')[0] };
  }
  t.after(() => { child.kill(); db.close(); });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch { } await new Promise(r => setTimeout(r, 50)); }
  const admin = (await call('/api/auth/login', { method: 'POST', body: { username: 'preview_admin', password: 'PreviewAdmin2026' } })).cookie;
  const ofc1 = (await call('/api/auth/login', { method: 'POST', body: { username: 'preview_ofc1', password: 'PreviewOfficer2026' } })).cookie;
  const driver = (await call('/api/auth/login', { method: 'POST', body: { username: 'preview_driver', password: 'PreviewDriver2026' } })).cookie;

  await t.test('contacts：范围与车辆标签', async () => {
    const c = await call('/api/chat/contacts', { cookie: admin });
    assert.equal(c.status, 200);
    const ids = c.body.contacts.map(x => x.id);
    assert.ok(ids.includes('test-driver') && ids.includes('test-driver2'));
    const d1 = c.body.contacts.find(x => x.id === 'test-driver');
    assert.equal(d1.vehicle, '车辆1');
    assert.equal(d1.unread, 0);
    const o = await call('/api/chat/contacts', { cookie: ofc1 });
    assert.deepEqual(o.body.contacts.map(x => x.id).sort(), ['test-driver']); // 车队账号：仅本车队已绑定司机（全局管理员属同事被拒）
  });

  await t.test('send：正常/幂等重放/内容冲突/参数校验', async () => {
    const s1 = await call('/api/chat/send', { cookie: admin, method: 'POST', body: { peer: 'test-driver', content: '请确认明日早班状态', client_id: 'cid-admin-0001' } });
    assert.equal(s1.status, 200);
    assert.equal(s1.body.message.content, '请确认明日早班状态');
    assert.ok(Number(s1.body.message.seq) >= 1);
    const again = await call('/api/chat/send', { cookie: admin, method: 'POST', body: { peer: 'test-driver', content: '请确认明日早班状态', client_id: 'cid-admin-0001' } });
    assert.equal(again.body.idempotent_replay, true);
    assert.equal(again.body.message.seq, s1.body.message.seq);
    const clash = await call('/api/chat/send', { cookie: admin, method: 'POST', body: { peer: 'test-driver', content: '换了内容同id', client_id: 'cid-admin-0001' } });
    assert.equal(clash.status, 409); assert.equal(clash.body.error, 'chat_request_conflict');
    assert.equal((await call('/api/chat/send', { cookie: admin, method: 'POST', body: { peer: 'test-driver', content: '  ', client_id: 'cid-x-0000002' } })).status, 400);
    assert.equal((await call('/api/chat/send', { cookie: admin, method: 'POST', body: { peer: 'ghost-user', content: 'hi', client_id: 'cid-x-0000003' } })).status, 404);
    assert.equal((await call('/api/chat/send', { cookie: ofc1, method: 'POST', body: { peer: 'test-driver2', content: '跨车队', client_id: 'cid-x-0000004' } })).status, 404); // officer1→fleet-two 司机
    assert.ok(db.tables.audit_logs.some(a => a.action === 'chat.send'));
  });

  await t.test('unread/read 回执：司机可见管理员消息，标记后清零', async () => {
    await call('/api/chat/send', { cookie: driver, method: 'POST', body: { peer: 'test-admin', content: '收到，六点交接前反馈', client_id: 'cid-drv-0001' } });
    const cb = await call('/api/chat/contacts', { cookie: admin });
    const me = cb.body.contacts.find(x => x.id === 'test-driver');
    assert.equal(me.unread, 1);
    assert.equal(me.last.content, '收到，六点交接前反馈');
    const mx = Math.max(...db.tables.chat_messages.map(m => Number(m.seq)));
    assert.equal((await call('/api/chat/read', { cookie: admin, method: 'POST', body: { peer: 'test-driver', through: mx } })).status, 200);
    const cb2 = await call('/api/chat/contacts', { cookie: admin });
    assert.equal(cb2.body.contacts.find(x => x.id === 'test-driver').unread, 0);
    const msgs = await call('/api/chat/messages?peer=' + encodeURIComponent('test-driver'), { cookie: admin });
    assert.equal(msgs.body.messages.length, 2);
    assert.deepEqual(msgs.body.messages.map(m => m.sender), ['test-admin', 'test-driver']);
    assert.equal((await call('/api/chat/read', { cookie: admin, method: 'POST', body: { peer: 'test-driver', through: 0 } })).status, 400);
  });

  await t.test('业务引用：培训任务可关联、越司机 404、案卷引用云端拒绝、列表回链', async () => {
    const ok = await call('/api/chat/send', { cookie: admin, method: 'POST', body: { peer: 'test-driver', content: '结合这个任务复习', task_id: 'TQ1', client_id: 'cid-ref-00001' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.message.reference.task_id, 'TQ1');
    const badTask = await call('/api/chat/send', { cookie: admin, method: 'POST', body: { peer: 'test-driver2', content: 'x', task_id: 'TQ1', client_id: 'cid-ref-00002' } });
    assert.equal(badTask.status, 404);
    assert.equal((await call('/api/chat/send', { cookie: admin, method: 'POST', body: { peer: 'test-driver', content: 'x', case_id: 'case-9', client_id: 'cid-ref-00003' } })).status, 404);
    const afterSeq = ok.body.message.seq;
    const page = await call(`/api/chat/messages?peer=test-driver&after=${afterSeq - 3}`, { cookie: admin });
    assert.ok(page.body.messages.some(m => m.reference && m.reference.task_id === 'TQ1'));
    const beyond = await call(`/api/chat/messages?peer=test-driver&after=${afterSeq}`, { cookie: admin });
    assert.deepEqual(beyond.body.messages, []);
    const ctx = await call('/api/chat/contexts?peer=test-driver', { cookie: admin });
    assert.deepEqual(ctx.body.cases, []);
    assert.equal(ctx.body.tasks.find(x => x.task_id === 'TQ1').course_id, 'c1');
  });

  await t.test('司机端：通知 tab 联系人=在岗安全员；匿名 401', async () => {
    const dc = await call('/api/chat/contacts', { cookie: driver });
    assert.ok(dc.body.contacts.map(x => x.id).includes('test-admin'));
    assert.equal((await call('/api/chat/contacts')).status, 401);
    assert.ok(!/punish|chat_service_failed/.test(output));
  });
});
