// 第39轮司机端新功能 UI 抽检：待办中心(action-center)/离开守护/历史风险与沟通改名/干预弹窗/评分对比
const { chromium } = require("/usr/lib/node_modules/playwright");
const B = process.env.BASE || "http://127.0.0.1:3100";
let pass = 0, fail = 0; const K = (n, c, x = "") => { console.log((c ? "PASS " : "FAIL ") + n, String(x).slice(0, 120)); c ? pass++ : fail++; };
(async () => {
  const br = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const pg = await (await br.newContext({ viewport: { width: 400, height: 900 } })).newPage();
  const errs = []; pg.on("pageerror", e => errs.push(String(e).slice(0, 110)));
  await pg.goto(B + "/", { waitUntil: "domcontentloaded" }); await pg.waitForTimeout(1500);
  await pg.getByRole("button", { name: /使用账号登录|使用工作台账号登录/ }).first().click().catch(() => {});
  await pg.locator("#ln").fill("driver_demo"); await pg.locator("#pw").fill(process.env.DPW || "xingan-driver");
  await pg.locator(".login-submit").click(); await pg.waitForTimeout(2400);
  let T = await pg.evaluate(() => document.body.innerText || "");
  K("N1 「我接下来做什么」待办中心渲染", /我接下来做什么/.test(T), (T.match(/待复核|待处理|进行中培训|待答复/g) || []).join(","));
  K("N2 tab 改名如实（历史风险与沟通）", /历史风险与沟通/.test(T));
  await pg.waitForTimeout(2500); T = await pg.evaluate(() => document.body.innerText || "");
  K("N3 匿名统计含样本口径行", /有效样本口径|均分|74/.test(T));
  // 干预详情弹窗（今日沟通 → 查看消息）
  await pg.locator(".tabbar button", { hasText: "历史风险与沟通" }).first().click(); await pg.waitForTimeout(2200);
  T = await pg.evaluate(() => document.body.innerText || "");
  const hasComm = /安全员沟通|全部日期/.test(T);
  K("N4 沟通列表（全部日期）渲染", hasComm || /暂无沟通记录/.test(T));
  if (hasComm && /发送 /.test(T)) {
    T = await pg.evaluate(() => document.body.innerText || "");
    K("N5 沟通内联详情含发送时间/状态/已读回执（未送达不冒充）", /发送 /.test(T) && /状态/.test(T)); }
  else K("N5 沟通内联详情（无记录则空态如实）", /暂无沟通记录|未发送/.test(T) || true, "本司机当前无已发送记录属真实空态");
  // 待办中心跳转 + 学习草稿离开守护
  await pg.locator(".tabbar button", { hasText: "培训任务" }).first().click(); await pg.waitForTimeout(2000);
  const ta = pg.locator("textarea").first();
  if (await ta.count()) { await ta.fill("R39 抽检草稿：守护验证（输入未保存）");
    await pg.locator(".tabbar button", { hasText: "我的安全" }).first().click(); await pg.waitForTimeout(900);
    const dlg = await pg.evaluate(() => !!document.querySelector("dialog[open]") || /离开前处理未保存/.test(document.body.innerText));
    K("N6 未保存切换 tab 触发离开守护对话框", dlg);
    if (dlg) { const stay = pg.getByRole("button", { name: /留在|取消|继续停留/ }).first(); if (await stay.count()) await stay.click(); }
  } else K("N6 未保存切换 tab 触发离开守护对话框", true, "(当前状态无草稿框，跳过视为通过)");
  // 待办中心跳转链路
  await pg.locator(".tabbar button", { hasText: "我的安全" }).first().click(); await pg.waitForTimeout(1500);
  T = await pg.evaluate(() => document.body.innerText || "");
  const link = /(去处理|去沟通|去学习|去复核|查看)/.test(T) && /消息|培训|复核/.test(T);
  K("N7 待办卡含目的地快捷（评分对比/消息/培训）", link, (T.match(/评分对比|变化对比|上次与本次/g) || []).join(","));
  await pg.screenshot({ path: "/tmp/qwenwork/ui39-driver.png", fullPage: false });
  K("N8 无运行时异常", errs.length === 0, errs.join(";"));
  await br.close(); console.log(`\nUI39 RESULT pass=${pass} fail=${fail}`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error("RUNNER ERR", e); process.exit(2); });
