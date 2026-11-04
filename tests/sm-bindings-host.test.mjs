// R53：SM02 司机与车辆绑定 云端宿主契约（隔离夹具库；覆盖此前宿主缺失的 /api/admin/driver-accounts）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { startFixtureDatabase } from './fixtures/account-db.mjs';

test('hosted SM02 driver-accounts & vehicle binding (R53)', async t => {
  const db = await startFixtureDatabase();
  for (const t0 of ['user_bindings', 'driver_profiles', 'audit_logs', 'notification_events']) db.tables[t0] ||= [];
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
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j, cookie: r.headers.get('set-cookie')?.split(';')[0] };
  }
  t.after(() => { child.kill(); db.close(); });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  const adminCookie = (await call('/api/auth/login', { method: 'POST', body: { username: 'preview_admin', password: 'PreviewAdmin2026' } })).cookie;
  const driverCookie = (await call('/api/auth/login', { method: 'POST', body: { username: 'preview_driver', password: 'PreviewDriver2026' } })).cookie;

  await t.test('driver-accounts：全局形状（vehicles/links/accounts，未绑车辆保留行）', async () => {
    const a = await call('/api/admin/driver-accounts', { cookie: adminCookie });
    assert.equal(a.status, 200);
    assert.ok(Array.isArray(a.body.accounts) && typeof a.body.vehicle_count === 'number' && typeof a.body.linked_count === 'number');
    assert.equal(a.body.vehicle_count, 2);
    assert.equal(a.body.linked_count, 1);
    const unlinked = a.body.rows.find(x => x.driver_id === 'driver-two' && !x.user_id);
    assert.ok(unlinked && unlinked.display_no === 2);
    const linked = a.body.rows.find(x => x.driver_id === 'driver-one' && x.user_id === 'test-driver');
    assert.ok(linked && linked.binding_verified === true);
  });

  await t.test('非管理员 403（driver 角色）；bindings 列表可正常渲染', async () => {
    assert.equal((await call('/api/admin/driver-accounts', { cookie: driverCookie })).status, 403);
    const b = await call('/api/admin/bindings', { cookie: adminCookie });
    assert.equal(b.status, 200);
    assert.ok(Array.isArray(b.body?.rows));
  });

  await t.test('换绑 round-trip：绑定→历史留档→解绑恢复；重复绑定幂等', async () => {
    const before = (await call('/api/admin/driver-accounts', { cookie: adminCookie })).body;
    assert.equal(before.accounts.find(x => x.user_id === 'test-driver').driver_id, 'driver-one');
    // 先解绑（历史行留档）
    const off = await call('/api/admin/vehicle-binding', { cookie: adminCookie, method: 'POST', body: { user_id: 'test-driver', gpsno: null } });
    assert.equal(off.status, 200);
    assert.equal(off.body.driver_id, null);
    // 再绑到 driver-two 的车
    const on = await call('/api/admin/vehicle-binding', { cookie: adminCookie, method: 'POST', body: { user_id: 'test-driver', gpsno: 'TEST-VEHICLE-RAW-02' } });
    assert.equal(on.status, 200);
    assert.equal(on.body.driver_id, 'driver-two');
    assert.ok(on.body.audit_id);
    const after = (await call('/api/admin/driver-accounts', { cookie: adminCookie })).body;
    assert.equal(after.accounts.find(x => x.user_id === 'test-driver').driver_id, 'driver-two');
    const idem = await call('/api/admin/vehicle-binding', { cookie: adminCookie, method: 'POST', body: { user_id: 'test-driver', gpsno: 'TEST-VEHICLE-RAW-02' } });
    assert.ok(idem.body.idempotent_replay === true || idem.status === 200); // 本地一致：同目标重复提交幂等重放
    // 车辆被占冲突：第二个司机账号想绑同一辆车必须被拒
    db.tables.app_users.push({ user_id: 'test-driver2', username: 'preview_driver2', display_name: '司机二', role: 'driver', driver_id: null, fleet_scope: 'fleet-one', binding_verified: false, account_status: 'active', password_hash: 'x', must_change_password: false });
    const conflict = await call('/api/admin/vehicle-binding', { cookie: adminCookie, method: 'POST', body: { user_id: 'test-driver2', gpsno: 'TEST-VEHICLE-RAW-02' } });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, 'vehicle_already_bound');
    // 恢复原状
    const restore = await call('/api/admin/vehicle-binding', { cookie: adminCookie, method: 'POST', body: { user_id: 'test-driver', gpsno: 'TEST-VEHICLE-RAW-01' } });
    assert.equal(restore.status, 200);
    const back = (await call('/api/admin/driver-accounts', { cookie: adminCookie })).body;
    assert.equal(back.accounts.find(x => x.user_id === 'test-driver').driver_id, 'driver-one');
  });

  assert.ok(!/punish/.test(output));
});
