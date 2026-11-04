/* R60 云端 AI 聊天附件：解析 + 页面隔离库存储（无 Python、无本地文件、无 bytea）。
 * 与本地完整版的差异（诚实边界）：本地把解析文本放 var/ai-uploads 文件系统；托管运行时是临时的，
 * 且平台红线禁止把上传字节写进数据库，因此云端只持久化"解析后的纯文本 + 表格行 + 元数据"，
 * 原始文件永不入库——不能重新下载原件、不能二次解析、正文超过 4 万字截断。
 * 解析能力：.xlsx/.csv（表格 + 结构化行）、.docx/.pptx/.html/.md/.txt（纯文本）。
 * 诚实舍弃：.pdf 在云端不支持——PDF 文本层要还原 CID/嵌入字型与扫描件需要专门解析器，
 * 托管运行时没有 Python/pypdf，硬凑的正则提取会把乱码喂给模型写出课程；云端一律拒绝并提示转格式，绝不用不可靠文本冒充解析成功。
 * 错误码与本地一致：file_type_not_supported/legacy_format_not_supported/file_too_large/file_empty/
 * csv_quote_invalid/extract_failed/extract_empty/pdf_not_supported_hosted/attachment_not_found/attachment_forbidden/attachment_expired。
 */
import { inflateRawSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';

const KINDS = { '.xlsx': 'sheet', '.csv': 'sheet', '.docx': 'document', '.pptx': 'slides', '.html': 'webpage', '.htm': 'webpage', '.md': 'markdown', '.txt': 'text' };
const KIND_LABELS = { sheet: '表格', document: '文档', slides: '幻灯片', webpage: '网页', markdown: 'Markdown', text: '纯文本' };
const LEGACY_HINTS = { '.doc': '请将 .doc 另存为 .docx 后上传', '.ppt': '请将 .ppt 另存为 .pptx 后上传', '.xls': '请将 .xls 另存为 .xlsx 后上传' };
/* 诚实拒绝：PDF 文本层（CID/嵌入字型、扫描件）需要专门解析器，托管运行时没有；不可靠文本绝不喂给模型。 */
const HOSTED_UNSUPPORTED_HINTS = { '.pdf': '云端工作台不支持解析 PDF（需要专门的 PDF 文本层/扫描件解析，仅本地完整版具备）；请把材料另存为 Word(.docx)、Markdown 或 TXT 后重新上传' };
export const AI_UPLOAD_EXTENSIONS = Object.keys(KINDS);
export const AI_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const AI_UPLOAD_TTL_MS = 24 * 3600 * 1000;
const TEXT_CAP = 40000;
const ROW_CAP = 300;
const COL_CAP = 20;
const ID_RE = /^aiu-[a-f0-9]{24}$/;

function fail(code, detail) { const e = new Error(code); e.code = code; if (detail) e.detail = detail; return e; }
const clean = (v) => String(v ?? '').replace(/\r\n/g, '\n').trim();

/* ---------- CSV（与前端 csvCells 同语义：仅取值，绝不执行公式/宏） ---------- */
export function csvRows(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  const s = String(text).replace(/^\ufeff/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') { if (quoted && s[i + 1] === '"') { cell += '"'; i++ } else quoted = !quoted }
    else if (c === ',' && !quoted) { row.push(cell); cell = '' }
    else if ((c === '\n' || c === '\r') && !quoted) { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += c;
  }
  if (quoted) throw fail('csv_quote_invalid');
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows.slice(0, ROW_CAP).map((r) => r.slice(0, COL_CAP).map((v) => String(v ?? '').trim()));
}

/* ---------- HTML ---------- */
export function htmlToText(html) {
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article|\/td)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'").replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(Number(d)) } catch { return m } });
  return s.split('\n').map((l) => l.replace(/[ \t\r]+/g, ' ').trim()).filter(Boolean).join('\n');
}

/* ---------- ZIP 容器（.xlsx/.docx/.pptx 都是 zip）：只读中央目录，无第三方依赖 ---------- */
function unzipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break } }
  if (eocd < 0) throw fail('extract_failed', '不是有效的 Zip 容器（xlsx/docx/pptx 或已损坏文件）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (localOff + 30 <= buf.length) {
      const lName = buf.readUInt16LE(localOff + 26), lExtra = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lName + lExtra;
      if (start + compSize <= buf.length) entries.set(name, { method, raw: buf.subarray(start, start + compSize) });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!entries.size) throw fail('extract_failed', '压缩包内没有可读条目');
  return entries;
}
function unzipData(entries, name) {
  const e = entries.get(name);
  if (!e) return null;
  try { return e.method === 0 ? Buffer.from(e.raw) : e.method === 8 ? inflateRawSync(e.raw) : null; } catch { return null }
}
function unzipText(entries, name) { const d = unzipData(entries, name); return d ? d.toString('utf8') : null; }
function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)) } catch { return m } })
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(Number(d)) } catch { return m } })
    .replace(/&nbsp;/gi, '\u00a0').replace(/&middot;/gi, '·')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/apos;/g, "'").replace(/&amp;/g, '&');
}
function joinTagTexts(xml, tagName) {
  const out = []; const re = new RegExp('<' + tagName + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tagName + '>', 'g');
  let m; while ((m = re.exec(xml)) !== null) out.push(decodeEntities(m[1]));
  return out;
}

/* ---------- .xlsx：第一个工作表，只取值（绝不计算公式、不执行宏） ---------- */
const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 52, 57]);
function isDateFormatCode(code) {
  const c = String(code || '').replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
  return /[ymdhs]/i.test(c) && !/^[#0?.,;%Ee+\-]|General/i.test(c);
}
function sheetStyleDateFlags(xml) {
  const flags = [];
  /* 返回每个 cellXfs 样式的口径：'' 非日期 / 'date' / 'datetime' */
  if (!xml) return flags;
  const custom = new Map();
  const nf = /<numFmt\s[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g;
  let m; while ((m = nf.exec(xml)) !== null) custom.set(Number(m[1]), decodeEntities(m[2]));
  const xfsBlock = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (xfsBlock) {
    const xfRe = /<xf\b([^>]*)/g;
    let x;
    while ((x = xfRe.exec(xfsBlock[1])) !== null) {
      const idm = /numFmtId="(\d+)"/.exec(x[1]);
      const id = idm ? Number(idm[1]) : 0;
      const code = custom.get(id);
      if (BUILTIN_DATE_FMTS.has(id)) flags.push([15, 16, 17, 22, 45, 46, 47].includes(id) || /[hms]/i.test(String(code || '')) ? 'datetime' : 'date');
      else if (custom.has(id)) flags.push(!isDateFormatCode(code) ? '' : /[hms]/i.test(String(code).replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '')) ? 'datetime' : 'date');
      else flags.push('');
    }
  }
  return flags;
}
function excelSerialToDate(serial, withTime) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 0 || n > 2958466) return null; /* 超出 1900-2100 合理区间按原样输出 */
  const days = n - 25569 + (n < 60 ? 1 : 0);
  const ms = Math.round(days * 86400 * 1000);
  const d = new Date(ms);
  const pad = (x) => String(x).padStart(2, '0');
  const date = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  if (!withTime) return date;
  return date + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
}
function colIndexOf(ref) {
  let n = 0;
  for (const ch of String(ref)) { if (ch >= 'A' && ch <= 'Z') n = n * 26 + (ch.charCodeAt(0) - 64); else if (ch >= 'a' && ch <= 'z') n = n * 26 + (ch.charCodeAt(0) - 96); else break }
  return n > 0 ? n - 1 : -1;
}
export function xlsxSheet(buf) {
  let entries;
  try { entries = unzipEntries(buf) } catch { throw fail('extract_failed', 'Excel 文件无法读取（可能已损坏或为旧版 .xls）') }
  const wb = unzipText(entries, 'xl/workbook.xml') || '';
  const sheetNames = [...wb.matchAll(/<sheet\b[^>]*name="([^"]*)"/g)].map((x) => decodeEntities(x[1]));
  const sharedItems = (() => {
    const xml = unzipText(entries, 'xl/sharedStrings.xml');
    if (!xml) return [];
    const out = []; const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let m; while ((m = re.exec(xml)) !== null) out.push(joinTagTexts(m[1], 't').join(''));
    return out;
  })();
  const dateFlags = sheetStyleDateFlags(unzipText(entries, 'xl/styles.xml'));
  const sheetOrder = [...wb.matchAll(/<sheet\b[^>]*r:id="(rId\d+)"/g)].map((x) => x[1]);
  const rels = unzipText(entries, 'xl/_rels/workbook.xml.rels') || '';
  const relTarget = (id) => { const m = new RegExp('<Relationship[^>]*Id="' + id + '"[^>]*Target="([^"]*)"', '').exec(rels); return m ? m[1] : null; };
  let sheetXml = null, sheetPath = null;
  for (const rid of sheetOrder) {
    const t = relTarget(rid); if (!t) continue;
    const full = String(t).replace(/^\/+/, '').replace(/^xl\//, '');
    const xml = unzipText(entries, 'xl/' + full);
    if (xml) { sheetXml = xml; sheetPath = full; break }
  }
  if (sheetXml === null) {
    for (const n of entries.keys()) if (/^xl\/worksheets\/(?!_rels)[^/]*\.xml$/.test(n)) { sheetXml = unzipText(entries, n); sheetPath = n; break }
  }
  if (sheetXml === null) throw fail('extract_empty', '工作簿中没有可读取的工作表');
  const rows = [];
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(sheetXml)) !== null && rows.length < ROW_CAP) {
    const cells = new Array(COL_CAP).fill('');
    const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm, auto = -1;
    while ((cm = cRe.exec(rm[2] || '')) !== null) {
      const attrs = cm[1] || '', inner = cm[2] || '';
      const refm = /\br="([A-Za-z]+)\d+"/.exec(attrs);
      const idx = refm ? colIndexOf(refm[1]) : (auto += 1);
      auto = idx > auto ? idx : auto;
      if (idx < 0 || idx >= COL_CAP) continue;
      const tm = /\bt="([^"]*)"/.exec(attrs);
      const type = tm ? tm[1] : '';
      const sm = /\bs="(\d+)"/.exec(attrs);
      const style = sm ? Number(sm[1]) : -1;
      const vm = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner);
      let value = '';
      if (type === 'inlineStr') value = clean(joinTagTexts(inner, 't').join(''));
      else if (type === 's') { const n = vm ? Number(clean(vm[1])) : NaN; value = Number.isInteger(n) && n >= 0 && n < sharedItems.length ? clean(sharedItems[n]) : '' }
      else if (vm) {
        const raw = decodeEntities(vm[1]);
        if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
        else if (type === 'e') value = '';
        else if (dateFlags[style] && /^[-\d.]+$/.test(raw)) { const d = excelSerialToDate(raw, dateFlags[style] === 'datetime'); value = d !== null ? d : clean(raw) }
        else value = clean(raw);
      }
      cells[idx] = value;
    }
    if (cells.some((c) => c !== '')) rows.push(cells); 
  }
  while (rows.length && !rows[rows.length - 1].some((c) => c !== '')) rows.pop();
  let lastCol = 0;
  for (const r of rows) for (let i = r.length - 1; i >= 0; i--) if (r[i] !== '') { if (i + 1 > lastCol) lastCol = i + 1; break }
  const trimmed = rows.map((r) => r.slice(0, lastCol));
  const note = sheetNames.length > 1 ? '（云端只解析第一个工作表「' + (sheetNames[0] || sheetPath || 'Sheet1') + '」，其余 ' + (sheetNames.length - 1) + ' 个工作表未解析）\n' : '';
  return { rows: trimmed, sheets: sheetNames, text: note + trimmed.slice(0, 200).map((r) => r.join('\t')).join('\n') };
}

/* ---------- .docx：正文段落 + 表格行（样式、图片、批注、域代码忽略） ---------- */
const DOCX_TOKEN = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>|<\/?w:(p|tc|tr|tbl)\b[^>]*>/g;
export function docxText(buf) {
  const entries = (() => { try { return unzipEntries(buf) } catch { throw fail('extract_failed', 'Word 文件无法读取（可能已损坏或为旧版 .doc）') } })();
  const xml = unzipText(entries, 'word/document.xml');
  if (!xml) throw fail('extract_empty', '文档正文为空或缺少 word/document.xml');
  const lines = [];
  let para = '', cell = null, row = null;
  const flushPara = () => { const t = para.replace(/[ \t\r]+/g, ' ').trim(); para = ''; if (!t) return; if (cell !== null) cell += (cell ? '\n' : '') + t; else lines.push(t) };
  const flushCell = () => { const t = cell === null ? '' : cell.trim(); cell = null; if (row !== null && t) row.push(t.replace(/\n/g, ' ')) };
  const flushRow = () => { const cells = row; row = null; if (cells && cells.length) lines.push(cells.join(' | ')) };
  DOCX_TOKEN.lastIndex = 0;
  let m;
  while ((m = DOCX_TOKEN.exec(xml)) !== null) {
    if (m[1] !== undefined) { para += decodeEntities(m[1]); continue }
    const tok = m[0];
    if (tok.startsWith('<w:tab')) { para += '\t'; continue }
    if (tok.startsWith('<w:br') || tok.startsWith('<w:cr')) { para += '\n'; continue }
    const closing = tok[1] === '/';
    const tag = m[2];
    if (tag === 'p') { if (closing) flushPara(); continue }
    if (tag === 'tc') { if (closing) flushCell(); else { flushPara(); cell = '' } continue }
    if (tag === 'tr') { if (closing) { flushCell(); flushRow() } else row = []; continue }
    if (tag === 'tbl') { if (closing) { flushPara(); flushCell(); flushRow() } else flushPara(); continue }
  }
  flushPara(); flushCell(); flushRow();
  const text = lines.join('\n').replace(/[ \t]+\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  if (!text) throw fail('extract_empty', '文档没有可提取的文字（可能是纯图片或扫描版）');
  return text;
}

/* ---------- .pptx：逐页文本框（按段落）与表格行 ---------- */
const PPTX_TOKEN = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<\/?a:(p|tc|tr|txbody)\b[^>]*>/g;
export function pptxText(buf) {
  const entries = (() => { try { return unzipEntries(buf) } catch { throw fail('extract_failed', 'PPT 文件无法读取（可能已损坏或为旧版 .ppt）') } })();
  const names = [...entries.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
    .sort((a, b) => (Number(/(\d+)\.xml$/i.exec(a)?.[1] || 0) - Number(/(\d+)\.xml$/i.exec(b)?.[1] || 0)));
  if (!names.length) throw fail('extract_empty', '演示文稿没有可读幻灯片');
  const parts = [];
  names.forEach((n, i) => {
    const xml = unzipText(entries, n) || '';
    const lines = [];
    let para = '', cell = null, row = null;
    const flushPara = () => { const t = para.trim(); para = ''; if (!t) return; if (cell !== null) cell += (cell ? ' ' : '') + t; else lines.push(t) };
    const flushCell = () => { const t = (cell || '').trim(); cell = null; if (row !== null && t) row.push(t) };
    const flushRow = () => { const cells = row; row = null; if (cells && cells.length) lines.push(cells.join(' | ')) };
    PPTX_TOKEN.lastIndex = 0;
    let m;
    while ((m = PPTX_TOKEN.exec(xml)) !== null) {
      if (m[1] !== undefined) { para += decodeEntities(m[1]); continue }
      const closing = m[0][1] === '/';
      const tag = m[2];
      if (tag === 'p') { if (closing) flushPara(); continue }
      if (tag === 'tc') { if (closing) flushCell(); else { flushPara(); cell = '' } continue }
      if (tag === 'tr') { if (closing) { flushCell(); flushRow() } else row = []; continue }
      if (tag === 'txbody') { if (closing) flushPara(); continue }
    }
    flushPara(); flushCell(); flushRow();
    const text = lines.map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
    if (text) parts.push('[第' + (i + 1) + '页]\n' + text);
  });
  if (!parts.length) throw fail('extract_empty', '幻灯片没有可提取的文字（可能全是图片）');
  return parts.join('\n\n');
}

/* ---------- 统一解析入口 ---------- */
export function parseUploadBytes(name, bytes) {
  const extension = (/\.[a-z0-9]+$/i.exec(String(name || '')) || [''])[0].toLowerCase();
  if (LEGACY_HINTS[extension]) throw fail('legacy_format_not_supported', LEGACY_HINTS[extension]);
  if (HOSTED_UNSUPPORTED_HINTS[extension]) throw fail('pdf_not_supported_hosted', HOSTED_UNSUPPORTED_HINTS[extension]);
  const kind = KINDS[extension];
  if (!kind) throw fail('file_type_not_supported');
  if (!bytes || !bytes.length) throw fail('file_empty');
  let text = '', rows = null;
  if (extension === '.md' || extension === '.txt') text = bytes.toString('utf8');
  else if (extension === '.csv') { text = bytes.toString('utf8'); rows = csvRows(text) }
  else if (extension === '.html' || extension === '.htm') text = htmlToText(bytes.toString('utf8'));
  else if (extension === '.xlsx') { const r = xlsxSheet(bytes); rows = r.rows; text = r.text }
  else if (extension === '.docx') text = docxText(bytes);
  else if (extension === '.pptx') text = pptxText(bytes);
  text = String(text || '').replace(/\r\n/g, '\n').slice(0, TEXT_CAP);
  const truncated = kind === 'sheet' ? Boolean(rows && rows.length >= ROW_CAP) : text.length >= TEXT_CAP;
  if (!text.trim() && !(rows && rows.length)) throw fail('extract_empty', '未能从文件中提取到文字内容');
  return { kind, kind_label: KIND_LABELS[kind] || kind, extension, text, rows, truncated, chars: text.length };
}

/* 账号表映射：与前端 accountRows() 同规则（表头白名单、角色中英映射、行数上限），服务端为权威校验。 */
const ACCOUNT_HEADER_ALIASES = {
  '用户名': 'username', '账号': 'username', '登录名': 'username', 'username': 'username', 'user': 'username', 'account': 'username',
  '显示名': 'display_name', '姓名': 'display_name', '司机姓名': 'display_name', '名称': 'display_name', 'display_name': 'display_name', 'name': 'display_name',
  '角色': 'role', '岗位': 'role', '权限': 'role', 'role': 'role',
  '对应车辆': 'vehicle', '绑定车辆': 'vehicle', '车辆': 'vehicle', '车辆号': 'vehicle', '车号': 'vehicle', '车牌': 'vehicle', '车牌号': 'vehicle', '车辆编号': 'vehicle', 'vehicle': 'vehicle', 'gpsno': 'vehicle', 'gps no': 'vehicle',
};
const ACCOUNT_ROLE_ALIASES = { '司机': 'driver', '驾驶员': 'driver', '货车司机': 'driver', '安全员': 'safety_officer', '安全管理员': 'safety_admin', '管理员': 'safety_admin', '队长': 'team_leader' };
const PASSWORD_HEADER = /(密码|口令|password|passwd|pwd|token)/i;
/* 账号表映射（R62 放宽）：
 * · 表头接受同义词（绑定车辆/车号/登录名/岗位…），列顺序任意；
 * · 无法识别的列不再整批拒绝——忽略并在 ignored_columns 里如实报告（前端与清单都要显示）；
 * · 密码/口令类列一律拒绝（红线：初始口令只能由服务端生成）；
 * · 行数 1–200、列数上限 COL_CAP、角色中英文映射与本地版一致。 */
export function sheetToAccountRows(rows) {
  const cleanRows = (Array.isArray(rows) ? rows : []).filter((r) => Array.isArray(r) && r.some((c) => c !== null && c !== undefined && String(c).trim() !== ''));
  if (cleanRows.length < 2) throw fail('account_table_too_short', '请上传1–200行账号数据，另加一行表头');
  if (cleanRows.length > 201) throw fail('account_table_too_long', '请上传1–200行账号数据，另加一行表头');
  const headerRow = cleanRows[0];
  let cols = headerRow.length;
  while (cols > 0 && (headerRow[cols - 1] === null || headerRow[cols - 1] === undefined || String(headerRow[cols - 1]).trim() === '')) cols--;
  const rawHeaders = headerRow.slice(0, cols).map((c) => String(c ?? '').replace(/^\ufeff/, '').trim());
  if (rawHeaders.some((h) => PASSWORD_HEADER.test(h))) throw fail('account_table_password_column', '账号表不能包含密码列：初始口令由服务端生成，只在确认执行后一次性显示。');
  const headers = rawHeaders.map((h) => ACCOUNT_HEADER_ALIASES[h.toLowerCase()] || ACCOUNT_HEADER_ALIASES[h] || ACCOUNT_HEADER_ALIASES[h.replace(/\s+/g, ' ').toLowerCase()]);
  const ignored = [...new Set(rawHeaders.filter((h, k) => h && !headers[k]))];
  if (!['username', 'display_name', 'role'].every((h) => headers.includes(h)))
    throw fail('account_table_header_invalid', '表头须包含：用户名、显示名、角色；可加对应车辆（同义写法如绑定车辆/车号/车牌也可识别）。');
  if (new Set(headers.filter(Boolean)).size !== headers.filter(Boolean).length) throw fail('account_table_header_duplicate', '表头有重复列，请使用账号模板。');
  const out = cleanRows.slice(1).map((r, i) => {
    const o = {};
    headers.forEach((h, k) => { if (h) o[h] = String(r[k] ?? '').trim(); });
    if (!o.username) throw fail('account_table_missing_username', '第' + (i + 2) + '行缺少用户名');
    o.role = ACCOUNT_ROLE_ALIASES[o.role] || String(o.role || 'driver').trim().toLowerCase();
    return o;
  });
  return { rows: out, ignored };
}
/* ---------- 云端存储：解析结果进页面隔离库 ai_chat_uploads（原始字节永不入库） ---------- */
export const AI_UPLOAD_MAX_COUNT = 3;
export function newUploadId() { return 'aiu-' + randomBytes(12).toString('hex') }

export function createAiUploads(db) {
  async function upload(request, user) {
    const name = decodeURIComponent(String(request.headers['x-file-name'] || '')).slice(0, 180);
    const chunks = [];
    let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > AI_UPLOAD_MAX_BYTES) throw fail('file_too_large'); chunks.push(chunk); }
    const bytes = Buffer.concat(chunks);
    const parsed = parseUploadBytes(name, bytes);
    const now = new Date();
    const meta = {
      id: newUploadId(), owner_user_id: String(user?.user_id || ''), name: name || '未命名文件',
      kind: parsed.kind, kind_label: parsed.kind_label, extension: parsed.extension, size,
      chars: parsed.chars, truncated: parsed.truncated, text: parsed.text, rows: parsed.rows,
      created_at: now.toISOString(), expires_at: new Date(now.getTime() + AI_UPLOAD_TTL_MS).toISOString(),
    };
    await db.insert(meta);
    try { await db.sweep(meta.owner_user_id, new Date().toISOString()) } catch { /* 清理失败不影响本次上传 */ }
    return meta;
  }
  async function get(id, user) {
    if (!ID_RE.test(String(id || ''))) throw fail('attachment_not_found');
    const row = await db.load(String(id));
    if (!row) throw fail('attachment_not_found');
    if (row.owner_user_id !== String(user?.user_id || '')) throw fail('attachment_forbidden');
    if (row.expires_at < new Date().toISOString()) { try { await db.remove(String(id)) } catch {}; throw fail('attachment_expired') }
    let rows = null;
    if (row.rows_json) { try { rows = JSON.parse(row.rows_json) } catch { rows = null } }
    return { id: row.upload_id, owner_user_id: row.owner_user_id, name: row.name, kind: row.kind, kind_label: row.kind_label, extension: row.extension, size: Number(row.size_bytes || 0), chars: Number(row.chars || 0), truncated: row.truncated === true || row.truncated === 'true', text: String(row.text_content || ''), rows, created_at: row.created_at, expires_at: row.expires_at };
  }
  function publicMeta(meta) {
    return { upload_id: meta.id, name: meta.name, kind: meta.kind, kind_label: meta.kind_label, chars: meta.chars, truncated: meta.truncated, rows: meta.rows ? meta.rows.length : null, expires_at: meta.expires_at };
  }
  return { upload, get, publicMeta };
}
