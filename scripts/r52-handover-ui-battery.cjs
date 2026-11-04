// 第52轮 AI 交接班 UI 电池：宿主模式 + 隔离夹具库 + 桩模型 + 真实浏览器完整点击路径。
// 不访问真实业务库/真实模型服务。用法：node scripts/r52-handover-ui-battery.cjs
// 可用 PLAYWRIGHT_MODULE / BROWSER_EXECUTABLE / QA_OUTPUT_DIR 覆盖默认工具与截图目录。
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const REPO = path.resolve(__dirname, "..");
const SHOT = process.env.QA_OUTPUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "r52-ui-"));
fs.mkdirSync(SHOT, { recursive: true });
let pass = 0, fail = 0; const K = (n, c, x = "") => { console.log((c ? "PASS " : "FAIL ") + n, String(x).slice(0, 160)); c ? pass++ : fail++; };
(async () => {
  const { startFixtureDatabase, passwordHash } = await import(path.join(REPO, "tests/fixtures/account-db.mjs"));
  const bjToday = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const db = await startFixtureDatabase();
  for (const t0 of ["handover_settings", "handover_reports", "handover_notes", "handover_note_deletions", "notification_events", "training_tasks", "review_requests", "interventions", "alerts", "risk_cases", "score_snapshots", "audit_logs", "action_center_reads", "action_center_hidden", "driver_safety_goals", "daily_safety_reports", "daily_report_jobs", "training_courses", "evaluation_actions"]) db.tables[t0] ||= [];
  db.tables.app_users.push(
    { user_id: "test-admin2", username: "preview_admin2", display_name: "管理员乙", role: "safety_admin", fleet_scope: "*", account_status: "active", password_hash: passwordHash("PreviewAdmin2026"), must_change_password: false, avatar_url: null },
    { user_id: "test-ofc1", username: "preview_ofc1", display_name: "安全员甲", role: "safety_officer", fleet_scope: "fleet-one", account_status: "active", password_hash: passwordHash("PreviewOfficer2026"), must_change_password: false, avatar_url: null },
  );
  db.tables.alerts.push({ alert_id: "A-SEED", driver_id: "driver-one", gpsno: "TEST-VEHICLE-RAW-01", rule_code: "R1", status: "pending_review", occurred_at: new Date().toISOString(), is_replay: false });
  db.tables.handover_reports.push(
    { id: "ho-legacy-done", owner_id: "test-admin2", scope: "*", report_date: "2026-10-29", cutoff_at: "2026-10-29T10:00:00Z", captured_at: "2026-10-29T10:01:00Z", trigger_kind: "auto", snapshot: JSON.stringify({ counts: { new_cases: 1, pending_risks: 1 }, items: [], limitations: [], score_reference: {} }), summary: JSON.stringify({ overview: "历史AI句（done 行）", priorities: [{ text: "历史重点：复核车辆1 案卷", refs: [] }] }), ai_status: "done", ai_error: null, recipient_id: null, status: "accepted", accepted_at: "2026-10-29T11:00:00Z", accepted_note: "" },
  );
  db.tables.handover_reports.push({ id: 'ho-legacy-broken', owner_id: "test-admin", scope: "*", report_date: "2026-10-05", cutoff_at: "2026-10-05T10:00:00Z", captured_at: "2026-10-05T10:01:00Z", trigger_kind: "manual", snapshot: JSON.stringify({ counts: { new_cases: 1, pending_risks: 1 }, items: [{ id: "alert:A-SEED", kind: "alert", title: "风险案卷待复核", vehicle: "车辆1", status: "pending_review", is_replay: false }] }), summary: JSON.stringify({ overview: "早期AI摘要句：待复核案卷 1 项。", priorities: [{ text: "复核车辆1 案卷证据", refs: ["alert:A-SEED"] }] }), ai_status: "done", ai_error: null, recipient_id: null, status: "open", accepted_at: null, accepted_note: null }); // R53 回归件：V41 前缺字段的线上同款形状
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r52-stub-"));
  const preload = path.join(dir, "ai-stub.cjs");
  fs.writeFileSync(preload, `
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (url.startsWith('https://ai-stub.invalid')) {
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ overview: '本班待复核案卷 1 项（历史口径）。', priorities: [{ text: '优先处置车辆1 的风险案卷，接班后确认证据。', refs: ['alert:A-SEED'] }], suggestion: '先证据后沟通再验收。' }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return real(input, init);
};`);
  const PORT = "3152";
  const child = spawn(process.execPath, ["--require", preload, "server.mjs"], { cwd: REPO, env: { HOST: "127.0.0.1", PORT, SUPABASE_URL: db.url, SUPABASE_ANON_KEY: "test", SUPABASE_INSTANCE_ID: "fixture", QW_AI_BASE_URL: "https://ai-stub.invalid", QW_AI_API_KEY: "stub-key-abcdefghij", QW_AI_MODEL: "stub-model" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", x => out += x); child.stderr.on("data", x => out += x);
  const B = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(B + "/healthz")).ok) break; } catch { } await new Promise(r => setTimeout(r, 50)); }
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "/usr/lib/node_modules/playwright");
  const exec = process.env.BROWSER_EXECUTABLE || (fs.existsSync("/opt/playwright-browsers/chromium-1209/chrome-linux64/chrome") ? "/opt/playwright-browsers/chromium-1209/chrome-linux64/chrome" : undefined);
  const br = await chromium.launch({ headless: true, executablePath: exec, args: ["--no-sandbox"] });
  const ignorable = e => /favicon|React DevTools|http:401 \/api\/(auth\/status|me)$|chat\/contacts|risk\/live|^console:/.test(e);
  async function session(user, pw) {
    const pg = await (await br.newContext({ viewport: { width: 1500, height: 980 } })).newPage();
    const errs = [];
    pg.on("pageerror", e => errs.push(String(e).slice(0, 140)));
    pg.on("response", res => { if (res.status() >= 400) errs.push("http:" + res.status() + " " + new URL(res.url()).pathname); });
    await pg.goto(B + "/", { waitUntil: "domcontentloaded" }); await pg.waitForTimeout(700);
    await pg.getByRole("button", { name: /使用账号登录|使用工作台账号登录/ }).first().click().catch(() => {});
    await pg.locator("#ln").fill(user); await pg.locator("#pw").fill(pw);
    await pg.locator(".login-submit").click(); await pg.waitForTimeout(1600);
    return { pg, errs };
  }
  const { pg, errs } = await session("preview_admin", "PreviewAdmin2026");
  await pg.goto(B + "/#/handover", { waitUntil: "domcontentloaded" }); await pg.waitForTimeout(1800);
  let T = await pg.evaluate(() => document.body.innerText || "");
  K("H1 交接班页打开（标题+空列表口径文案，无红条崩溃）", /AI 交接班助手/.test(T) && /我的交接设置/.test(T) && !/操作未完成|加载失败/.test(T));
  // 历史 done 行在侧栏呈现为可点记录（legacy 翻译在列表层可见）
  K("H2 历史交接记录行渲染（日期·交班人·计数）", /2026-10-29 · 管理员乙/.test(T) && /风险 1/.test(T), (T.match(/2026-10-29[^\n]*/) || [""])[0]);
  await pg.locator("button.handover-record", { hasText: "2026-10-29" }).first().click(); await pg.waitForTimeout(1500);
  T = await pg.evaluate(() => document.body.innerText || "");
  K("H3 历史 done 单打开：AI 总结区显示『千问已生成』+历史句（此前恒『等待生成』）", /千问已生成/.test(T) && /历史AI句/.test(T));
  K("H4 交班重点回链按钮在位", await pg.locator(".paper-priorities").count() > 0);
  await pg.locator("button.handover-record", { hasText: "2026-10-05" }).first().click(); await pg.waitForTimeout(1500);
  T = await pg.evaluate(() => document.body.innerText || "");
  K("H4b R53：早期缺字段旧单能打开（纸张渲染、脚注『评分数据截至 未取得』，此前整页崩）", await pg.locator(".handover-paper").count() > 0 && /未取得/.test(T) && !/操作未完成/.test(T));
  K("H4c 旧单状态细分：open 无接班人显示『待指定接班人』且交班人仍可指派", /待指定接班人/.test(T) && await pg.locator("select[aria-label='交接单接班人']").count() > 0);
  K("H4d 旧单 AI 总结区如实翻译（千问已生成 + 早期句）", /千问已生成/.test(T) && /早期AI摘要句/.test(T));
  // 设置：下班时间 00:00（保证"生成今日交接单"按钮可用）
  await pg.locator("details.handover-settings summary").click(); await pg.waitForTimeout(300);
  await pg.getByLabel("下班时间").fill("00:00");
  await pg.locator("button", { hasText: "保存设置" }).click(); await pg.waitForTimeout(1300);
  T = await pg.evaluate(() => document.body.innerText || "");
  K("H5 设置保存成功（标题显示 00:00 下班）", /交接设置已保存/.test(T) && /00:00/.test(T));
  await pg.locator("button", { hasText: "预览今日交接" }).click(); await pg.waitForTimeout(1600);
  T = await pg.evaluate(() => document.body.innerText || "");
  K("H6 今日预览打开（纸张视图+预览标签+概况指标）", /当日交接预览/.test(T) && /本班工作概况/.test(T) && /接班重点事项/.test(T) && !/导出未完成/.test(T));
  K("H7 预览不冒充正式单（今日预览标签+预览提示语）", /今日预览 · 未发送/.test(T) && /当前预览已生成/.test(T), (T.match(/今日预览[^\n]*/) || [""])[0]);
  await pg.locator("button", { hasText: "生成今日交接单" }).click({ timeout: 5000 }); await pg.waitForTimeout(3500);
  T = await pg.evaluate(() => document.body.innerText || "");
  K("H8 正式单生成打开：04 AI 总结=千问已生成 · stub-model + AI 句", /今日交接单已生成/.test(T) && /千问已生成 · stub-model/.test(T) && /本班待复核案卷 1 项/.test(T), (T.match(/千问已生成[^\n]*/) || [""])[0]);
  K("H9 02 接班重点含证据回链按钮", /查看 车辆1 · 风险案卷待复核/.test(T) || (await pg.locator(".paper-evidence button").count()) > 0);
  await pg.locator("textarea[aria-label='手写接班重点']").fill("夜班前完成车辆1 回访");
  await pg.locator("button", { hasText: "添加重点" }).click(); await pg.waitForTimeout(1400);
  T = await pg.evaluate(() => document.body.innerText || "");
  K("H10 手写接班重点保存并出现在文档", /接班重点已保存/.test(T) && /夜班前完成车辆1 回访/.test(T));
  // 发送交接给管理员乙
  await pg.locator("select[aria-label='交接单接班人']").selectOption("test-admin2");
  await pg.locator("button", { hasText: "发送交接" }).click(); await pg.waitForTimeout(1500);
  T = await pg.evaluate(() => document.body.innerText || "");
  K("H11 发送交接成功（通知接班人，非『操作未完成』）", /已通知接班人/.test(T) && !/操作未完成/.test(T));
  await pg.screenshot({ path: path.join(SHOT, "r52-01-generated.png") });
  const a2 = await session("preview_admin2", "PreviewAdmin2026");
  await a2.pg.goto(B + "/#/handover", { waitUntil: "domcontentloaded" }); await a2.pg.waitForTimeout(1800);
  await a2.pg.locator("button.handover-record", { hasText: bjToday }).first().click(); await a2.pg.waitForTimeout(1400);
  let T2 = await a2.pg.evaluate(() => document.body.innerText || "");
  K("H12 接班人列表当天待接收单可选中打开", /待接收/.test(T2) && T2.includes(bjToday) && /待接收|已接收/.test(T2));
  await a2.pg.locator("button", { hasText: "确认接收交接单" }).click({ timeout: 5000 }).catch(() => {});
  await a2.pg.waitForTimeout(1600);
  T2 = await a2.pg.evaluate(() => document.body.innerText || "");
  K("H13 接收成功转『已接收』（交班/接班签字栏显示接班人）", /交接单已接收/.test(T2) && !/操作未完成/.test(T2));
  await a2.pg.screenshot({ path: path.join(SHOT, "r52-02-accepted.png") });
  const o1 = await session("preview_ofc1", "PreviewOfficer2026");
  await o1.pg.goto(B + "/#/handover", { waitUntil: "domcontentloaded" }); await o1.pg.waitForTimeout(1800);
  const OT = await o1.pg.evaluate(() => document.body.innerText || "");
  K("H14 安全员打开页面正常（本车队范围，无红条崩溃）", /AI 交接班助手/.test(OT) && !/操作未完成|handover_forbidden|加载失败/.test(OT));
  const adminHard = errs.filter(e => !ignorable(e));
  const a2Hard = a2.errs.filter(e => !ignorable(e));
  const o1Hard = o1.errs.filter(e => !ignorable(e));
  K("H15 三角色页面无 handover 相关 4xx/5xx 或运行时异常", !adminHard.concat(a2Hard, o1Hard).some(e => /handover/i.test(e)), adminHard.concat(a2Hard, o1Hard).slice(0, 4).join(" ;; "));
  K("H16 服务端无交接相关 DB/WAF 失败", !/punish|DB_DETAIL[^\n]*handover/i.test(out), (out.match(/DB_DETAIL[^\n]{0,60}/g) || []).slice(0, 2).join(" | "));
  await br.close(); child.kill(); await db.close();
  console.log(`\nR52 HANDOVER UI RESULT pass=${pass} fail=${fail} shots=${SHOT}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("RUNNER ERR", String(e).slice(0, 300)); process.exit(2); });
