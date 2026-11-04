// 第40轮 简报 UI 冒烟（宿主）：司机简报页 + 管理员面板
const fs = require("node:fs");
const kv = Object.fromEntries(fs.readFileSync("/tmp/qwenwork/rt/app.env", "utf8").split("\n").filter(Boolean).map(l => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
const B = process.env.BASE || "http://127.0.0.1:3100";
const SHOT = "/workspace/2e745c89-a0e7-4322-81e0-175539140803/work/output/screenshots";
let pass = 0, fail = 0; const K = (n, c, x = "") => { console.log((c ? "PASS " : "FAIL ") + n, String(x).slice(0, 140)); c ? pass++ : fail++; };
(async () => {
  const { chromium } = require("/usr/lib/node_modules/playwright");
  const br = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  // 司机端
  const dp = await (await br.newContext({ viewport: { width: 400, height: 900 } })).newPage();
  const derrs = []; dp.on("pageerror", e => derrs.push(String(e).slice(0, 110)));
  await dp.goto(B + "/", { waitUntil: "domcontentloaded" }); await dp.waitForTimeout(1500);
  await dp.getByRole("button", { name: /使用账号登录|使用工作台账号登录/ }).first().click().catch(() => {});
  await dp.locator("#ln").fill("driver_demo"); await dp.locator("#pw").fill(kv.DRIVER_PW);
  await dp.locator(".login-submit").click(); await dp.waitForTimeout(2400);
  let T = await dp.evaluate(() => document.body.innerText || "");
  K("S1 我的安全页含「今日安全简报」入口", /今日安全简报/.test(T) && /查看简报与安全动态/.test(T));
  K("S2 tabbar 出现安全简报（含未读徽标）", /安全简报/.test(T), (T.match(/安全简报( · \d+)?/) || [""])[0]);
  await dp.locator(".tabbar button", { hasText: "安全简报" }).first().click(); await dp.waitForTimeout(2500);
  T = await dp.evaluate(() => document.body.innerText || "");
  K("S3 简报页=AI 问候+真值分+车队对比+AI 标注", /晚上好|早上好|中午好|下午好/.test(T) && /28\.1\d*|88\.1\d*|92\.\d/.test(T) && /车队平均评分/.test(T) && /AI 生成叙述|规则模板叙述/.test(T), (T.match(/28\.1\d*/) || [""])[0]);
  const tt = T.replace(/不是实时监测|非实时监测|不展示实时/g, "");
  K("S4 非实时措辞（先剔除合法否定声明，再断言无肯定违禁词）", !/实时监测|实时风险警报|刚刚发生|今天发生了/.test(tt) && /不是实时监测/.test(T));
  await dp.screenshot({ path: SHOT + "/ui40-01-report.png" });
  await dp.locator(".dr-tabs button", { hasText: "安全动态" }).first().click(); await dp.waitForTimeout(900);
  T = await dp.evaluate(() => document.body.innerText || "");
  K("S5 资讯流卡片来自同一报告", /安全动态/.test(T) && (/查看简报与证据/.test(T) || /没有可引用的个性化动态/.test(T)));
  await dp.locator(".dr-tabs button", { hasText: "历史简报" }).first().click(); await dp.waitForTimeout(900);
  T = await dp.evaluate(() => document.body.innerText || "");
  K("S6 历史列表有当日版本", /版本 1/.test(T) || /暂无已发布简报/.test(T));
  await dp.locator(".dr-tabs button", { hasText: "今日简报" }).first().click(); await dp.waitForTimeout(1200);
  K("S7b 趋势双线图渲染（SVG 路径>0）", (await dp.locator(".dr-chart svg path").count()) >= 1, "paths=" + (await dp.locator(".dr-chart svg path").count()));
  const ctaCount = await dp.locator(".dr-cta").count();
  const hasCta = ctaCount === 1;
  K("S7c 今日改善目标+我已阅读CTA 在位", hasCta);
  if (hasCta) { await dp.locator(".dr-cta").click(); await dp.waitForTimeout(1400); const T3 = await dp.evaluate(() => document.body.innerText || ""); K("S7d 已阅读态生效", /今日建议已阅读/.test(T3)); }
  K("S7 司机端无运行时异常", derrs.length === 0, derrs.join(";"));
  // 管理员端
  const pg = await (await br.newContext({ viewport: { width: 1500, height: 980 } })).newPage();
  const perrs = []; pg.on("pageerror", e => perrs.push(String(e).slice(0, 110)));
  await pg.goto(B + "/", { waitUntil: "networkidle" });
  await pg.getByRole("button", { name: /使用账号登录|使用工作台账号登录/ }).first().click().catch(() => {}); await pg.waitForTimeout(300);
  await pg.locator("#ln").fill("safety_admin"); await pg.locator("#pw").fill(kv.ADMIN_PW);
  await pg.locator(".login-submit").click(); await pg.waitForTimeout(2200);
  await pg.goto(B + "/#/daily-reports", { waitUntil: "domcontentloaded" }); await pg.waitForTimeout(2000);
  T = await pg.evaluate(() => document.body.innerText || "");
  K("S8 管理员面板呈现（手动生成+任务区，宿主可用）", /每日安全简报/.test(T) && /生成并发布/.test(T) && !/仅本地工作台支持/.test(T));
  K("S9 任务统计可见", /自动任务/.test(T) && /总数/.test(T));
  await pg.screenshot({ path: SHOT + "/ui40-02-admin.png" });
  K("S10 管理员无运行时异常", perrs.length === 0, perrs.join(";"));
  await br.close();
  console.log(`\nUI40 RESULT pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("RUNNER ERR", e); process.exit(2); });
