// Isolated PostgREST substitute for account integration tests and local UI preview.
// Never connects to a business database or model service.
import { createServer } from 'node:http';
import { scryptSync } from 'node:crypto';
export function passwordHash(value) {
  const salt = 'f1'.repeat(16);
  return `scrypt$16384$8$1$${salt}$${scryptSync(value, Buffer.from(salt, 'hex'), 64).toString('hex')}`;
}
// 保真模式（传入 schema=表→列清单）：完全按 PostgREST 语义拒绝云端不存在的关系与列，
// 不再静默建表/静默补 null。真实托管库对未知关系回 404+42P01、未知列回 400+42703，
// 旧夹具两者都当成功，导致"夹具全绿、线上打不开"的漏检（第56轮数据中心/AI 数据分析实证）。
const PGRST_NON_PARAMS = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'and', 'or', 'distinct', 'on']);
function postgrestError(res, status, code, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code, message, details: null, hint: null }));
}
export async function startFixtureDatabase(options = {}) {
  const schema = options.schema || null;
  const tables = {
    app_users: [
      { user_id: 'test-admin', username: 'preview_admin', display_name: '安全员', role: 'safety_admin', fleet_scope: '*', account_status: 'active', password_hash: passwordHash('PreviewAdmin2026'), must_change_password: false, avatar_url: null },
      { user_id: 'test-driver', username: 'preview_driver', display_name: '司机', role: 'driver', driver_id: 'driver-one', fleet_scope: 'fleet-one', binding_verified: true, account_status: 'active', password_hash: passwordHash('PreviewDriver2026'), must_change_password: false, avatar_url: null },
    ],
    app_sessions: [], audit_logs: [],
    drivers: [{ driver_id: 'driver-one', gpsno: 'TEST-VEHICLE-RAW-01', fleet_id: 'fleet-one' }, { driver_id: 'driver-two', gpsno: 'TEST-VEHICLE-RAW-02', fleet_id: 'fleet-two' }],
    vehicle_labels: [{ gpsno: 'TEST-VEHICLE-RAW-01', display_no: 1 }, { gpsno: 'TEST-VEHICLE-RAW-02', display_no: 2 }],
    driver_profiles: [], user_bindings: [], score_snapshots: [], score_history: [],
  };
  const database = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture');
      const table = url.pathname.split('/').at(-1);
      if (schema && !schema[table]) return postgrestError(res, 404, '42P01', `relation "${table}" does not exist`);
      const list = tables[table] ||= [];
      if (schema) { // 列校验：select / order / 过滤键都必须存在于该表
        const columns = new Set(schema[table]);
        const selectFields = url.searchParams.get('select');
        if (selectFields && selectFields !== '*') for (const field of selectFields.split(',')) {
          const name = field.split(':').pop().trim();
          if (!columns.has(name)) return postgrestError(res, 400, '42703', `column ${table}.${name} does not exist`);
        }
        const orderTerms = url.searchParams.get('order');
        if (orderTerms) for (const term of orderTerms.split(',')) {
          const name = term.split('.')[0].trim();
          if (name && !columns.has(name)) return postgrestError(res, 400, '42703', `column ${table}.${name} does not exist`);
        }
        for (const key of url.searchParams.keys()) {
          if (PGRST_NON_PARAMS.has(key)) continue;
          if (!columns.has(key)) return postgrestError(res, 400, '42703', `column ${table}.${key} does not exist`);
        }
      }
      const match = row => [...url.searchParams].every(([key, value]) => {
        if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(key)) return true;
        if (value === 'is.null') return row[key] === null || row[key] === undefined;
        if (value.startsWith('like.')) return new RegExp('^'+value.slice(5).split('%').map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$').test(String(row[key]));
        if (value.startsWith('neq.')) return String(row[key]) !== value.slice(4);
        if (value.startsWith('gt.')) return Number(row[key]) > Number(value.slice(3));
        if (value.startsWith('gte.')) return Number(row[key]) >= Number(value.slice(4));
        if (value.startsWith('lt.')) return Number(row[key]) < Number(value.slice(3));
        if (value.startsWith('lte.')) return Number(row[key]) <= Number(value.slice(4));
        if (value.startsWith('eq.')) return String(row[key]) === value.slice(3);
        if (value.startsWith('in.(')) return value.slice(4, -1).split(',').map(x => x.trim().replace(/^'(.*)'$/, '$1')).includes(String(row[key]));
        return true;
      });
      let body = '';
      for await (const part of req) body += part;
      const parsed = body ? JSON.parse(body) : null;
      let rows = list.filter(match), result;
      if (req.method === 'GET') {
        const total = rows.length;
        const sort = url.searchParams.get('order');
        if (sort) { const keys = sort.split(',').map(x => { const [f, d] = x.split('.'); return { f, dir: d === 'desc' ? -1 : 1 }; }); rows.sort((a, b) => { for (const k of keys) { const c = String(a[k.f] ?? '').localeCompare(String(b[k.f] ?? '')); if (c) return c * k.dir; } return 0; }); }
        const offset = Number(url.searchParams.get('offset') || 0);
        rows = rows.slice(offset, offset + Number(url.searchParams.get('limit') || 1000));
        const fields = url.searchParams.get('select');
        result = fields && fields !== '*' ? rows.map(row => Object.fromEntries(fields.split(',').map(key => [key, row[key] ?? null]))) : rows;
        res.setHeader('content-range', `0-${Math.max(0, rows.length - 1)}/${total}`);
      } else if (req.method === 'POST') {
        const incoming = Array.isArray(parsed) ? parsed : [parsed];
        if (table === 'app_users' && incoming.some(x => list.some(y => y.username === x.username))) { res.writeHead(409); res.end('{"code":"23505"}'); return; }
        for (const x of incoming) { if (table === 'chat_messages' && x.seq === undefined) x.seq = list.reduce((m, y) => Math.max(m, Number(y.seq) || 0), 0) + 1; list.push(x); } result = incoming;
      } else if (req.method === 'PATCH') {
        if (table === 'app_users' && parsed.username && list.some(x => !rows.includes(x) && x.username === parsed.username)) { res.writeHead(409); res.end('{"code":"23505"}'); return; }
        for (const row of rows) Object.assign(row, parsed);
        result = rows;
      } else if (req.method === 'DELETE') { tables[table] = list.filter(x => !rows.includes(x)); result = []; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result || []));
    } catch { res.writeHead(500); res.end('{"error":"fixture_error"}'); }
  });
  await new Promise(resolve => database.listen(0, '127.0.0.1', resolve));
  return { tables, url: `http://127.0.0.1:${database.address().port}`, close: () => new Promise(resolve => database.close(resolve)) };
}
