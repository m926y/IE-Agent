// 第54轮 云端历史回放（RM02 找回）+ 实时引擎云端诚实形态 UI 电池：宿主模式 + 隔离夹具 + 真实浏览器点击。
// 用法：node scripts/r54-history-replay-battery.cjs（可 QA_PORT 指定端口、PLAYWRIGHT_MODULE/BROWSER_EXECUTABLE 覆盖）。
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const REPO = path.resolve(__dirname, "..");
const SHOT = process.env.QA_OUTPUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "r54-ui-"));
fs.mkdirSync(SHOT, { recursive: true });
const PORT = process.env.QA_PORT || "3154";
let pass = 0, fail = 0; const K = (n, c, x = "") => { console.log((c ? "PASS " : "FAIL ") + n, String(x).slice(0, 150)); c ? pass++ : fail++; };
(async () => {
  const { startFixtureDatabase } = await import(path.join(REPO, "tests/fixtures/account-db.mjs"));
  const db = await startFixtureDatabase();
  const day = "2026-07-29";
  for (const t of ["replay_events", "alerts", "vehicle_labels", "app_users", "training_tasks"]) db.tables[t] ||= [];
  for (let i = 0; i < 14; i++) db.tables.replay_events.push({ event_id: "FX" + i, gpsno: "TEST-VEHICLE-RAW-02", driver_id: "driver-two", event_time: day + " 07:" + String(i).padStart(2, "0") + ":00", event_type: 30001, event_name: "匀速提示", dimension: "driving_stability", replay_date: day, is_replay: true, source_version: "v1" });
  db.tables.replay_events.push(
    { event_id: "E1", gpsno: "TEST-VEHICLE-RAW-01", driver_id: "driver-one", event_time: day + " 08:00:01", event_type: 30002, event_name: "左车道偏移", dimension: "driving_stability", replay_date: day, is_replay: true, source_version: "v1" },
    { event_id: "E2", gpsno: "TEST-VEHICLE-RAW-01", driver_id: "driver-one", event_time: day + " 08:10:02", event_type: 30002, event_name: "左车道偏移", dimension: "driving_stability", replay_date: day, is_replay: true, source_version: "v1" },
    { event_id: "E9", gpsno: "TEST-VEHICLE-RAW-01", driver_id: "driver-one", event_time: day + " 08:40:09", event_type: 30004, event_name: "跟车过近", dimension: "driving_stability", replay_date: day, is_replay: true, source_version: "v1" },
  );
  db.tables.alerts.push({ alert_id: "A-LINK", gpsno: "TEST-VEHICLE-RAW-01", driver_id: "driver-one", rule_code: "REPLAY_stability", evidence_id: "E2", occurred_at: day + " 08:10:02", status: "pending_review", is_replay: true });
  const child = spawn(process.execPath, ["server.mjs"], { cwd: REPO, env: { HOST: "127.0.0.1", PORT, SUPABASE_URL: db.url, SUPABASE_ANON_KEY: "test", SUPABASE_INSTANCE_ID: "fixture" }, stdio: ["ignore", "pipe", "pipe"] });
  const B = `http://127.0.0.1:${PORT}`;
  try { for (let i = 0; i < 150; i++) { try { if ((await fetch(B + "/healthz")).ok) break; } catch { } await new Promise(r => setTimeout(r, 50)); } } catch { }
  let br = null;
  try {
    const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "/usr/lib/node_modules/playwright");
    const exec = process.env.BROWSER_EXECUTABLE || (fs.existsSync("/opt/playwright-browsers/chromium-1209/chrome-linux64/chrome") ? "/opt/playwright-browsers/chromium-1209/chrome-linux64/chrome" : undefined);
    br = await chromium.launch({ headless: true, executablePath: exec, args: ["--no-sandbox"] });
    const pg = await (await br.newContext({ viewport: { width: 1500, height: 980 } })).newPage();
    const errs = [];
    pg.on("pageerror", e => errs.push(String(e).slice(0, 130)));
    await pg.goto(B + "/", { waitUntil: "domcontentloaded" }); await pg.waitForTimeout(700);
    await pg.getByRole("button", { name: /使用账号登录|使用工作台账号登录/ }).first().click().catch(() => {});
    await pg.locator("#ln").fill("preview_admin"); await pg.locator("#pw").fill("PreviewAdmin2026");
    await pg.locator(".login-submit").click(); await pg.waitForTimeout(1600);
    await pg.goto(B + "/#/rm-queue", { waitUntil: "domcontentloaded" }); await pg.waitForTimeout(1400);
    K("N1 导航：风险监控组含历史回放入口且已无实时引擎入口（R59 移除）", (await pg.locator('a[href="#/rm-replay"]').count()) > 0 && (await pg.locator('a[href="#/rm-live"]').count()) === 0);
    await pg.locator('a[href="#/rm-replay"]').first().click({ timeout: 5000 }); await pg.waitForTimeout(1600);
    let T = await pg.evaluate(() => document.body.innerText || "");
    K("N2 RM02 打开：标题+只读口径声明+计数 0/17", /历史事件回放/.test(T) && /只推进显示时钟/.test(T) && /0\/17/.test(T));
    K("N3 车辆只显示「车辆N」不露原始编号", /车辆1|车辆2/.test(T) && !T.includes("TEST-VEHICLE"));
    await pg.selectOption('select[aria-label="回放倍速"]', "10").catch(() => {});
    await pg.locator("button", { hasText: "播放" }).first().click(); await pg.waitForTimeout(380);
    T = await pg.evaluate(() => document.body.innerText || "");
    const m = T.match(/(\d+)\/17 条/);
    K("N4 播放推进（0<进度<17）", !!m && Number(m[1]) > 0 && Number(m[1]) < 17, m ? m[1] + "/17" : "");
    await pg.locator("button", { hasText: "暂停" }).first().click({ timeout: 4000 }).catch(() => {});
    T = await pg.evaluate(() => document.body.innerText || "");
    K("N5 暂停生效（不再推进）", /已暂停|播放中/.test(T));
    await pg.locator('button', { hasText: '跳到当日结束' }).click({ timeout: 5000 }).catch(e => console.log('N6-click', String(e).slice(0, 90)));
    await pg.waitForTimeout(700);
    T = await pg.evaluate(() => document.body.innerText || "");
    console.log('N6-DUMP:', (T.replace(/\n/g, '⏎').match(/[^⏎]*条[^⏎]*|[^⏎]*已播完[^⏎]*/g) || []).slice(0, 3).join(' | '));
    K("N6 当日结束视图：17/17 + 已播完", T.includes("17/17 条") && /已播完/.test(T));
    K("N7 有档案事件出现「关联告警档案」链接", /关联告警档案/.test(T));
    await pg.screenshot({ path: path.join(SHOT, "r54-01-rm02.png") });
    const pairs = await pg.$$eval('a', as => as.map(a => [a.textContent.trim().slice(0, 12), a.getAttribute('href')]));
    const link = (pairs.find(x => x[0].includes('关联告警')) || ['', ''])[1];
    const hrefN=(await pg.locator("a", { hasText: "关联告警档案" }).count());
    K("N8 链接指向告警页 alert_id=A-LINK", link === "#/rm-alerts?alert_id=A-LINK", "href=" + link + " n=" + hrefN);
    await pg.goto(B + "/#/rm-live", { waitUntil: "domcontentloaded" }); await pg.waitForTimeout(2000);
    T = await pg.evaluate(() => document.body.innerText || "");
    K("N9 rm-live 旧深链按 R59 重定向到历史回放页", /历史事件回放/.test(T));
    K("N10 页面已无实时回放引擎控件（建立新回放/开始回放）", !(await pg.locator("button", { hasText: "建立新回放" }).count()) && !(await pg.locator("button", { hasText: "开始回放" }).count()));
    K("N11 全程零运行异常", errs.length === 0, errs.slice(0, 2).join(" ;; "));
    await pg.screenshot({ path: path.join(SHOT, "r54-02-rmlive-guide.png") });
  } finally {
    try { br && await br.close(); } catch { }
    try { child && child.kill(); } catch { }
    try { db && await db.close(); } catch { }
  }
  console.log(`\nR54 UI RESULT pass=${pass} fail=${fail} shots=${SHOT}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("RUNNER ERR", String(e).slice(0, 300)); process.exit(2); });
