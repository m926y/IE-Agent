// 第56轮 数据中心 + AI 数据分析/周报 的云端 UI 电池（宿主模式 + 保真夹具 + 真实浏览器 + 桩模型）。
// 属主反馈"云端 AI 数据分析、数据中心都无法使用"。R50 教训：API 200 ≠ 页面能渲染，因此本电池
// 走真实点击路径，并采集 window error 与 4xx/5xx，逐条断言页面文案与行内容。
// 夹具用 tests/fixtures/cloud-schema.json 严格校验表/列：云端缺表缺列会如实报错，不会被静默补空。
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const REPO = path.resolve(__dirname, "..");
const OUT = process.env.QA_OUTPUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "r56-dc-ai-"));

// 桩模型：第一轮请求 analyze_fleet_data 工具，第二轮据工具结果作答（不真调外部模型）
const STUB = `
const real = globalThis.fetch;
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (url.startsWith('https://r56-ai-stub.invalid')) {
    // 按"最后一句用户话"选工具，按"是否已回传工具结果"决定继续调用还是作答：
    // 这样同一进程内两次提问（数据分析 / 生成周报）各自驱动对应工具，而不是共用一个回合计数
    let lastUser = '', hasToolResult = false;
    try {
      const payload = JSON.parse(init && init.body ? String(init.body) : '{}');
      const msgs = Array.isArray(payload.messages) ? payload.messages : [];
      hasToolResult = msgs.some((m) => m && m.role === 'tool');
      const users = msgs.filter((m) => m && m.role === 'user').map((m) => String(m.content || ''));
      lastUser = users.length ? users[users.length - 1] : '';
    } catch { /* 解析失败按首轮处理 */ }
    const wantReport = /周报/.test(lastUser);
    if (!hasToolResult) {
      return json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: wantReport ? 'generate_weekly_report' : 'analyze_fleet_data', arguments: '{}' } }] } }] });
    }
    return json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: wantReport
      ? '简要结论：车队周报统计已由后端算出（期末车辆数、均分、等级与可信度分布、周内趋势）。数据限制：云端工作台不提供周报 HTML/Markdown 文件下载与账号凭据 CSV，属本地完整数据工作台专属，因此本次不生成附件、也不给出下载链接。建议下一步：先核验低可信度车辆的设备与数据覆盖，再按主要扣分维度选已审核课程。'
      : '简要结论：期末车队均分与等级分布已由后端统计给出。数据限制：仅历史发行数据集，评分口径版本 original。建议下一步：先核查低可信度车辆的设备与数据覆盖。' } }] });
  }
  return real(input, init);
};`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: String(detail || "").slice(0, 240) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  :: " + String(detail || "").slice(0, 240)}`);
}

(async () => {
  const { startFixtureDatabase, passwordHash } = await import(path.join(REPO, "tests/fixtures/account-db.mjs"));
  const schema = JSON.parse(fs.readFileSync(path.join(REPO, "tests/fixtures/cloud-schema.json"), "utf8"));
  delete schema._comment;
  const db = await startFixtureDatabase({ schema });
  const t = db.tables;
  for (const name of Object.keys(schema)) t[name] ||= [];
  t.app_users = []; t.drivers = []; t.vehicle_labels = [];
  t.app_users.push({ user_id: "u-admin", username: "r56_admin", display_name: "安全管理员", role: "safety_admin", fleet_scope: "*", account_status: "active", password_hash: passwordHash("R56Admin2026"), must_change_password: false, avatar_url: null });
  // 两辆车：一辆 C 级低分、一辆 D 级，便于验证均分/等级分布与重点关注列表真的渲染出来
  t.drivers.push(
    { driver_id: "DEMO_D0149", gpsno: "95301325", display_name: "司机甲", fleet_id: "DEMO_FLEET", identity_status: "verified", mapping_start: "2026-06-01", mapping_end: "2026-07-31", source_version: "sv1", updated_at: null },
    { driver_id: "DEMO_D0150", gpsno: "95301326", display_name: "司机乙", fleet_id: "DEMO_FLEET", identity_status: "verified", mapping_start: "2026-06-01", mapping_end: "2026-07-31", source_version: "sv1", updated_at: null },
  );
  t.vehicle_labels.push({ gpsno: "95301325", display_no: 1 }, { gpsno: "95301326", display_no: 2 });
  const DAYS = ["2026-07-24", "2026-07-25", "2026-07-26", "2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31"];
  const snap = (scoreId, gpsno, driverId, date, score, level, confidence) => ({
    score_id: scoreId, gpsno, driver_id: driverId, safety_score: score, rank: 1, risk_rank_percentile: 0.1, risk_level: level,
    as_of_date: date, window_start: "2026-07-18", reference_version: "rv1", score_method: "v1", confidence_score: 70,
    confidence_level: confidence, score_status: "usable", behavior_safety_score: score, confidence_adjusted_floor: score,
    observed_behavior_deduction: 2, prior_background_deduction: 1, gross_reference_deduction: 3, uncertainty_reserve: 0,
    score_change_7d: -12.5, history_contribution: 1, fatigue_distraction_contribution: 2, driving_stability_contribution: 3,
    road_rule_contribution: 1, management_contribution: 0, imu_evidence_contribution: 1, history_event_count: 2,
    fatigue_distraction_event_count: 3, driving_stability_event_count: 4, road_rule_event_count: 1, management_event_count: 0,
    imu_evidence_event_count: 2, top_reason_1: "疲劳与分心", top_reason_2: "驾驶稳定性", top_reason_3: null,
    primary_risk_dimension: "fatigue_distraction", recommended_action: "培训", review_cycle: "7d", forecast_40d_risk_prob: 0.2,
    review_queue: "priority_review", action_deadline: "2026-08-07", immediate_alert: false, source_version: "sv1",
  });
  t.score_snapshots.push(snap("S-1", "95301325", "DEMO_D0149", "2026-07-31", 72.5, "C", "high"), snap("S-2", "95301326", "DEMO_D0150", "2026-07-31", 55.25, "D", "low"));
  DAYS.forEach((day, i) => {
    t.score_history.push({ score_id: `H1-${day}`, gpsno: "95301325", driver_id: "DEMO_D0149", as_of_date: day, window_start: "2026-07-18", safety_score: 88 - i, rank: 10, risk_level: "B", confidence_score: 80, confidence_level: "high", score_method: "v1", score_status: "usable", confidence_adjusted_floor: 80, history_contribution: 1, fatigue_distraction_contribution: 2, driving_stability_contribution: 3, road_rule_contribution: 1, management_contribution: 0, imu_evidence_contribution: 1, source_version: "sv1" });
    t.score_history.push({ score_id: `H2-${day}`, gpsno: "95301326", driver_id: "DEMO_D0150", as_of_date: day, window_start: "2026-07-18", safety_score: 70 - i, rank: 20, risk_level: "C", confidence_score: 60, confidence_level: "medium", score_method: "v1", score_status: "usable", confidence_adjusted_floor: 65, history_contribution: 2, fatigue_distraction_contribution: 3, driving_stability_contribution: 4, road_rule_contribution: 1, management_contribution: 0, imu_evidence_contribution: 1, source_version: "sv1" });
  });
  const DAY = "2026-07-29";
  t.replay_events.push(
    { event_id: "REPLAY_1", gpsno: "95301325", driver_id: "DEMO_D0149", event_time: `${DAY} 00:01:08`, event_type: "30002", event_name: "左车道偏移", speed_kmh: "67.0", dimension: "driving_stability", replay_date: DAY, is_replay: true, source_version: "snapshot_ffbc" },
    { event_id: "REPLAY_2", gpsno: "95301325", driver_id: "DEMO_D0149", event_time: `${DAY} 00:01:14`, event_type: "30002", event_name: "左车道偏移", speed_kmh: "66.0", dimension: "driving_stability", replay_date: DAY, is_replay: true, source_version: "snapshot_ffbc" },
    { event_id: "REPLAY_3", gpsno: "95301326", driver_id: "DEMO_D0150", event_time: `${DAY} 00:04:33`, event_type: "41001", event_name: "疲劳迹象", speed_kmh: "49.0", dimension: "fatigue_distraction", replay_date: DAY, is_replay: true, source_version: "snapshot_ffbc" },
  );
  t.risk_snapshots.push({ snapshot_id: "R-1", gpsno: "95301325", risk_prob: 0.2, risk_rank: 5, as_of_date: "2026-07-31", horizon_days: 40, source_version: "sv1" }, { snapshot_id: "R-2", gpsno: "95301326", risk_prob: 0.4, risk_rank: 2, as_of_date: "2026-07-31", horizon_days: 40, source_version: "sv1" });
  t.deduction_ledger.push({ ledger_id: "L-1", gpsno: "95301325", event_type: "30002", dimension: "driving_stability", event_count: 2, decayed_severity: 1.5, dimension_points: 3, allocated_points: 3, allocation_rule: "rule1", as_of_date: "2026-07-31", source_version: "sv1" });
  t.review_queue.push({ queue_id: "Q-1", gpsno: "95301326", safety_score: 55.25, risk_level: "D", forecast_40d_risk_prob: 0.4, review_queue: "priority_review", action_deadline: "2026-08-07", confidence_level: "low", top_reason_1: "疲劳与分心", as_of_date: "2026-07-31", source_version: "sv1" });
  // 第57轮：迁移017 导入的四张全量索引表 + 溯源行（真实云端已是这个状态）
  const SV = "processed_cleaned_20260921";
  t.local_profiles.push(
    { gpsno: "95301325", energy_type: "电力", monthly_mileage_km: 6853.08, monthly_drive_hours: 125.32, monthly_stop_count: 83.17, highway_mileage_ratio: 0.0322, morning_drive_time_ratio: 0.2872, dusk_drive_time_ratio: 0.2, night_drive_time_ratio: 0.0928, night_mileage_ratio: 0.0942, source_version: SV },
    { gpsno: "95301326", energy_type: "柴油", monthly_mileage_km: 13155.63, monthly_drive_hours: 210.4, monthly_stop_count: 120.5, highway_mileage_ratio: 0.41, morning_drive_time_ratio: 0.22, dusk_drive_time_ratio: 0.15, night_drive_time_ratio: 0.0713, night_mileage_ratio: 0.0688, source_version: SV },
  );
  t.local_trajectory_daily.push(
    { gpsno: "95301325", event_date: DAY, source_rows: 6846, valid_speed_rows: 6846, invalid_speed_rows: 0, speed_mean_kmh: 12.772129710780018, speed_std_kmh: 19.06, speed_max_kmh: 64, moving_rows: 2512, valid_coordinate_rows: 6843, invalid_coordinate_rows: 3, invalid_course_rows: 0, invalid_distance_rows: 0, large_distance_gap_rows: 1, distance_km: 68.00714, invalid_run_time_rows: 0, run_time_hours: 1.6227777777777779, source_version: SV },
    { gpsno: "95301325", event_date: "2026-07-30", source_rows: 11223, valid_speed_rows: 11223, invalid_speed_rows: 0, speed_mean_kmh: 27.19, speed_std_kmh: 25.52, speed_max_kmh: 82, moving_rows: 8100, valid_coordinate_rows: 11220, invalid_coordinate_rows: 3, invalid_course_rows: 0, invalid_distance_rows: 0, large_distance_gap_rows: 0, distance_km: 381.61879, invalid_run_time_rows: 0, run_time_hours: 7.48, source_version: SV },
    { gpsno: "95301326", event_date: DAY, source_rows: 4100, valid_speed_rows: 4099, invalid_speed_rows: 1, speed_mean_kmh: 33.4, speed_std_kmh: 18.2, speed_max_kmh: 76, moving_rows: 3000, valid_coordinate_rows: 4100, invalid_coordinate_rows: 0, invalid_course_rows: 0, invalid_distance_rows: 0, large_distance_gap_rows: 0, distance_km: 128.5, invalid_run_time_rows: 0, run_time_hours: 3.85, source_version: SV },
  );
  t.local_imu_daily.push({ gpsno: "95301325", event_date: DAY, source_rows: 31163, imei_count: 1, date_mismatch_rows: 0, missing_ems_speed_rows: 0, missing_gps_speed_rows: 14151, ems_speed_mean: 26.77, ems_speed_max: 71.56, gps_speed_mean: 27.97, gps_speed_max: 69.67, ems_gps_abs_diff_mean: 1.13, accel_norm_mean: 0.9766, accel_norm_std: 0.0086, accel_norm_max: 1.0613, gyro_norm_mean: 4.4566, gyro_norm_std: 1.4986, gyro_norm_max: 30.78, accel_norm_outlier_rows: 0, gyro_norm_gt20_rows: 12, source_version: SV });
  t.local_event_daily.push(
    { gpsno: "95301325", event_date: DAY, event_type: "30002", event_name: "左车道偏移", event_count: 12, source_version: SV },
    { gpsno: "95301325", event_date: DAY, event_type: "41001", event_name: "疲劳迹象", event_count: 5, source_version: SV },
    { gpsno: "95301326", event_date: DAY, event_type: "30002", event_name: "左车道偏移", event_count: 3, source_version: SV },
  );
  t.local_index_provenance.push({ source_version: SV, dataset: "processed/cleaned（属主交付的处理后清洗数据）", observation_start: "2026-06-01", observation_end: "2026-07-31", vehicle_count: 500, source_event_rows: "3152654", source_trajectory_rows: "584310388", source_imu_rows: "738244484", profile_rows: 500, trajectory_daily_rows: 28827, imu_daily_rows: 14836, event_daily_groups: 198873, quality_report_at: "2026-09-21 17:26:02", imported_at: "2026-11-03 17:58:14", imported_by: "scripts/import-cloud-index.py", notes: "risk_events 逐条事件日志未入库（仅按 车辆×日×事件类型 导入真实日聚合）。" });

  t.operation_config.push({ config_id: "drop_threshold", value: "10", unit: "score_points", config_version: "ops_v1", updated_by: null, updated_at: null, effective_at: null }, { config_id: "ai_long_session", value: "off", unit: "flag", config_version: "8", updated_by: null, updated_at: null, effective_at: null });
  t.audit_logs ||= []; t.notification_events ||= []; t.training_tasks ||= []; t.training_courses ||= [];
  t.training_courses.push({ course_id: "c1", title: "防御性驾驶", dimension: "fatigue_distraction", content_status: "approved", version_no: 1, source_version: "sv1", updated_at: "2026-08-01T00:00:00Z" });
  t.evaluation_rules ||= [];

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r56-stub-"));
  const preload = path.join(dir, "ai-stub.cjs");
  fs.writeFileSync(preload, STUB);
  const PORT = "3156";
  const child = spawn(process.execPath, ["--require", preload, "server.mjs"], {
    cwd: REPO,
    env: { HOST: "127.0.0.1", PORT, SUPABASE_URL: db.url, SUPABASE_ANON_KEY: "test", SUPABASE_INSTANCE_ID: "fixture", QW_AI_BASE_URL: "https://r56-ai-stub.invalid", QW_AI_API_KEY: "stub-key-abcdefghij", QW_AI_MODEL: "stub-model" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  child.stderr.on("data", (x) => { serverLog += x; });
  child.stdout.on("data", (x) => { serverLog += x; });
  const B = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 200; i++) { try { if ((await fetch(B + "/healthz")).ok) break; } catch { /* 等待启动 */ } await new Promise((r) => setTimeout(r, 50)); }

  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "/usr/lib/node_modules/playwright");
  const exec = process.env.BROWSER_EXECUTABLE || (fs.existsSync("/opt/playwright-browsers/chromium-1209/chrome-linux64/chrome") ? "/opt/playwright-browsers/chromium-1209/chrome-linux64/chrome" : undefined);
  const browser = await chromium.launch({ headless: true, executablePath: exec, args: ["--no-sandbox"] });
  const pageErrors = [], httpFailures = [];
  const bodyText = async () => page.evaluate(() => document.body.innerText || "");
  const tableRows = async () => page.evaluate(() => Array.from(document.querySelectorAll(".data-center table tbody tr")).map((tr) => tr.innerText.replace(/\n/g, "/")));
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await context.newPage();
  const noise = /(favicon|React DevTools|Download the React)/;
  page.on("pageerror", (e) => { if (!noise.test(String(e))) pageErrors.push(String(e).slice(0, 160)); });
  page.on("response", (res) => { if (res.status() >= 400) httpFailures.push(`${res.status()} ${new URL(res.url()).pathname}`); });

  await page.goto(B + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: /使用账号登录|使用工作台账号登录/ }).first().click().catch(() => {});
  await page.locator("#ln").fill("r56_admin");
  await page.locator("#pw").fill("R56Admin2026");
  await page.locator(".login-submit").click();
  await page.waitForTimeout(2000);
  const landing = await bodyText();
  if (/登录服务暂不可用|欢迎回来/.test(landing)) {
    console.log("LOGIN FAILED; server log tail:\n" + serverLog.split("\n").slice(-25).join("\n"));
  }
  check("管理员登录进入工作台", !/登录服务暂不可用|欢迎回来/.test(landing.slice(0, 400)), landing.slice(0, 120));
  httpFailures.length = 0; pageErrors.length = 0; // 登录前的匿名 /api/me 401 属设计行为，不计入

  // ===== 数据中心 =====
  // 状态面板要等 /api/data-status 真实返回（含索引计数与溯源行），用轮询而不是固定睡
  const waitUntil = async (probe, label, timeoutMs = 25000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await probe()) return true;
      await page.waitForTimeout(400);
    }
    console.log(`${label} 等待超时；pageerrors=${JSON.stringify(pageErrors.slice(0, 2))} httpFailures=${JSON.stringify(httpFailures.slice(0, 6))}`);
    console.log("server log tail:\n" + serverLog.split("\n").slice(-14).join("\n"));
    return false;
  };
  await page.goto(`${B}/#/data-center`, { waitUntil: "domcontentloaded" });
  await waitUntil(async () => (await page.evaluate(() => document.querySelectorAll(".data-center .cards .card").length)) > 0, "数据中心统计卡");
  let text = await bodyText();
  check("DC01 数据中心标题渲染", text.includes("数据中心"), text.slice(0, 120));
  check("DC02 状态面板未整体报错", !/数据状态读取失败|暂时无法读取数据|database_unavailable/.test(text), text.match(/数据状态读取失败[^\n]*/)?.[0] || "");
  check("DC03 云端实时装配说明可见（R59 起折叠在「云端数据装配口径说明」内）", (await page.locator(".prov-note summary").count()) === 1 && text.includes("云端数据装配口径说明"), "缺少装配口径折叠说明");
  const cards = await page.evaluate(() => Array.from(document.querySelectorAll(".data-center .cards .card")).map((c) => c.innerText.replace(/\n/g, "/")));
  check("DC04 八张统计卡渲染", cards.length === 8, `cards=${cards.length}`);
  const cardText = cards.join(" | ").replace(/\n/g, "/");
  check("DC05 车辆/评分/回放事件计数为真实在线库数字",
    cardText.includes("车辆/2") && cardText.includes("当前评分/2") && cardText.includes("历史评分/16") && cardText.includes("回放事件样本/3"), cardText);
  check("DC05b 标签如实区分「回放事件样本」与「事件日统计」", cardText.includes("回放事件样本/3") && cardText.includes("事件日统计/3"), cardText);
  check("DC06 导入索引后轨迹/IMU/画像卡片为真实行数", cardText.includes("轨迹日汇总/3") && cardText.includes("IMU 日汇总/1") && cardText.includes("车辆画像/2"), cardText);
  check("DC06b 全量索引溯源面板显示来源与观测窗（R59 结构化网格）", text.includes("全量索引溯源") && text.includes("processed_cleaned_20260921") && text.includes("2026-06-01") && text.includes("2026-07-31") && text.includes("500") && text.includes("车"), text.match(/全量索引溯源[\s\S]{0,260}/)?.[0] || "");
  check("DC06c 溯源面板如实显示源数据量与入库形态", text.includes("3,152,654") && text.includes("584,310,388") && text.includes("738,244,484") && text.includes("198,873"), text.match(/源数据量[^\n]*/)?.[0] || "");
  check("DC06d 溯源口径说明声明逐条日志未入库", text.includes("逐条事件日志未入库"), "");
  check("DC07 事件与评分历史日期范围来自真实表", text.includes("2026-07-29") && text.includes("2026-07-24") && text.includes("2026-07-31"), text.match(/事件覆盖[^\n]*/)?.[0] || "");

  async function pickDate(value) {
    const input = page.locator('.data-filters input[type="date"]').first();
    await waitUntil(async () => (await input.count()) > 0, `日期输入框(${value})`, 15000);
    await input.fill(value);
    await waitUntil(async () => (await bodyText()).includes(value), `日期=${value} 生效`, 15000);
    return bodyText();
  }

  async function pickKind(title) {
    const select = page.locator(".data-filters select").first();
    await waitUntil(async () => (await select.count()) > 0, `数据类型下拉(${title})`, 15000);
    await select.selectOption({ label: new RegExp(`^${title}`) }).catch(async () => {
      const options = await page.locator(".data-filters select option").allInnerTexts();
      const wanted = options.find((o) => o.startsWith(title));
      if (wanted) await select.selectOption(wanted);
    });
    await page.waitForTimeout(2200);
    return bodyText();
  }

  text = await pickKind("事件明细");
  text = await pickDate(DAY); // 切到夹具中真实有事件的回放日
  const eventRows = await tableRows();
  // 车辆筛选默认取第一辆（车辆1=95301325，夹具内 2 条事件）：先验本车可见，再切全部车辆验全量
  check("DC08 事件明细出行（云端 replay_events 投影，默认车辆1）", eventRows.length === 2 && eventRows.every((r) => r.includes("左车道偏移") && r.includes("2026-07-29")), eventRows.join(" | "));
  await page.locator(".data-filters select").nth(1).selectOption({ label: "全部车辆" });
  await page.waitForTimeout(1800);
  const allEventRows = await tableRows();
  check("DC08b 全部车辆可见两台车事件", allEventRows.length === 3 && allEventRows.join("|").includes("疲劳迹象"), allEventRows.join(" | "));
  check("DC09 事件明细显示日期口径说明", text.includes("replay_date") || text.includes("坐标/速度有效性"), "缺少事件明细 hosted_note");
  check("DC10 坐标有效性列不冒充本地全量日志", !/坐标有效[\s\S]{0,4}true/.test(text), "cloud 无该列却出现 true");

  text = await pickKind("事件日统计");
  text = await pickDate(DAY);
  await page.locator(".data-filters select").nth(1).selectOption({ label: "车辆1" });
  await page.waitForTimeout(1800);
  const scopedRows = await tableRows();
  check("DC11 事件日统计（车辆1）读导入索引真实计数", scopedRows.length === 2 && scopedRows.some((r) => /左车道偏移\s*\|?\s*12|左车道偏移\/12/.test(r) || (r.includes("左车道偏移") && r.includes("12"))) && scopedRows.some((r) => r.includes("疲劳迹象") && r.includes("5")), scopedRows.join(" | "));
  await page.locator(".data-filters select").nth(1).selectOption({ label: "全部车辆" });
  await page.waitForTimeout(1800);
  const dailyRows = await tableRows();
  check("DC11b 全部车辆三组索引条目", dailyRows.length === 3 && dailyRows.filter((r) => r.includes("左车道偏移")).length === 2, dailyRows.join(" | "));
  text = await bodyText();
  check("DC12 事件日统计标注读导入索引 local_event_daily", text.includes("local_event_daily") && text.includes("全量索引"), text.match(/云端「事件日统计」[^\n]{0,120}/)?.[0] || "");
  check("DC12b 事件日统计如实说明与「事件明细」口径差异", text.includes("回放日样本") && text.includes("口径不同属数据源差异"), text.match(/「事件明细」[^\n]{0,90}/)?.[0] || "");

  await page.locator(".data-filters select").first().selectOption({ index: 0 });
  await page.locator(".data-filters select").nth(1).selectOption({ label: "全部车辆" });
  await page.waitForTimeout(1200);

  text = await pickKind("轨迹日汇总");
  text = await pickDate(DAY);
  const trajRows = await tableRows();
  check("DC13 轨迹日汇总读导入索引真实行", trajRows.length === 2 && trajRows.every((r) => r.includes(DAY)) && trajRows.join("|").includes("68.0071") && trajRows.join("|").includes("1.6228"), trajRows.join(" | "));
  check("DC13b 运行小时由源列 run_time_hours 映射到 UI 契约名", text.includes("运行小时") && text.includes("run_time_hours"), text.match(/云端「轨迹日汇总」[^\n]{0,120}/)?.[0] || "");
  check("DC13c 轨迹质量列入表（无效坐标行数）", trajRows.join("|").includes("3"), trajRows.join(" | "));

  text = await pickKind("IMU 日汇总");
  text = await pickDate(DAY);
  const imuRows = await tableRows();
  check("DC14 IMU 日汇总读导入索引真实行", imuRows.length === 1 && imuRows[0].includes("31163") && imuRows[0].includes("27.9700"), imuRows.join(" | "));
  check("DC14b 异常采样由源列 *_rows 映射且缺失列不冒充", text.includes("加速度异常采样") && text.includes("missing_gps_speed_rows") && !/缺加速度行数[\s\S]{0,6}\d/.test(text), text.match(/云端「IMU 日汇总」[^\n]{0,140}/)?.[0] || "");

  text = await pickKind("车辆画像");
  const profileRows = await tableRows();
  check("DC14c 车辆画像读导入索引真实行", profileRows.length === 2 && profileRows.join("|").includes("电力") && profileRows.join("|").includes("6853.0800") && profileRows.join("|").includes("柴油"), profileRows.join(" | "));

  // 行详情：把导入索引真实带的质量列摊开给专业核对
  await page.locator(".data-center table tbody tr").first().locator("button", { hasText: "详情" }).click({ force: true }).catch(() => {});
  await page.waitForTimeout(900);
  text = await bodyText();
  check("DC14d 行详情展开画像全字段", text.includes("数据详情") && text.includes("能源类型") && text.includes("来源版本"), text.match(/数据详情[^\n]{0,80}/)?.[0] || "未展开详情");

  // ===== AI 数据分析 / 生成周报 =====
  const dcApiFailures = [...httpFailures];
  check("DC15 数据中心全程无 4xx/5xx", dcApiFailures.length === 0, dcApiFailures.slice(0, 4).join(", "));

  await page.locator("nav.side button", { hasText: "智能助手" }).first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(1200);
  check("AI00 AI 面板已打开", (await page.locator(".ai-panel").count()) === 1, "未找到 .ai-panel");
  const openLimits = async () => { await page.evaluate(() => { document.querySelectorAll(".ai-panel details").forEach((d) => { d.open = true; }); }); await page.waitForTimeout(400); };

  await page.locator(".ai-shortcuts button", { hasText: "数据分析" }).first().click({ force: true });
  await page.waitForTimeout(9000);
  text = await bodyText();
  check("AI01 「数据分析」不再报 agent_service_unavailable", !/agent_service_unavailable|暂时无法读取数据/.test(text), text.match(/agent_service_unavailable[^\n]*/)?.[0] || "");
  check("AI02 AI 回答含后端真实统计口径", /数据口径与限制/.test(text) && /original|发行数据集/.test(text), "回答缺少云端统计范围限制");
  check("AI03 /api/agent/analysis 返回 200", !httpFailures.some((x) => x.includes("/api/agent/analysis")), httpFailures.filter((x) => x.includes("/api/agent")).join(", "));

  await openLimits(); // 「数据口径与限制」默认折叠：展开后再断言，避免把折叠态当成"没说明"
  text = await bodyText();
  check("AI02b 数据分析的限制条款展开可见", /云端在线库的发行数据集|统计范围/.test(text), text.match(/数据口径与限制[\s\S]{0,140}/)?.[0] || "");
  await page.locator(".ai-shortcuts button", { hasText: "生成周报" }).first().click();
  await page.waitForTimeout(12000);
  text = await bodyText();
  check("AI04 「生成周报」不再 503", !/agent_service_unavailable/.test(text), "");
  await openLimits();
  text = await bodyText();
  check("AI05 周报不谎报附件/下载链接", !/已生成车队安全周报文件|附件已生成|附件已下载|请点击查看附件/.test(text) && /本地完整数据工作台/.test(text), "云端应如实说明周报文件属本地专属、不声称已生成附件");
  check("AI05b 周报限制条款禁止模型声称已生成文件", /不要声称已生成文件|云端不生成附件/.test(text), text.match(/数据口径与限制[\s\S]{0,160}/)?.[0] || "");
  check("AI06 /api/agent/report 返回 200", !httpFailures.some((x) => x.includes("/api/agent/report")), httpFailures.filter((x) => x.includes("/api/agent/report")).join(", "));

  check("AI07 全程零运行时异常", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  const lateFailures = httpFailures.filter((x) => !dcApiFailures.includes(x));
  check("AI08 AI 两个入口无失败接口", lateFailures.length === 0, lateFailures.slice(0, 4).join(", "));
  check("SV01 服务端无数据库失败日志", !/db failure|DB_DETAIL/.test(serverLog), serverLog.split("\n").filter((l) => /db failure|DB_DETAIL/.test(l)).slice(0, 3).join(" | "));

  await page.screenshot({ path: path.join(OUT, "r56-data-center.png"), fullPage: true }).catch(() => {});
  await browser.close();
  child.kill();
  await db.close();
  const bad = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(OUT, "r56-result.json"), JSON.stringify({ generated: new Date().toISOString(), out: OUT, pass: results.length - bad.length, fail: bad.length, results }, null, 1));
  console.log(`\n=== ${results.length - bad.length}/${results.length} PASS · bad=${bad.length} · 输出 ${OUT}`);
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error("BATTERY_CRASH", e); process.exit(2); });
