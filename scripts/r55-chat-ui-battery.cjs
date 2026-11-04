// 第55轮 消息服务云端化 UI 电池：宿主夹具环境 + 双角色真实浏览器收发消息。
// 验证：顶栏消息入口不再"连接异常"；联系人范围正确；发送/接收/未读徽标/已读回执全链路可用。
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const REPO = path.resolve(__dirname, "..");
const SHOT = process.env.QA_OUTPUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "r55-ui-"));
fs.mkdirSync(SHOT, { recursive: true });
const PORT = process.env.QA_PORT || "3155";
let pass = 0, fail = 0; const K = (n, c, x = "") => { console.log((c ? "PASS " : "FAIL ") + n, String(x).slice(0, 150)); c ? pass++ : fail++; };
(async () => {
  const { startFixtureDatabase, passwordHash } = await import(path.join(REPO, "tests/fixtures/account-db.mjs"));
  const db = await startFixtureDatabase();
  for (const t of ["chat_messages", "chat_business_refs", "training_tasks", "audit_logs", "notification_events"]) db.tables[t] ||= [];
  db.tables.app_users.push({ user_id: "test-ofc1", username: "preview_ofc1", display_name: "安全员甲", role: "safety_officer", fleet_scope: "fleet-one", account_status: "active", password_hash: passwordHash("PreviewOfficer2026"), must_change_password: false, avatar_url: null });
  const child = spawn(process.execPath, ["server.mjs"], { cwd: REPO, env: { HOST: "127.0.0.1", PORT, SUPABASE_URL: db.url, SUPABASE_ANON_KEY: "test", SUPABASE_INSTANCE_ID: "fixture" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stderr.on("data", x => log += x);
  const B = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 150; i++) { try { if ((await fetch(B + "/healthz")).ok) break; } catch { } await new Promise(r => setTimeout(r, 50)); }
  let br = null;
  try {
    const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "/usr/lib/node_modules/playwright");
    const exec = process.env.BROWSER_EXECUTABLE || (fs.existsSync("/opt/playwright-browsers/chromium-1209/chrome-linux64/chrome") ? "/opt/playwright-browsers/chromium-1209/chrome-linux64/chrome" : undefined);
    br = await chromium.launch({ headless: true, executablePath: exec, args: ["--no-sandbox"] });
    async function session(u, p) {
      const pg = await (await br.newContext({ viewport: { width: 1500, height: 980 } })).newPage();
      const errs = [];
      pg.on("pageerror", e => errs.push(String(e).slice(0, 120)));
      pg.on("response", res => { if (res.status() >= 400 && /chat/.test(res.url())) errs.push("http:" + res.status()); });
      await pg.goto(B + "/", { waitUntil: "domcontentloaded" }); await pg.waitForTimeout(700);
      await pg.getByRole("button", { name: /使用账号登录|使用工作台账号登录/ }).first().click().catch(() => {});
      await pg.locator("#ln").fill(u); await pg.locator("#pw").fill(p);
      await pg.locator(".login-submit").click(); await pg.waitForTimeout(1700);
      return { pg, errs };
    }
    const A = await session("preview_admin", "PreviewAdmin2026");
    let T = await A.pg.evaluate(() => document.body.innerText || "");
    K("C1 顶栏消息入口无「连接异常」", /消息/.test(T) && !/连接异常/.test(T));
    await A.pg.locator("button.message-entry").click(); await A.pg.waitForTimeout(900);
    T = await A.pg.evaluate(() => document.body.innerText || "");
    K("C2 联系人列表含司机（车辆标签）", /司机/.test(T) && /车辆1/.test(T) && /开始交流|暂无聊天记录/.test(T), "");
    await A.pg.locator('.message-layout nav button', { hasText: '司机' }).first().click(); await A.pg.waitForTimeout(400);
    await A.pg.locator('textarea[aria-label="聊天消息"]').fill("请确认明日早班状态，收到请回复。");
    await A.pg.locator("button", { hasText: "发送消息" }).click(); await A.pg.waitForTimeout(900);
    T = await A.pg.evaluate(() => document.body.innerText || "");
    K("C3 管理员发送成功上屏（未读态）", /请确认明日早班状态/.test(T) && /未读/.test(T));
    await A.pg.screenshot({ path: path.join(SHOT, "r55-01-sent.png") });
    const D = await session("preview_driver", "PreviewDriver2026");
    await D.pg.locator(".tabbar button", { hasText: "通知" }).first().click(); await D.pg.waitForTimeout(1600);
    let DT = await D.pg.evaluate(() => document.body.innerText || "");
    K("C4 司机端通知/联系人正常（司机可见对方消息摘要，无异常文案）", !/连接异常|通知读取失败/.test(DT) && /请确认明日早班状态/.test(DT), (DT.match(/[^\n]*请确认[^\n]*/) || [""])[0].slice(0, 60));
    await D.pg.locator(".driver-contact-list button", { hasText: "安全员" }).first().click(); await D.pg.waitForTimeout(1000);
    if (!(await D.pg.locator(".message-window").count())) { await D.pg.locator(".driver-contact-list button").nth(1).click().catch(() => {}); await D.pg.waitForTimeout(800); }
    await D.pg.waitForTimeout(1200);
    DT = await D.pg.evaluate(() => document.body.innerText || "");
    K("C5 司机收到并看到对方消息", /请确认明日早班状态/.test(DT), "");
    await D.pg.locator('textarea[aria-label="聊天消息"]').fill("收到，六点前反馈设备检查结果。");
    await D.pg.locator("button", { hasText: "发送消息" }).click(); await D.pg.waitForTimeout(900);
    DT = await D.pg.evaluate(() => document.body.innerText || "");
    K("C6 司机回复上屏", /收到，六点前反馈/.test(DT));
    await D.pg.screenshot({ path: path.join(SHOT, "r55-02-driver.png") });
    await A.pg.waitForTimeout(2200); // 管理员端 1s 轮询拉取回复
    T = await A.pg.evaluate(() => document.body.innerText || "");
    K("C7 管理员实时收到司机回复", /收到，六点前反馈/.test(T));
    K("C8 管理员自己消息转「已读」", /已读/.test(T) && !/设备检查结果。 · 未读/.test(T), (T.match(/收到，六点前反馈[^⏎]*/) || [""])[0]);
    const o1 = await session("preview_ofc1", "PreviewOfficer2026");
    await o1.pg.locator("button.message-entry").click(); await o1.pg.waitForTimeout(900);
    const OT = await o1.pg.evaluate(() => document.body.innerText || "");
    K("C9 车队安全员只见授权司机（跨车队司机消息不可见）", /车辆1|司机/.test(OT) && !/设备检查结果/.test(OT));
    const allErrs = A.errs.concat(D.errs, o1.errs).filter(e => /http:|Error|error|异常/.test(e) && !/favicon|401/.test(e));
    K("C10 全程零异常：无 chat 4xx/5xx、无运行时错误", !/punish/.test(log) && !/http:4\d\d/.test(allErrs.join(" ")) && !/http:5\d\d/.test(allErrs.join(" ")) && allErrs.filter(e => !/^http:/.test(e)).length === 0, allErrs.slice(0, 2).join(" ;; "));
    K("C11 服务端无 chat 失败日志", !/chat_service_failed|punish/.test(log), (log.match(/DB_DETAIL[^\n]{0,50}/g) || []).slice(0, 1).join(""));
  } finally {
    try { br && await br.close(); } catch { }
    try { child && child.kill(); } catch { }
    try { await db.close(); } catch { }
  }
  console.log(`\nR55 UI RESULT pass=${pass} fail=${fail} shots=${SHOT}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("RUNNER ERR", String(e).slice(0, 300)); process.exit(2); });
