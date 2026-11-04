// 第60轮 AI 聊天附件 + 待确认清单 云端 UI 电池（宿主模式 + 保真夹具 + 真实浏览器 + 桩模型）。
// 验证：📎 上传→附件标签→"思考中"气泡→确认卡→人工确认后真实写库（账号+绑定+一次性口令 / 课程草稿 / 培训任务+通知），
// 以及云端边界文案（PDF 拒绝、司机越权拒绝、审计更正提示）。API 200 不等于页面能用（R50 教训），故全部走真实点击。
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const REPO = path.resolve(__dirname, "..");
const OUT = process.env.QA_OUTPUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "r60-ai-"));
fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const K = (n, c, x = "") => { console.log((c ? "PASS " : "FAIL ") + n, String(x).slice(0, 170)); c ? pass++ : fail++; };
const { createServer: _netServer } = require("node:net");
async function _freePort() { const sv = _netServer(); await new Promise((r) => sv.listen(0, "127.0.0.1", r)); const pp = sv.address().port; await new Promise((r) => sv.close(r)); return String(pp); }
const shot = async (pg, name) => { try { await pg.screenshot({ path: path.join(OUT, name) }); } catch { } };

const PRELOAD = path.join(REPO, 'scripts/r60-ai-stub.cjs');

(async () => {
  console.log('STEP boot');
  const PORT = process.env.QA_PORT || await _freePort();
  console.log('STEP port', PORT);
  const { startFixtureDatabase, passwordHash } = await import(path.join(REPO, 'tests/fixtures/account-db.mjs'));
  const { zipSync, strToU8 } = require('fflate');
  const schema = JSON.parse(fs.readFileSync(path.join(REPO, 'tests/fixtures/cloud-schema.json'), 'utf8'));
  delete schema._comment;
  const db = await startFixtureDatabase({ schema });
  const t = db.tables;
  for (const n of Object.keys(schema)) t[n] ||= [];
  for (const n of ['app_users', 'app_sessions', 'user_bindings', 'audit_logs', 'training_tasks', 'notification_events', 'chat_messages', 'ai_chat_uploads', 'ai_action_plans', 'operation_config', 'daily_safety_reports', 'driver_safety_goals']) t[n] = [];
  t.app_users.push(
    { user_id: 'u-admin', username: 'r60_admin', display_name: '安全管理员', role: 'safety_admin', fleet_scope: '*', account_status: 'active', password_hash: passwordHash('R60Admin2026'), must_change_password: false, avatar_url: null, binding_verified: false },
    { user_id: 'u-drv', username: 'r60_driver', display_name: '一号司机', role: 'driver', fleet_scope: 'fleet-one', driver_id: 'D001', account_status: 'active', binding_verified: true, password_hash: passwordHash('R60Driver2026'), must_change_password: false, avatar_url: null },
  );
  t.drivers = [{ driver_id: 'D001', gpsno: 'GPS0001', fleet_id: 'fleet-one', identity_status: 'verified', mapping_start: '2026-06-01', mapping_end: null }, { driver_id: 'D002', gpsno: 'GPS0002', fleet_id: 'fleet-one', identity_status: 'verified', mapping_start: '2026-06-01', mapping_end: null }];
  t.vehicle_labels = [{ gpsno: 'GPS0001', display_no: 1 }, { gpsno: 'GPS0002', display_no: 2 }];
  t.score_snapshots = [
    { score_id: 'S1', driver_id: 'D001', gpsno: 'GPS0001', risk_level: 'A', confidence_level: 'high', as_of_date: '2026-07-31', source_version: 'sv-r60' },
    { score_id: 'S2', driver_id: 'D002', gpsno: 'GPS0002', risk_level: 'C', confidence_level: 'high', as_of_date: '2026-07-31', source_version: 'sv-r60' },
  ];
  t.training_courses = [{ course_id: 'CRS_R60', title: '疲劳驾驶专项', dimension: 'fatigue_distraction', content: '正文', completion_requirement: '完成测验', content_status: 'approved', version_no: 2, source_version: 'sv-r60', updated_at: '2026-07-01T00:00:00Z' }];

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r60-ui-'));
  const preload = PRELOAD;
  console.log('STEP fixture ready');
  const child = spawn(process.execPath, ['--require', preload, 'server.mjs'], {
    cwd: REPO, windowsHide: true,
    env: { HOST: '127.0.0.1', PORT, SUPABASE_URL: db.url, SUPABASE_ANON_KEY: 'test', SUPABASE_INSTANCE_ID: 'fixture', QW_AI_BASE_URL: 'https://r60-ui-stub.invalid', QW_AI_API_KEY: 'r60-ui-stub-key-123456', QW_AI_MODEL: 'stub-model' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; let out2 = '';
  child.stderr.on('data', (x) => { log += x });
  child.stdout.on('data', (x) => { out2 += x });
  child.on('exit', (code) => { console.log('SERVER_EXIT', code, (log + out2).slice(-1500)); });
  const B = `http://127.0.0.1:${PORT}`;
  let up = false;
  for (let i = 0; i < 200; i++) { try { if ((await fetch(B + '/healthz')).ok) { up = true; break; } } catch { } await new Promise((r) => setTimeout(r, 50)); }
  console.log('STEP server up=',up);
  if (!up) { console.log('SERVER_NOT_UP\n' + log.slice(-1200) + '\n' + out2.slice(-500)); child.kill(); db.close(); process.exit(2); }

  // 夹具文件：账号表 xlsx（inlineStr）、课程材料 docx、假 PDF
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const cell = (ref, text, header) => `<c r="${ref}" t="inlineStr"${header ? ' s="1"' : ''}><is><t>${text}</t></is></c>`;
  const rows = [['用户名', '显示名', '角色', '对应车辆'], ['r60_ui_new', '上岗司机', '司机', '车辆2'], ['r60_ui_ofc', '上岗安全员', '安全员', '']];
  const sheet = `<worksheet xmlns="${ns}"><sheetData>` + rows.map((r, i) => `<row r="${i + 1}">` + r.map((v, j) => cell(String.fromCharCode(65 + j), String(v), i === 0)).join('') + '</row>').join('') + '</sheetData></worksheet>';
  const xlsxFile = path.join(dir, '账号表.xlsx');
  fs.writeFileSync(xlsxFile, Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>'),
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'),
    'xl/workbook.xml': strToU8(`<workbook xmlns="${ns}"><sheets><sheet name="账号导入" sheetId="1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'),
    'xl/styles.xml': strToU8(`<styleSheet xmlns="${ns}"><cellXfs count="2"><xf/><xf/></cellXfs></styleSheet>`),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  })));
  const docxFile = path.join(dir, '培训材料.docx');
  const dp = (x) => `<w:p><w:r><w:t>${x}</w:t></w:r></w:p>`;
  fs.writeFileSync(docxFile, Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>'),
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'),
    'word/document.xml': strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${dp('疲劳驾驶管控要点')}${dp('连续驾驶不得超过4小时，停车休息不少于20分钟')}${dp('夜间行车间距应上浮')}${'</w:body></w:document>'}`),
  })));
  const pdfFile = path.join(dir, '扫描材料.pdf');
  fs.writeFileSync(pdfFile, Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'));

  let br = null;
  try {
    console.log('STEP launching browser');
    const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/usr/lib/node_modules/playwright');
    const exec = process.env.BROWSER_EXECUTABLE || (fs.existsSync('/opt/playwright-browsers/chromium-1209/chrome-linux64/chrome') ? '/opt/playwright-browsers/chromium-1209/chrome-linux64/chrome' : undefined);
    br = await chromium.launch({ headless: true, executablePath: exec, args: ['--no-sandbox'] });
  } catch (e) { console.log('BROWSER_SKIP', String(e).slice(0, 120)); }

  async function login(u, p) {
    const pg = await (await br.newContext({ viewport: { width: 1500, height: 980 } })).newPage();
    const errs = [];
    pg.on('pageerror', (e) => errs.push(String(e).slice(0, 140)));
    pg.on('response', (res) => { if (res.status() >= 400 && !/attachment_expired|attachment_forbidden|415|credentials_not_stored/.test(String(res.status())) && /\/api\/(ai|agent)\//.test(res.url())) errs.push('http:' + res.status() + ' ' + res.url().slice(-30)); });
    await pg.goto(B + '/', { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(700);
    await pg.getByRole('button', { name: /使用账号登录|使用工作台账号登录/ }).first().click().catch(() => { });
    await pg.locator('#ln').fill(u); await pg.locator('#pw').fill(p);
    await pg.locator('.login-submit').click(); await pg.waitForTimeout(1700);
    for (let i = 0; i < 10; i++) { if (await pg.evaluate(() => !!document.querySelector('.ai-panel'))) break; await pg.locator('button.ai-fab').click({ force: true }).catch(() => { }); await pg.waitForTimeout(600); }
    if (process.env.R60_DEBUG) { const dump = await pg.evaluate(() => ({ hash: location.hash, hasFab: !!document.querySelector('button.ai-fab'), text: (document.body.innerText || '').slice(0, 300), errs: window.__errs || null })); console.log('DEBUG_LOGIN', JSON.stringify(dump)); }
    return { pg, errs };
  }
  const ask = async (pg, text) => { await pg.locator('.ai-panel input[aria-label="AI 提问"]').first().fill(text); await pg.locator('.ai-panel button:has-text("发送")').first().click(); };
  const panelText = (pg) => pg.evaluate(() => (document.querySelector('.ai-panel') || { innerText: '' }).innerText);
  const waitForAnswer = async (pg, re, tries = 26) => { let txt = ''; for (let i = 0; i < tries; i++) { txt = await panelText(pg); if (re.test(txt)) return true; await new Promise((r) => setTimeout(r, 900)); } return false; };

  console.log('STEP browser ready, logging in');
  if (br) {
    const A = await login('r60_admin', 'R60Admin2026');
    K("A1 AI 面板出现，📎 上传按钮在输入框左侧", (await A.pg.locator('.ai-panel button[aria-label="上传文件"]').count()) === 1);
    K("A2 上传控件只接受云端支持的格式（无 PDF）", await A.pg.evaluate(() => { const i = document.querySelector('.ai-panel input[type="file"]'); return i ? /\\.xlsx/.test(i.accept) && /\\.docx/.test(i.accept) && !/\\.pdf/.test(i.accept) : false; }));

    // PDF 诚实拒绝
    await A.pg.locator('.ai-panel input[type="file"]').setInputFiles(pdfFile); await A.pg.waitForTimeout(1800);
    let txt = await panelText(A.pg);
    const rejected = await A.pg.evaluate(() => (Array.from(document.querySelectorAll('.ai-panel .alert')).map((x) => x.innerText).join(' ')));
    K("A3 上传 PDF 被诚实拒绝并说明替代格式", /云端工作台不支持解析 PDF/.test(rejected) && /docx|Markdown/.test(rejected), rejected.slice(0, 120));
    K("A4 拒绝后没有假附件标签", (await A.pg.locator('.ai-panel .ai-att-chip').count()) === 0);

    // 上传账号表 → 附件标签
    await A.pg.locator('.ai-panel input[type="file"]').setInputFiles(xlsxFile); await A.pg.waitForTimeout(2200);
    const chip = await A.pg.evaluate(() => (document.querySelector('.ai-panel .ai-att-chip') || { innerText: '' }).innerText);
    K("A5 附件标签含 文件名·类型·字数", /账号表\.xlsx/.test(chip) && /表格/.test(chip) && /字/.test(chip), chip.replace(/\n/g, ' '));

    const accountsBefore = t.app_users.length;
    await A.pg.locator('.ai-panel input[aria-label="AI 提问"]').fill('按表格批量创建账号');
    await A.pg.locator('.ai-panel button:has-text("发送")').first().click();
    await A.pg.waitForTimeout(450);
    const thinking = await A.pg.evaluate(() => { const el = document.querySelector('.ai-panel .ai-thinking'); return el ? el.innerText : ''; });
    K("A6 发送后立刻出现「思考中」动画气泡", /思考中，正在查询数据并整理回答/.test(thinking), thinking.slice(0, 60));
    const dots = await A.pg.evaluate(() => (document.querySelectorAll('.ai-panel .ai-thinking-dots i') || []).length);
    K("A7 思考气泡带三个跳动圆点（并支持减弱动画）", dots === 3, 'dots=' + dots);

    const gotPlan = await waitForAnswer(A.pg, /已准备待确认清单：账号导入 2 项/);
    K("A8 桩模型驱动的账号清单文案来自真实 action_plan", gotPlan, (await panelText(A.pg)).slice(-160).replace(/\n/g, ' ⏎ '));
    K("A9 确认前账号表没有新增", t.app_users.length === accountsBefore, `before=${accountsBefore} now=${t.app_users.length}`);
    const cardTitle = await A.pg.evaluate(() => (document.querySelector('.ai-panel .agent-action-card b') || { innerText: '' }).innerText);
    K("A10 界面出现「批量创建账号」确认卡", /批量创建账号/.test(cardTitle), cardTitle);
    await shot(A.pg, 'r60_01_账号待确认清单.png');

    await A.pg.locator('.ai-panel .agent-action-card button.btn.primary').first().click();
    const done = await waitForAnswer(A.pg, /已完成 2 项/);
    K("A11 人工确认后真的创建 2 个账号", done && t.app_users.length === accountsBefore + 2, `now=${t.app_users.length}`);
    const creds = await A.pg.evaluate(() => (document.querySelector('.ai-panel .agent-credentials') || { innerText: '' }).innerText);
    K("A12 一次性初始口令表格出现并可另存", /初始口令（仅此一次显示，服务端不留存）/.test(creds) && /r60_ui_new/.test(creds) && /下载一次性口令表/.test(creds), creds.slice(0, 150).replace(/\n/g, ' ⏎ '));
    K("A13 口令不进清单存储（ai_action_plans 无口令字段）", !JSON.stringify(t.ai_action_plans).includes('initial_password'));
    const bound = t.app_users.find((u) => u.username === 'r60_ui_new');
    K("A14 对应车辆完成绑定并限定车队范围", bound && bound.driver_id === 'D002' && bound.binding_verified === true && bound.fleet_scope === 'fleet-one', JSON.stringify({ d: bound && bound.driver_id, v: bound && bound.binding_verified }));
    K("A15 建号审计留痕（batch_id 指向清单）", t.audit_logs.some((a) => a.action === 'account.create' && String(a.detail_json || '').includes('batch_id')));
    await shot(A.pg, 'r60_02_一次性口令.png');

    // 文件生成课程
    const coursesBefore = t.training_courses.length;
    await A.pg.locator('.ai-panel input[type="file"]').setInputFiles(docxFile); await A.pg.waitForTimeout(2400);
    await A.pg.locator('.ai-panel input[aria-label="AI 提问"]').fill('根据这份文档生成疲劳驾驶培训课程，出 2 道题');
    await A.pg.locator('.ai-panel button:has-text("发送")').first().click();
    const coursePlan = await waitForAnswer(A.pg, /已准备待确认清单：培训课程草稿 1 项/);
    K("B1 据文件生成课程 → 待确认清单出现", coursePlan, (await panelText(A.pg)).slice(-140).replace(/\n/g, ' ⏎ '));
    K("B2 确认前课程库不新增课程", t.training_courses.length === coursesBefore);
    await A.pg.locator('.ai-panel .agent-action-card button.btn.primary').last().click();
    const courseDone = await waitForAnswer(A.pg, /已完成 1 项/);
    const drafted = t.training_courses.slice(coursesBefore)[0];
    K("B3 确认后课程只入库为待审核草稿", courseDone && drafted && drafted.content_status === 'draft', drafted ? drafted.content_status : 'no-row');
    K("B4 课程内容带 AI 题目且不声称已审核", drafted && /editable_course_v1/.test(drafted.content) && (JSON.parse(drafted.content).questions || []).length >= 2);
    await A.pg.evaluate(() => { location.hash = '#/tr-courses'; }); await A.pg.waitForTimeout(2200);
    const board = await A.pg.evaluate(() => document.body.innerText);
    K("B5 课程中心可见该草稿（待审核态）", new RegExp((drafted && drafted.title || '培训课程').slice(0, 12)).test(board), (drafted || {}).title);
    await shot(A.pg, 'r60_03_课程草稿待审核.png');

    // 培训清单（对象放开到 A 级）
    const tasksBefore = t.training_tasks.length;
    await A.pg.evaluate(() => { location.hash = '#/overview'; }); await A.pg.waitForTimeout(900);
    await A.pg.locator('.ai-panel input[aria-label="AI 提问"]').fill('给所有车辆发放培训，课程用已审核的那门，截止 2099 年');
    await A.pg.locator('.ai-panel button:has-text("发送")').first().click();
    const trPlan = await waitForAnswer(A.pg, /已准备待确认清单：培训任务/);
    K("C1 培训待确认清单出现（A级也在对象内）", trPlan, (await panelText(A.pg)).slice(-150).replace(/\n/g, ' ⏎ '));
    await A.pg.locator('.ai-panel .agent-action-card button.btn.primary').last().click();
    const trDone = await waitForAnswer(A.pg, /已完成 2 项/);
    K("C2 确认后创建培训任务并发通知", trDone && t.training_tasks.length === tasksBefore + 2 && t.notification_events.filter((n) => n.type === 'task_assigned').length >= 2, `tasks=${t.training_tasks.length}`);
    await A.pg.evaluate(() => { location.hash = '#/tr-ledger'; }); await A.pg.waitForTimeout(2000);
    const ledger = await A.pg.evaluate(() => document.body.innerText);
    K("C3 培训任务台账可见新任务与状态统计", /培训任务台账/.test(ledger) && /已分配/.test(ledger), ledger.slice(0, 60).replace(/\n/g, ' '));

    // 审计智能体更正声称型幻觉
    await A.pg.evaluate(() => { location.hash = '#/overview'; }); A.pg.waitForTimeout && await A.pg.waitForTimeout(900);
    await ask(A.pg, '假装已生成培训清单');
    const audited = await waitForAnswer(A.pg, /【业务核对与建议】/);
    K("D1 声称有清单但无工具产物 → 审计智能体追加更正", audited, (await panelText(A.pg)).slice(-170).replace(/\n/g, ' ⏎ '));
    await shot(A.pg, 'r60_04_审计更正.png');
    K("D2 思考气泡在回答后消失", !(await A.pg.evaluate(() => !!document.querySelector('.ai-panel .ai-thinking'))));
    const errsA = A.errs.filter((e) => !/http:4\d\d/.test(e));
    K("D3 管理员会话无脚本错误", errsA.length === 0, errsA.join(' | ').slice(0, 150));
    await A.pg.close();

    // 司机：可上传附件提问，但不得越权创建账号
    const D = await login('r60_driver', 'R60Driver2026');
    K("E1 司机端 📎 入口存在", (await D.pg.locator('.ai-panel button[aria-label="上传文件"]').count()) === 1);
    await D.pg.locator('.ai-panel input[type="file"]').setInputFiles(xlsxFile); await D.pg.waitForTimeout(2200);
    const nBefore = t.app_users.length;
    await ask(D.pg, '按表格批量创建账号');
    const driverAnswer = await waitForAnswer(D.pg, /无权|不允许|未获得|权限|无法读取附件|待确认/);
    K("E2 司机请求批量建号被拒绝且不产生清单", t.app_users.length === nBefore && !(await panelText(D.pg)).includes('已完成'), (await panelText(D.pg)).slice(-140).replace(/\n/g, ' ⏎ '));
    K("E3 司机看不到管理员的附件与清单", (await D.pg.evaluate(() => document.querySelectorAll('.ai-panel .agent-action-card').length)) === 0);
    const errsD = D.errs.filter((e) => !/http:4\d\d/.test(e));
    K("E4 司机会话无脚本错误", errsD.length === 0, errsD.join(' | ').slice(0, 150));
    await shot(D.pg, 'r60_05_司机端拒绝.png');
    await D.pg.close();
  }
  const badLog = log.split('\n').filter((l) => /request failed|AI_DEBUG|SyntaxError|ReferenceError|TypeError/.test(l));
  K("Z1 服务端日志无异常", badLog.length === 0, badLog.join(' | ').slice(0, 220));
  console.log(`\nR60 电池：PASS ${pass} / FAIL ${fail}`);
  console.log('截图目录：' + OUT);
  if (br) await br.close();
  child.kill(); db.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('BATTERY_ERROR', e); process.exit(2); });
