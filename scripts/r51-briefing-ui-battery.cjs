// 第51轮 简报面板 UI 契约电池（管理员面）：宿主模式 + 隔离夹具库 + 真实浏览器点击路径。
// 不访问真实业务库/模型：数据全部来自 tests/fixtures 内存夹具（AGENTS 数据/集成测试用临时库）。
// 用法：node scripts/r51-briefing-ui-battery.cjs
// 可用 PLAYWRIGHT_MODULE / BROWSER_EXECUTABLE / QA_OUTPUT_DIR 覆盖默认工具与截图目录。
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const REPO = path.resolve(__dirname, "..");
const SHOT = process.env.QA_OUTPUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "r51-ui-"));
fs.mkdirSync(SHOT, { recursive: true });
let pass = 0, fail = 0; const K = (n, c, x = "") => { console.log((c ? "PASS " : "FAIL ") + n, String(x).slice(0, 160)); c ? pass++ : fail++; };
(async () => {
  const { startFixtureDatabase, passwordHash } = await import(path.join(REPO, "tests/fixtures/account-db.mjs"));
  const { readDriverFacts } = await import(path.join(REPO, "server/daily-report/data-reader.mjs"));
  const { computeDriverSnapshot } = await import(path.join(REPO, "server/daily-report/safety-analyzer.mjs"));
  const { organizeDailyReport } = await import(path.join(REPO, "server/daily-report/report-agent.mjs"));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const fullReport = organizeDailyReport(computeDriverSnapshot(readDriverFacts({ rows: n => n === "drivers" ? [{ driver_id: "driver-one", gpsno: "TEST-VEHICLE-RAW-01", fleet_id: "fleet-one" }] : [], sourceHash: "seed" }, "driver-one", "2026-06-30")), today);
  const db = await startFixtureDatabase();
  for (const t0 of ["daily_report_jobs", "daily_safety_reports", "driver_safety_goals", "notification_events", "training_tasks", "review_requests", "interventions", "alerts", "action_center_reads", "action_center_hidden", "training_courses", "evaluation_actions", "audit_logs"]) db.tables[t0] ||= [];
  db.tables.drivers.push({ driver_id: "driver-three", gpsno: "TEST-VEHICLE-RAW-03", fleet_id: "fleet-one" });
  db.tables.vehicle_labels.push({ gpsno: "TEST-VEHICLE-RAW-03", display_no: 3 });
  db.tables.daily_report_jobs.push(
    { id: 1, driver_id: "driver-one", report_date: today, status: "succeeded", attempts: 1, started_at: "2026-01-01T07:00:00Z", finished_at: "2026-01-01T07:01:00Z", error_message: null },
    { id: 2, driver_id: "driver-two", report_date: today, status: "succeeded", attempts: 1, started_at: null, finished_at: null, error_message: null },
  );
  db.tables.daily_safety_reports.push(
    { id: 11, driver_id: "driver-one", report_date: today, report_version: 1, status: "published", is_current: true, published_at: "2026-01-01T07:01:00Z", source_fingerprint: "f".repeat(64), data_as_of: "2026-06-30", report_json: JSON.stringify({ ...fullReport, title: "车辆1 简报" }) },
    { id: 31, driver_id: "driver-one", report_date: "2026-01-01", report_version: 1, status: "published", is_current: false, published_at: "2026-01-01T07:00:00Z", source_fingerprint: "d".repeat(64), data_as_of: "2026-06-29", report_json: JSON.stringify({ ...fullReport, title: "旧版" }) },
  );
  db.tables.driver_safety_goals.push(
    { id: 41, driver_id: "driver-one", report_id: 31, goal_type: "practice", goal_text: "减少急刹", status: "active", feedback_code: "need_help", feedback_text: "需要设备支持", created_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-03T00:00:00Z", handled_at: null, handled_by: null, handled_note: null },
  );
  db.tables.app_users.push({ user_id: "test-officer", username: "preview_officer", display_name: "安全员甲", role: "safety_officer", fleet_scope: "fleet-one", account_status: "active", password_hash: passwordHash("PreviewOfficer2026"), must_change_password: false, avatar_url: null });
  const PORT = "3151";
  const child = spawn(process.execPath, ["server.mjs"], { cwd: REPO, env: { HOST: "127.0.0.1", PORT, SUPABASE_URL: db.url, SUPABASE_ANON_KEY: "test", SUPABASE_INSTANCE_ID: "fixture" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", x => out += x); child.stderr.on("data", x => out += x);
  const B = `http://127.0.0.1:${PORT}`; // 电池固定连自己带夹具启动的宿主实例
  for (let i = 0; i < 120; i++) { try { if ((await fetch(B + "/healthz")).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "/usr/lib/node_modules/playwright");
  const exec = process.env.BROWSER_EXECUTABLE || (fs.existsSync("/opt/playwright-browsers/chromium-1209/chrome-linux64/chrome") ? "/opt/playwright-browsers/chromium-1209/chrome-linux64/chrome" : undefined);
  const br = await chromium.launch({ headless: true, executablePath: exec, args: ["--no-sandbox"] });
  async function session(user, pw, w = 1500, h = 980) {
    const pg = await (await br.newContext({ viewport: { width: w, height: h } })).newPage();
    const errs = [];
    pg.on("pageerror", e => errs.push(String(e).slice(0, 140)));
    pg.on("response", res => { if (res.status() >= 400) errs.push("http:" + res.status() + " " + new URL(res.url()).pathname); });
    await pg.goto(B + "/", { waitUntil: "domcontentloaded" }); await pg.waitForTimeout(800);
    await pg.getByRole("button", { name: /使用账号登录|使用工作台账号登录/ }).first().click().catch(() => {});
    await pg.locator("#ln").fill(user); await pg.locator("#pw").fill(pw);
    await pg.locator(".login-submit").click(); await pg.waitForTimeout(1800);
    return { pg, errs };
  }
  const ignorable = e => /favicon|React DevTools|http:401 \/api\/(auth\/status|me)$|chat\/contacts|risk\/live|^console:/.test(e);
  const { pg, errs } = await session("preview_admin", "PreviewAdmin2026");
  await pg.goto(B + "/#/daily-reports", { waitUntil: "domcontentloaded" }); await pg.waitForTimeout(2200);
  let T = await pg.evaluate(() => document.body.innerText || "");
  K("U1 面板打开（标题在位、无「简报任务读取失败」红条）", /司机安全简报与目标跟进/.test(T) && !/简报任务读取失败/.test(T));
  K("U2 车辆下拉=真实车辆标签", /车辆1/.test(T) && /车辆3/.test(T), (T.match(/车辆\d+/g) || []).slice(0, 4).join(","));
  K("U3 任务统计行渲染", /任务 \d+ · 已完成 \d+/.test(T));
  const sched = await pg.evaluate(() => { const el = document.querySelector("input[type=time]"); return el ? el.value : "NOMOUNT"; });
  const saveBtn = await pg.locator(".report-schedule button").filter({ hasText: "保存" }).count().catch(() => 0);
  K("U4 settings 契约（time=07:00 且宿主只读，无保存按钮假象）", sched === "07:00" && saveBtn === 0, "value=" + sched);
  await pg.locator("details.report-jobs summary").click().catch(() => {}); await pg.waitForTimeout(500);
  T = await pg.evaluate(() => document.body.innerText || "");
  K("U5 任务明细含车辆与状态", /车辆1 · 已完成/.test(T) && /生成尝试/.test(T));
  await pg.locator("section.panel", { hasText: "司机目标求助与跟进" }).locator("textarea").first().fill("已协调设备检测");
  await pg.locator("button", { hasText: "保存并回复司机" }).first().click(); await pg.waitForTimeout(1500);
  T = await pg.evaluate(() => document.body.innerText || "");
  K("U6 处置成功：卡片转「已跟进」+意见可见", /已跟进/.test(T) && /已协调设备检测/.test(T) && !/处理未完成/.test(T));
  const notif = db.tables.notification_events.filter(n => n.type === "driver_goal_answered");
  K("U7 处置产生司机通知（幂等键在位）", notif.length === 1 && notif[0].target_user_id === "test-driver" && String(notif[0].idempotency_key || "").startsWith("goal-handled:41:"));
  await pg.locator(".report-job-row button", { hasText: "查看简报" }).first().click({ timeout: 5000 }).catch(e => console.log("detail-click", String(e).slice(0, 80)));
  await pg.waitForTimeout(1500);
  T = await pg.evaluate(() => document.body.innerText || "");
  K("U8 简报预览区渲染（staff-report-preview 在位、无「已不可用」报错）", await pg.locator(".staff-report-preview").count() > 0 && !/简报不在授权范围内或已不可用/.test(T));
  K("U9 预览显示来源车辆与 AI 解读入口", /让 AI 解读/.test(T), (T.match(/车辆\d 简报/) || [""])[0]);
  await pg.screenshot({ path: path.join(SHOT, "r51-01-admin-panel.png") });
  const adminHard = errs.filter(e => !ignorable(e));
  K("U10 管理员页无未预期异常", adminHard.filter(e => /daily|goal|report/i.test(e)).length === 0, adminHard.slice(0, 5).join("; "));
  const o = await session("preview_officer", "PreviewOfficer2026");
  await o.pg.goto(B + "/#/daily-reports", { waitUntil: "domcontentloaded" }); await o.pg.waitForTimeout(2000);
  const OT = await o.pg.evaluate(() => document.body.innerText || "");
  K("U11 安全员可打开面板（本车队范围）", /司机安全简报与目标跟进/.test(OT) && !/简报任务读取失败/.test(OT) && !/加载失败/.test(OT));
  const offHard = o.errs.filter(e => !ignorable(e));
  K("U12 安全员页无未预期异常", offHard.filter(e => /daily|goal|report/i.test(e)).length === 0, offHard.slice(0, 5).join("; "));
  await o.pg.screenshot({ path: path.join(SHOT, "r51-02-panel-officer.png") });
  const runErr = /daily|admin-reports/.test(String(out)) && (out.match(/DB_DETAIL[^\n]{0,80}/g) || []).join(" | ");
  K("U13 服务端无简报相关 DB 失败日志", !runErr, runErr || "");
  await br.close(); child.kill(); await db.close();
  console.log(`\nR51 UI RESULT pass=${pass} fail=${fail} shots=${SHOT}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("RUNNER ERR", String(e).slice(0, 300)); process.exit(2); });
