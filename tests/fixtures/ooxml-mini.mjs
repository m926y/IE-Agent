import { zipSync, strToU8 } from 'fflate';
import { writeFileSync } from 'node:fs';
const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const cell = (ref, text, header = false) => `<c r="${ref}" t="inlineStr"${header ? ' s="1"' : ''}><is><t>${text}</t></is></c>`;
export function xlsxBytes(rows) {
  const sheet = `<worksheet xmlns="${ns}"><sheetData>` + rows.map((r, i) => `<row r="${i + 1}">` + r.map((v, j) => cell(String.fromCharCode(65 + j), String(v), i === 0)).join('') + '</row>').join('') + '</sheetData></worksheet>';
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    'xl/workbook.xml': `<workbook xmlns="${ns}"><sheets><sheet name="账号导入" sheetId="1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    'xl/styles.xml': `<styleSheet xmlns="${ns}"><cellXfs count="2"><xf/><xf/></cellXfs></styleSheet>`,
    'xl/worksheets/sheet1.xml': sheet,
  };
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([n, x]) => [n, strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + x)]))));
}
export function docxBytes(paragraphs, tableRows = []) {
  const p = (t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
  const tbl = tableRows.length ? `<w:tbl>${tableRows.map((r) => `<w:tr>${r.map((c) => `<w:tc>${p(c)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>` : '';
  const doc = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map(p).join('')}${tbl}</w:body></w:document>`;
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    'word/document.xml': doc,
  };
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([n, x]) => [n, strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + x)]))));
}
export function pptxBytes(slides) {
  const nsA = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    'ppt/presentation.xml': `<p:presentation ${nsA}/>`,
  };
  slides.forEach((texts, i) => { files[`ppt/slides/slide${i + 1}.xml`] = `<p:sld ${nsA}><p:cSld><p:spTree><p:sp><p:txBody>${texts.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`; });
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([n, x]) => [n, strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + x)]))));
}
export function writeFixtures(dir) {
  writeFileSync(dir + '/accounts.xlsx', xlsxBytes([['用户名', '显示名', '角色', '对应车辆'], ['r60_driver1', '甲一', '司机', '车辆1'], ['r60_officer1', '乙一', '安全员', '']]));
  writeFileSync(dir + '/bad-vehicle.xlsx', xlsxBytes([['用户名', '显示名', '角色', '对应车辆'], ['r60_driver2', '甲二', '司机', '车辆999']]));
  writeFileSync(dir + '/material.docx', docxBytes(['疲劳驾驶管控要点', '连续驾驶不得超过 4 小时'], [['时段', '要求'], ['夜间', '限速 10%']]));
  writeFileSync(dir + '/deck.pptx', pptxBytes([['防御性驾驶', '保持三秒跟车距离']]));
  writeFileSync(dir + '/note.md', '# 疲劳驾驶\n\n连续 4 小时必须停车休息 20 分钟。\n');
}
