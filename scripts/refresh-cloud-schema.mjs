// 迁移后重新生成 tests/fixtures/cloud-schema.json（保真夹具的表/列清单）。
// 凭据只从平台环境变量读取（MULE_PAGE_URL / MULE_AGENT_TOKEN），脚本不打印、不落盘任何连接信息。
// 用法：node scripts/refresh-cloud-schema.mjs <page-domain>
import { readFile, writeFile } from 'node:fs/promises';

const domain = process.argv[2];
const base = (process.env.MULE_PAGE_URL || '').replace(/\/+$/, '');
const token = process.env.MULE_AGENT_TOKEN || '';
if (!domain || !base || !token) { console.error('用法：node scripts/refresh-cloud-schema.mjs <page-domain>（需 MULE_PAGE_URL/MULE_AGENT_TOKEN）'); process.exit(1); }
const PAGE = `${base}/api/page/${encodeURIComponent(domain)}`;

async function api(path) {
  const res = await fetch(PAGE + path, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error('schema_api_http_' + res.status);
  try { return JSON.parse(text); } catch { throw new Error('schema_api_invalid_json'); }
}
const status = api('/database');
const all = api('/database/schema');
const [st, list] = await Promise.all([status, all]);
const data = st?.data || st || {};
if (String(data.state || '') !== 'ready') throw new Error('database_not_ready');
const body = list?.data ?? list;
const tables = Array.isArray(body?.tables) ? body.tables : (Array.isArray(body) ? body : []);
if (!tables.length) throw new Error('schema_empty');

const out = {};
for (const t of tables) {
  const name = String(t.tableName || t.name || '');
  if (!name || !/^[a-z_][a-z0-9_]{1,62}$/.test(name)) continue;
  const cols = (t.columns || []).map((c) => (c && typeof c === 'object' ? c.name : c)).filter(Boolean).map(String);
  out[name] = [...new Set(cols)].sort();
}
const target = new URL('../tests/fixtures/cloud-schema.json', import.meta.url);
let note = '';
try { const prev = JSON.parse(await readFile(target, 'utf8')); note = prev._comment || ''; } catch {}
const stamped = { _comment: note || '托管库实际存在的表与列清单（仅表名/列名，无租户或凭据信息），用于保真夹具。', ...out };
await writeFile(target, JSON.stringify(stamped, null, 1) + '\n');
console.log('cloud-schema.json 已更新：表 ' + Object.keys(out).length + ' 张（' + domain + '）');
