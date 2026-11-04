// 第53轮 云端功能面巡检：宿主模式 + 隔离夹具 + 真实浏览器，对管理员全部路由与司机端全部 tab
// 逐页采集——页面是否出内容、控制台/运行时异常、失败接口，自动分类 OK/降级(诚实提示)/异常。
// 输出 JSON 巡检矩阵（QA_OUTPUT_DIR 或临时目录），供发布报告与后续修复排期使用。
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const REPO = path.resolve(__dirname, "..");
const OUT = process.env.QA_OUTPUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "r53-audit-"));
const STAFF_ROUTES = ["overview", "handover", "daily-reports", "ev-fleet", "ev-actions", "ev-week", "ev-driver", "ev-review", "ev-root", "rm-queue", "rm-replay", "rm-alerts", "tr-ledger", "tr-courses", "tr-create", "tr-offline", "data-center", "ai-preplan", "sm-accounts", "sm-bindings", "sm-config", "sm-audit", "sm-knowledge", "sm-drafts", "account-profile"];
(async () => {
  const { startFixtureDatabase, passwordHash } = await import(path.join(REPO, "tests/fixtures/account-db.mjs"));
  const bjToday = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const db = await startFixtureDatabase();
  for (const t0 of ["handover_settings", "handover_reports", "handover_notes", "handover_note_deletions", "notification_events", "training_tasks", "review_requests", "interventions", "alerts", "risk_cases", "risk_replay_sessions", "risk_action_followups", "score_snapshots", "audit_logs", "action_center_reads", "action_center_hidden", "driver_safety_goals", "daily_safety_reports", "daily_report_jobs", "training_courses", "evaluation_actions", "evaluation_rules", "evaluation_rule_drafts", "knowledge_articles", "operation_config", "user_bindings", "driver_profiles", "import_runs", "chat_messages"]) db.tables[t0] ||= [];
  db.tables.app_users.push(
    { user_id: "test-admin2", username: "preview_admin2", display_name: "管理员乙", role: "safety_admin", fleet_scope: "*", account_status: "active", password_hash: passwordHash("PreviewAdmin2026"), must_change_password: false, avatar_url: null },
    { user_id: "test-ofc1", username: "preview_ofc1", display_name: "安全员甲", role: "safety_officer", fleet_scope: "fleet-one", account_status: "active", password_hash: passwordHash("PreviewOfficer2026"), must_change_password: false, avatar_url: null },
  );
  db.tables.alerts.push({ alert_id: "A-SEED", driver_id: "driver-one", gpsno: "TEST-VEHICLE-RAW-01", rule_code: "R1", status: "pending_review", occurred_at: new Date().toISOString(), is_replay: false, updated_at: new Date().toISOString(), due_at: null });
  db.tables.score_snapshots.push({ score_id: "S1", driver_id: "driver-one", gpsno: "TEST-VEHICLE-RAW-01", as_of_date: "2026-06-30", safety_score: 88.5, risk_level: "C", confidence_level: "high", score_status: "scored", score_method: "v1", source_version: "sv1", window_start: "2026-06-01", recommended_action: "培训", primary_risk_dimension: "注意力" });
  db.tables.score_history.push({ score_id: "H1", driver_id: "driver-one", gpsno: "TEST-VEHICLE-RAW-01", as_of_date: "2026-06-30", safety_score: 88.5, risk_level: "C", confidence_level: "high", score_status: "scored", score_method: "v1", source_version: "sv1", window_start: "2026-06-01" });
  db.tables.training_courses.push({ course_id: "c1", title: "防御性驾驶", dimension: "注意力", content_status: "approved", version_no: 1, source_version: "sv1", updated_at: "2026-08-01T00:00:00Z" });
  db.tables.daily_report_jobs.push({ id: 1, driver_id: "driver-one", report_date: bjToday, status: "succeeded", attempts: 1, started_at: "2026-01-01T07:00:00Z", finished_at: "2026-01-01T07:01:00Z", error_message: null });
  const PORT = "3153";
  const child = spawn(process.execPath, ["server.mjs"], { cwd: REPO, env: { HOST: "127.0.0.1", PORT, SUPABASE_URL: db.url, SUPABASE_ANON_KEY: "test", SUPABASE_INSTANCE_ID: "fixture" }, stdio: ["ignore", "pipe", "pipe"] });
  let serverLog = ""; child.stderr.on("data", x => serverLog += x);
  const B = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 150; i++) { try { if ((await fetch(B + "/healthz")).ok) break; } catch { } await new Promise(r => setTimeout(r, 50)); }
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "/usr/lib/node_modules/playwright");
  const exec = process.env.BROWSER_EXECUTABLE || (fs.existsSync("/opt/playwright-browsers/chromium-1209/chrome-linux64/chrome") ? "/opt/playwright-browsers/chromium-1209/chrome-linux64/chrome" : undefined);
  const br = await chromium.launch({ headless: true, executablePath: exec, args: ["--no-sandbox"] });
  const noise = /(favicon|React DevTools)/;
  async function pageFor(user, pw) {
    const pg = await (await br.newContext({ viewport: { width: 1500, height: 980 } })).newPage();
    await pg.goto(B + "/", { waitUntil: "domcontentloaded" }); await pg.waitForTimeout(700);
    await pg.getByRole("button", { name: /使用账号登录|使用工作台账号登录/ }).first().click().catch(() => {});
    await pg.locator("#ln").fill(user); await pg.locator("#pw").fill(pw);
    await pg.locator(".login-submit").click(); await pg.waitForTimeout(1600);
    return pg;
  }
  async function visit(pg, hash, label, sink) {
    const pe = [], http = [];
    const onPE = e => { if (!noise.test(String(e))) pe.push(String(e).slice(0, 120)); };
    const onRes = res => { if (res.status() >= 400) http.push(res.status() + " " + new URL(res.url()).pathname); };
    pg.on("pageerror", onPE); pg.on("response", onRes);
    await pg.goto(B + "/" + hash, { waitUntil: "domcontentloaded" }); await pg.waitForTimeout(1500);
    const text = await pg.evaluate(() => document.body.innerText || "");
    pg.off("pageerror", onPE); pg.off("response", onRes);
    const degraded = /需要启动本地完整数据|仅本地完整数据|本地完整数据服务|暂不支持云端|仅本地工作台/.test(text);
    const blank = text.length < 260;
    let cls = "OK";
    if (pe.length) cls = "CRASH"; else if (blank) cls = "EMPTY"; else if (degraded) cls = "DEGRADED"; else if (http.length) cls = "API_ERR";
    sink.push({ page: label, cls, chars: text.length, errors: [...new Set(pe)].slice(0, 2), apiErr: [...new Set(http)].slice(0, 4) });
    console.log(`${cls.padEnd(8)} ${label}  ${text.length} chars  ${[...new Set(pe.concat(http))].slice(0, 2).join(" | ").slice(0, 120)}`);
  }
  const staff = await pageFor("preview_admin", "PreviewAdmin2026");
  const rowsStaff = [];
  for (const k of STAFF_ROUTES) await visit(staff, "#/" + k, "staff/" + k, rowsStaff);
  await staff.screenshot({ path: path.join(OUT, "r53-staff-overview.png") }).catch(() => {});
  const driverPage = await pageFor("preview_driver", "PreviewDriver2026");
  const tabLabels = await driverPage.evaluate(() => Array.from(document.querySelectorAll(".tabbar button")).map(b => b.textContent.trim().slice(0, 12)));
  const rowsDriver = [];
  for (let i = 0; i < tabLabels.length; i++) {
    const dp = await pageFor("preview_driver", "PreviewDriver2026"); // 每 tab 新 context，避免 handler 串页
    const pe = []; dp.on("pageerror", e => { if (!noise.test(String(e))) pe.push(String(e).slice(0, 90)); });
    const httpErr = []; dp.on("response", res => { if (res.status() >= 400) httpErr.push(res.status() + " " + new URL(res.url()).pathname); });
    await dp.locator(".tabbar button").nth(i).click().catch(() => {});
    await dp.waitForTimeout(1300);
    const T = await dp.evaluate(() => document.body.innerText || "");
    rowsDriver.push({ page: "driver/" + tabLabels[i], chars: T.length, cls: pe.length ? "CRASH" : httpErr.some(x => !/chat\/contacts/.test(x)) ? "API_ERR" : "OK", err: [...new Set(pe)].slice(0, 2), apiErr: [...new Set(httpErr)].slice(0, 3) });
    console.log(`${(pe.length ? "CRASH" : "OK").padEnd(8)} driver/${tabLabels[i]}  ${T.length} chars ${[...new Set(pe.concat(httpErr))].slice(0, 1).join("")}`);
    await dp.context().close().catch(() => {});
  }
  await driverPage.context().close().catch(() => {});
  const officer = await pageFor("preview_ofc1", "PreviewOfficer2026");
  const rowsOfficer = [];
  for (const k of ["overview", "handover", "daily-reports", "ev-fleet", "rm-queue", "tr-ledger", "sm-accounts"]) await visit(officer, "#/" + k, "officer/" + k, rowsOfficer);
  const matrix = { generated: new Date().toISOString(), mode: "hosted-fixture", staff: rowsStaff, officer: rowsOfficer, driver: rowsDriver };
  fs.writeFileSync(path.join(OUT, "r53-feature-audit.json"), JSON.stringify(matrix, null, 1));
  const bad = [...rowsStaff, ...rowsOfficer, ...rowsDriver].filter(r => r.cls === "CRASH" || (r.cls === "API_ERR" && !/chat\/contacts|risk\/live|notifications/.test((r.apiErr || []).join(""))));
  const degradedList = [...rowsStaff, ...rowsOfficer].filter(r => r.cls === "DEGRADED").map(r => r.page);
  fs.writeFileSync(path.join(OUT, "r53-audit-summary.json"), JSON.stringify({ bad, degraded: degradedList, server503: [...new Set(String(serverLog).match(/503 [a-z_]+/g) || [])] }, null, 1));
  await br.close(); child.kill(); await db.close();
  console.log("\nAUDIT MATRIX", path.join(OUT, "r53-feature-audit.json"));
  console.log("BAD:", bad.length, "DEGRADED:", degradedList.join(", "), "| server 503 codes:", JSON.stringify([...new Set(String(serverLog).match(/category=db_error|daily_tick_error|handover_tick_error/g) || [])]));
  process.exit(0);
})().catch(e => { console.error("RUNNER ERR", String(e).slice(0, 300)); process.exit(2); });
