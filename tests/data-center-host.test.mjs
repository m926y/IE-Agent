// 第56/57轮：数据中心 + AI 数据分析的**托管库保真**契约测试。
// 夹具用真实托管库的表/列清单（tests/fixtures/cloud-schema.json）+ PostgREST 错误语义
// （未知关系 404/42P01、未知列 400/42703），因此下列线上事故在这里必然复现：
//   ① /api/data-status 读 data_metadata（云端无此表）→ 旧码 404 database_unavailable，降级分支到不了；
//   ② 数据中心「事件明细」沿用本地 TEMP VIEW 的 event_date/coordinate_valid/speed_valid → 云端 400；
//   ③ /api/agent/analysis、/api/agent/report 被 APP_DATA_MODE!=='full' 硬闸拦成 503，尽管入参全在云端在线库。
// 第57轮追加：迁移017 导入四张全量索引表（local_profiles/local_trajectory_daily/local_imu_daily/local_event_daily）
// 后，数据中心三类缺源明细必须读**导入的真实行**（列名在输出层映射到 UI 契约），并给出溯源；
// 未导入或建表未灌数时仍须诚实降级，不得用 0 或样本冒充全量。
// 全程隔离夹具，不访问真实业务库、不调真实模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { startFixtureDatabase, passwordHash } from './fixtures/account-db.mjs';

const CLOUD_SCHEMA = JSON.parse(readFileSync(new URL('./fixtures/cloud-schema.json', import.meta.url), 'utf8'));
delete CLOUD_SCHEMA._comment;
const INDEX_TABLES = ['local_profiles', 'local_trajectory_daily', 'local_imu_daily', 'local_event_daily', 'local_index_provenance'];
const NO_INDEX_SCHEMA = Object.fromEntries(Object.entries(CLOUD_SCHEMA).filter(([name]) => !INDEX_TABLES.includes(name)));

const DAY = '2026-07-29';
const HISTORY_DAYS = ['2026-07-24', '2026-07-25', '2026-07-26', '2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31'];
const SOURCE_VERSION = 'processed_cleaned_20260921';

// 只播种发行 19 表契约里真实存在的列（照抄线上托管库形状），不夹带本地索引列
function seed(db) {
  const t = db.tables;
  for (const name of Object.keys(CLOUD_SCHEMA)) t[name] ||= [];
  // 只保留本测试播种的账号与车辆，避免夹具默认行干扰精确计数
  t.app_users = []; t.drivers = []; t.vehicle_labels = [];
  t.app_users.push(
    { user_id: 'u-admin', username: 'dc_admin', display_name: '安全管理员', role: 'safety_admin', fleet_scope: '*', account_status: 'active', password_hash: passwordHash('DcAdmin2026'), must_change_password: false, avatar_url: null },
    { user_id: 'u-officer', username: 'dc_officer', display_name: '安全员乙', role: 'safety_officer', fleet_scope: 'OTHER_FLEET', account_status: 'active', password_hash: passwordHash('DcOfficer2026'), must_change_password: false, avatar_url: null },
    { user_id: 'u-driver', username: 'dc_driver', display_name: '司机甲', role: 'driver', driver_id: 'DEMO_D0149', fleet_scope: 'DEMO_FLEET', binding_verified: true, account_status: 'active', password_hash: passwordHash('DcDriver2026'), must_change_password: false, avatar_url: null },
    { user_id: 'u-unbound', username: 'dc_unbound', display_name: '司机乙', role: 'driver', driver_id: 'DEMO_D9999', fleet_scope: 'DEMO_FLEET', binding_verified: false, account_status: 'active', password_hash: passwordHash('DcUnbound2026'), must_change_password: false, avatar_url: null },
  );
  t.drivers.push({ driver_id: 'DEMO_D0149', gpsno: '95301325', display_name: '司机甲', fleet_id: 'DEMO_FLEET', identity_status: 'verified', mapping_start: '2026-06-01', mapping_end: '2026-07-31', source_version: 'sv1', updated_at: null });
  t.vehicle_labels.push({ gpsno: '95301325', display_no: 1 });
  const score = (scoreId, date, safetyScore, level, confidence) => ({
    score_id: scoreId, gpsno: '95301325', driver_id: 'DEMO_D0149', safety_score: safetyScore, rank: 1, risk_rank_percentile: 0.1,
    risk_level: level, as_of_date: date, window_start: '2026-07-18', reference_version: 'rv1', score_method: 'v1',
    confidence_score: 80, confidence_level: confidence, score_status: 'usable', behavior_safety_score: safetyScore,
    confidence_adjusted_floor: safetyScore, observed_behavior_deduction: 2, prior_background_deduction: 1,
    gross_reference_deduction: 3, uncertainty_reserve: 0, score_change_7d: -1.5,
    history_contribution: 1, fatigue_distraction_contribution: 2, driving_stability_contribution: 3,
    road_rule_contribution: 1, management_contribution: 0, imu_evidence_contribution: 1,
    history_event_count: 2, fatigue_distraction_event_count: 3, driving_stability_event_count: 4,
    road_rule_event_count: 1, management_event_count: 0, imu_evidence_event_count: 2,
    top_reason_1: '疲劳与分心', top_reason_2: '驾驶稳定性', top_reason_3: null,
    primary_risk_dimension: 'fatigue_distraction', recommended_action: '培训', review_cycle: '7d',
    forecast_40d_risk_prob: 0.2, review_queue: 'priority_review', action_deadline: '2026-08-07',
    immediate_alert: false, source_version: 'sv1',
  });
  t.score_snapshots.push(score('S-1', '2026-07-31', 72.5, 'C', 'high'), score('S-2', '2026-07-30', 80.25, 'B', 'high'));
  HISTORY_DAYS.forEach((day, index) => t.score_history.push({
    score_id: `H-${day}`, gpsno: '95301325', driver_id: 'DEMO_D0149', as_of_date: day, window_start: '2026-07-18',
    safety_score: 88 - index, rank: 10, risk_level: 'B', confidence_score: 80, confidence_level: 'high',
    score_method: 'v1', score_status: 'usable', confidence_adjusted_floor: 80,
    history_contribution: 1, fatigue_distraction_contribution: 2, driving_stability_contribution: 3,
    road_rule_contribution: 1, management_contribution: 0, imu_evidence_contribution: 1, source_version: 'sv1',
  }));
  t.replay_events.push(
    { event_id: 'REPLAY_1', gpsno: '95301325', driver_id: 'DEMO_D0149', event_time: `${DAY} 00:01:08`, event_type: '30002', event_name: '左车道偏移', speed_kmh: '67.0', dimension: 'driving_stability', replay_date: DAY, is_replay: true, source_version: 'snapshot_ffbc' },
    { event_id: 'REPLAY_2', gpsno: '95301325', driver_id: 'DEMO_D0149', event_time: `${DAY} 00:01:14`, event_type: '30002', event_name: '左车道偏移', speed_kmh: '66.0', dimension: 'driving_stability', replay_date: DAY, is_replay: true, source_version: 'snapshot_ffbc' },
    { event_id: 'REPLAY_3', gpsno: '95301325', driver_id: 'DEMO_D0149', event_time: `${DAY} 00:04:33`, event_type: '41001', event_name: '疲劳迹象', speed_kmh: '49.0', dimension: 'fatigue_distraction', replay_date: DAY, is_replay: true, source_version: 'snapshot_ffbc' },
  );
  t.risk_snapshots.push({ snapshot_id: 'R-1', gpsno: '95301325', risk_prob: 0.2, risk_rank: 5, as_of_date: '2026-07-31', horizon_days: 40, source_version: 'sv1' });
  t.deduction_ledger.push({ ledger_id: 'L-1', gpsno: '95301325', event_type: '30002', dimension: 'driving_stability', event_count: 2, decayed_severity: 1.5, dimension_points: 3, allocated_points: 3, allocation_rule: 'rule1', as_of_date: '2026-07-31', source_version: 'sv1' });
  t.review_queue.push({ queue_id: 'Q-1', gpsno: '95301325', safety_score: 72.5, risk_level: 'C', forecast_40d_risk_prob: 0.2, review_queue: 'priority_review', action_deadline: '2026-08-07', confidence_level: 'high', top_reason_1: '疲劳与分心', as_of_date: '2026-07-31', source_version: 'sv1' });
  t.operation_config.push({ config_id: 'drop_threshold', value: '10', unit: 'score_points', config_version: 'ops_v1', updated_by: null, updated_at: null, effective_at: null });
}

// 第57轮：导入后的全量索引行（列名=清洗数据真名，与迁移017 一致）
function seedIndex(db) {
  const t = db.tables;
  t.local_profiles.push({ gpsno: '95301325', energy_type: '电力', monthly_mileage_km: 6853.08, monthly_drive_hours: 125.32, monthly_stop_count: 83.17, highway_mileage_ratio: 0.0322, morning_drive_time_ratio: 0.2872, dusk_drive_time_ratio: 0.2, night_drive_time_ratio: 0.0928, night_mileage_ratio: 0.0942, source_version: SOURCE_VERSION });
  for (const [day, rows, km, hours] of [[DAY, 6846, 68.00714, 1.6227777777777779], ['2026-07-30', 11223, 210.5, 4.4]]) {
    t.local_trajectory_daily.push({ gpsno: '95301325', event_date: day, source_rows: rows, valid_speed_rows: rows, invalid_speed_rows: 0, speed_mean_kmh: 27.188, speed_std_kmh: 25.52, speed_max_kmh: 82, moving_rows: Math.round(rows * 0.6), valid_coordinate_rows: rows - 3, invalid_coordinate_rows: 3, invalid_course_rows: 0, invalid_distance_rows: 0, large_distance_gap_rows: 1, distance_km: km, invalid_run_time_rows: 0, run_time_hours: hours, source_version: SOURCE_VERSION });
  }
  t.local_imu_daily.push({ gpsno: '95301325', event_date: DAY, source_rows: 31163, imei_count: 1, date_mismatch_rows: 0, missing_ems_speed_rows: 0, missing_gps_speed_rows: 14151, ems_speed_mean: 26.77, ems_speed_max: 71.56, gps_speed_mean: 27.97, gps_speed_max: 69.67, ems_gps_abs_diff_mean: 1.13, accel_norm_mean: 0.9766, accel_norm_std: 0.0086, accel_norm_max: 1.0613, gyro_norm_mean: 4.4566, gyro_norm_std: 1.4986, gyro_norm_max: 30.78, accel_norm_outlier_rows: 0, gyro_norm_gt20_rows: 12, source_version: SOURCE_VERSION });
  t.local_event_daily.push(
    { gpsno: '95301325', event_date: DAY, event_type: '30002', event_name: '左车道偏移', event_count: 12, source_version: SOURCE_VERSION },
    { gpsno: '95301325', event_date: DAY, event_type: '41001', event_name: '疲劳迹象', event_count: 5, source_version: SOURCE_VERSION },
  );
  t.local_index_provenance.push({
    source_version: SOURCE_VERSION, dataset: 'processed/cleaned（属主交付的处理后清洗数据）',
    observation_start: '2026-06-01', observation_end: '2026-07-31', vehicle_count: 500,
    source_event_rows: '3152654', source_trajectory_rows: '584310388', source_imu_rows: '738244484',
    profile_rows: 500, trajectory_daily_rows: 28827, imu_daily_rows: 14836, event_daily_groups: 198873,
    quality_report_at: '2026-09-21 17:26:02', imported_at: '2026-11-03 17:58:14',
    imported_by: 'scripts/import-cloud-index.py', notes: 'risk_events 逐条事件日志未入库（仅按 车辆×日×事件类型 导入真实日聚合）。',
  });
}

async function boot({ schema = CLOUD_SCHEMA, index = true } = {}) {
  const db = await startFixtureDatabase({ schema });
  seed(db);
  if (index && INDEX_TABLES.every((name) => name in schema)) seedIndex(db);
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('../', import.meta.url), windowsHide: true,
    env: { HOST: '127.0.0.1', PORT: String(port), SUPABASE_URL: db.url, SUPABASE_ANON_KEY: 'test', SUPABASE_INSTANCE_ID: 'fixture' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x);
  const base = `http://127.0.0.1:${port}`;
  async function call(path, { cookie, method = 'GET', body } = {}) {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch { /* 非 JSON 响应 */ }
    return { status: r.status, body: j, cookie: r.headers.get('set-cookie')?.split(';')[0] };
  }
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch { /* 等待启动 */ } await new Promise(r => setTimeout(r, 50)); }
  const login = async (username, password) => (await call('/api/auth/login', { method: 'POST', body: { username, password } })).cookie;
  const cookies = {
    admin: await login('dc_admin', 'DcAdmin2026'),
    officer: await login('dc_officer', 'DcOfficer2026'),
    driver: await login('dc_driver', 'DcDriver2026'),
    unbound: await login('dc_unbound', 'DcUnbound2026'),
  };
  for (const [role, cookie] of Object.entries(cookies)) assert.ok(cookie, `${role} 登录未拿到会话`);
  return { db, child, call, base, ...cookies, get output() { return output; } };
}
const stop = env => { env.child.kill(); return env.db.close(); };

test('fixture is faithful: 云端不存在的表按 PostgREST 语义 404/42P01、缺列 400/42703', async () => {
  const env = await boot({ schema: NO_INDEX_SCHEMA });
  try {
    for (const table of ['data_metadata', ...INDEX_TABLES]) {
      const r = await fetch(`${env.db.url}/rest/v1/${table}?select=1&limit=1`, { headers: { apikey: 'test', Authorization: 'Bearer test' } });
      assert.equal(r.status, 404, `${table} 应当 404`);
      assert.equal((await r.json()).code, '42P01');
    }
    const r = await fetch(`${env.db.url}/rest/v1/replay_events?select=event_date&limit=1`, { headers: { apikey: 'test', Authorization: 'Bearer test' } });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, '42703');
  } finally { await stop(env); }
});

test('/api/data-status 已导入全量索引：真实计数 + 溯源行（数字不在代码里硬编码）', async () => {
  const env = await boot();
  try {
    const r = await env.call('/api/data-status', { cookie: env.admin });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const m = r.body;
    assert.equal(m.counts.drivers, 1);
    assert.equal(m.counts.score_snapshots, 2);
    assert.equal(m.counts.score_history, HISTORY_DAYS.length);
    assert.equal(m.counts.events, 3);
    assert.equal(m.counts.event_daily, 2);
    assert.equal(m.counts.trajectory_daily, 2);
    assert.equal(m.counts.imu_daily, 1);
    assert.equal(m.counts.profiles, 1);
    assert.equal(m.index_imported, true);
    assert.equal(m.index_provenance.source_version, SOURCE_VERSION);
    assert.equal(String(m.index_provenance.source_event_rows), '3152654');
    assert.equal(m.index_provenance.observation_start, '2026-06-01');
    assert.equal(m.index_provenance.observation_end, '2026-07-31');
    assert.equal(m.index_provenance.vehicle_count, 500);
    assert.deepEqual(m.hosted_sources, { events: 'online_table', event_daily: 'imported_index', trajectory_daily: 'imported_index', imu_daily: 'imported_index', profiles: 'imported_index' });
    assert.ok(m.hosted_note.includes(SOURCE_VERSION), '装配说明应点明所用数据集版本');
    assert.equal(m.event_start, DAY); assert.equal(m.event_end, DAY);
    assert.equal(m.history_start, HISTORY_DAYS[0]); assert.equal(m.history_end, HISTORY_DAYS.at(-1));
    assert.deepEqual(m.level_counts, { A: 0, B: 1, C: 1, D: 0 });
    assert.equal((await env.call('/api/data-status')).status, 401, '未登录不得读取');
  } finally { await stop(env); }
});

test('/api/data-status 未导入索引：计数如实 null（不用 0 冒充）+ 缺源说明 + 真实缺表仍报错', async () => {
  const env = await boot({ schema: NO_INDEX_SCHEMA });
  try {
    const r = await env.call('/api/data-status', { cookie: env.admin });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const m = r.body;
    assert.equal(m.index_imported, false);
    assert.equal(m.index_provenance, null);
    for (const key of ['event_daily', 'trajectory_daily', 'imu_daily', 'profiles']) assert.equal(m.counts[key], null, `${key} 未导入应为 null`);
    assert.deepEqual(m.hosted_sources, { events: 'online_table', event_daily: 'aggregated_from_online_events', trajectory_daily: null, imu_daily: null, profiles: null });
    assert.equal(m.counts.events, 3, '在线发行表计数不受索引缺失影响');
  } finally { await stop(env); }
  // 索引缺表可以降级；**发行表**缺表必须如实报错，不能被降级分支吞掉
  const broken = { ...NO_INDEX_SCHEMA }; delete broken.score_history;
  const bad = await boot({ schema: broken });
  try {
    const r = await bad.call('/api/data-status', { cookie: bad.admin });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'database_unavailable');
    assert.equal(r.body.counts, undefined);
  } finally { await stop(bad); }
});

test('数据中心「事件明细」云端按在线 replay_events 投影（event_date=replay_date，本地专属列如实置空）', async () => {
  const env = await boot();
  try {
    const r = await env.call(`/api/data/admin.events?event_date=${DAY}&order=event_time.asc&limit=20`, { cookie: env.admin });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.table, 'replay_events');
    assert.equal(r.body.total, 3);
    assert.deepEqual(r.body.rows.map(x => x.event_id), ['REPLAY_1', 'REPLAY_2', 'REPLAY_3']);
    for (const row of r.body.rows) {
      assert.equal(row.event_date, DAY, 'event_date 必须等于表中真实 replay_date，不得派生编造');
      assert.equal(row.coordinate_valid, null, '全量原始日志列云端未提供，如实置空');
      assert.equal(row.speed_valid, null);
    }
    assert.ok(r.body.hosted_note.includes('replay_date'), 'hosted_note 应说明日期口径');
    const filtered = await env.call(`/api/data/admin.events?event_date=${DAY}&event_type=41001`, { cookie: env.admin });
    assert.equal(filtered.body.total, 1);
    assert.equal(filtered.body.rows[0].event_id, 'REPLAY_3');
    const paged = await env.call(`/api/data/admin.events?event_date=${DAY}&order=event_time.asc&limit=2&offset=2`, { cookie: env.admin });
    assert.equal(paged.body.total, 3);
    assert.deepEqual(paged.body.rows.map(x => x.event_id), ['REPLAY_3']);
  } finally { await stop(env); }
});

test('R59 事件明细空态补齐：无样本日期返回该日全量索引统计 + 有样本日期（真实云端读数，不补造行）', async () => {
  const env = await boot();
  try {
    // 该车 2026-07-01 无逐条回放样本，但全量索引有真实日聚合
    env.db.tables.local_event_daily.push({ gpsno: '95301325', event_date: '2026-07-01', event_type: '30002', event_name: '左车道偏移', event_count: 7, source_version: SOURCE_VERSION });
    const r = await env.call('/api/data/admin.events?gpsno=95301325&event_date=2026-07-01&limit=20', { cookie: env.admin });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.total, 0);
    assert.ok(r.body.hosted_extras, '空态必须带云端补齐信息');
    assert.equal(r.body.hosted_extras.requested_date, '2026-07-01');
    assert.deepEqual(r.body.hosted_extras.sample_dates, [DAY], '有样本日期来自在线 replay_events 真实回放日');
    assert.equal(r.body.hosted_extras.daily_index.length, 1);
    assert.equal(r.body.hosted_extras.daily_index[0].event_count, 7, 'numeric 字符串须归一为 number');
    // 有样本日期不产生 extras（正常分页路径不受影响）
    const ok = await env.call(`/api/data/admin.events?gpsno=95301325&event_date=${DAY}&limit=20`, { cookie: env.admin });
    assert.equal(ok.body.total, 3);
    assert.equal(ok.body.hosted_extras, undefined);
    // 司机范围：本人车辆 + 索引未导入时 daily_index=null（不假装有统计）
    const mine = await env.call('/api/data/my.events?gpsno=95301325&event_date=2026-07-01&limit=20', { cookie: env.driver });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.total, 0);
    assert.deepEqual(mine.body.hosted_extras.sample_dates, [DAY]);
    assert.equal(mine.body.hosted_extras.daily_index.length, 1);
  } finally { await stop(env); }
});

test('R59 事件明细空态补齐：索引未导入的托管库 daily_index=null（界面如实不展示，不放假统计）', async () => {
  const env = await boot({ schema: NO_INDEX_SCHEMA, index: false });
  try {
    const r = await env.call('/api/data/admin.events?gpsno=95301325&event_date=2026-07-01&limit=20', { cookie: env.admin });
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 0);
    assert.equal(r.body.hosted_extras.daily_index, null, '索引表不存在时不得编造日统计');
    assert.deepEqual(r.body.hosted_extras.sample_dates, [DAY]);
  } finally { await stop(env); }
});

test('导入后：事件日统计/轨迹/IMU/画像都读真实索引行，列名在输出层映射到 UI 契约', async () => {
  const env = await boot();
  try {
    const daily = await env.call(`/api/data/admin.event_daily?event_date=${DAY}`, { cookie: env.admin });
    assert.equal(daily.status, 200, JSON.stringify(daily.body));
    assert.equal(daily.body.table, 'local_event_daily', '必须读导入的全量索引，而不是回放样本聚合');
    assert.equal(daily.body.total, 2);
    assert.deepEqual(Object.fromEntries(daily.body.rows.map(r => [r.event_name, r.event_count])), { 左车道偏移: 12, 疲劳迹象: 5 }, '计数必须来自索引行，不是 883 行样本的 2/1');
    assert.ok(daily.body.rows.every(r => r.driver_id === 'DEMO_D0149'), 'driver_id 按当前 drivers 实时解析');
    assert.ok(daily.body.hosted_note.includes('local_event_daily'));

    const traj = await env.call(`/api/data/admin.trajectory_daily?event_date=${DAY}&order=event_date.desc`, { cookie: env.admin });
    assert.equal(traj.status, 200, JSON.stringify(traj.body));
    assert.equal(traj.body.table, 'local_trajectory_daily');
    assert.equal(traj.body.total, 1);
    const tr = traj.body.rows[0];
    assert.equal(tr.event_date, DAY);
    assert.equal(tr.source_rows, 6846);
    assert.equal(tr.distance_km, 68.00714);
    assert.equal(tr.reported_run_time_hours, tr.run_time_hours, 'UI 契约名 reported_run_time_hours 必须由源列 run_time_hours 映射');
    assert.equal(tr.invalid_coordinate_rows, 3);
    assert.equal(tr.driver_id, 'DEMO_D0149');
    assert.equal(tr.source_version, SOURCE_VERSION);
    assert.ok(traj.body.hosted_note.includes('run_time_hours'), '应说明输出层映射');

    const imu = await env.call(`/api/data/admin.imu_daily?event_date=${DAY}`, { cookie: env.admin });
    assert.equal(imu.status, 200, JSON.stringify(imu.body));
    const ir = imu.body.rows[0];
    assert.equal(ir.source_rows, 31163);
    assert.equal(ir.gps_speed_mean, 27.97);
    assert.equal(ir.accel_norm_outlier_samples, ir.accel_norm_outlier_rows, '异常采样计数映射到 UI 契约名');
    assert.equal(ir.gyro_norm_gt20_samples, 12);
    assert.equal(ir.missing_gps_speed_rows, 14151, '源提供的缺失计数按真名保留');
    assert.equal(ir.missing_accel_rows, null, '本批清洗数据未提供的列如实置空，不拿别的量冒充');
    assert.equal(ir.missing_gyro_rows, null);

    const profiles = await env.call('/api/data/admin.profiles', { cookie: env.admin });
    assert.equal(profiles.status, 200, JSON.stringify(profiles.body));
    assert.equal(profiles.body.table, 'local_profiles');
    assert.equal(profiles.body.total, 1);
    const pr = profiles.body.rows[0];
    assert.equal(pr.energy_type, '电力');
    assert.equal(pr.monthly_mileage_km, 6853.08);
    assert.equal(pr.night_mileage_ratio, 0.0942);
    assert.equal(pr.driver_id, 'DEMO_D0149');
    // 画像与日期无关：不接受 event_date 过滤（避免下发不存在的列）
    const byDate = await env.call(`/api/data/admin.profiles?event_date=${DAY}`, { cookie: env.admin });
    assert.equal(byDate.status, 200, '画像带日期参数也不得 500');
    assert.equal(byDate.body.total, 1);
  } finally { await stop(env); }
});

test('PostgREST 的 numeric 字符串按真实类型归一；像数字的文本列绝不被转数', async () => {
  const env = await boot();
  try {
    // 线上 PostgREST 把 numeric 列回成字符串（如 "2.5544444444444445"），本地 SQLite 回 number：
    // 输出层必须归一，否则同一张表在两种模式显示不一致（前端 fmtCell 只对 number 定宽渲染）
    env.db.tables.local_trajectory_daily.push({ gpsno: '95301325', event_date: '2026-07-01', source_rows: '6846', valid_speed_rows: '6846', invalid_speed_rows: '0', speed_mean_kmh: '11.69723349317595', speed_std_kmh: '19.06', speed_max_kmh: '72', moving_rows: '2512', valid_coordinate_rows: '6845', invalid_coordinate_rows: '1', invalid_course_rows: '0', invalid_distance_rows: '0', large_distance_gap_rows: '0', distance_km: '124.77984', invalid_run_time_rows: '0', run_time_hours: '2.5544444444444445', source_version: SOURCE_VERSION });
    env.db.tables.local_event_daily.push({ gpsno: '95301325', event_date: '2026-07-01', event_type: '030002', event_name: '左车道偏移', event_count: '7', source_version: SOURCE_VERSION });
    const traj = await env.call('/api/data/admin.trajectory_daily?event_date=2026-07-01', { cookie: env.admin });
    assert.equal(traj.status, 200, JSON.stringify(traj.body));
    const tr = traj.body.rows[0];
    assert.equal(typeof tr.source_rows, 'number'); assert.equal(tr.source_rows, 6846);
    assert.equal(tr.distance_km, 124.77984, 'numeric 字符串回转 double 无损');
    assert.equal(tr.reported_run_time_hours, 2.5544444444444445, '映射列同样完成类型归一');
    assert.equal(typeof tr.gpsno, 'string'); assert.equal(tr.gpsno, '95301325', '车辆编号必须保持文本');
    assert.equal(typeof tr.event_date, 'string'); assert.equal(tr.event_date, '2026-07-01', '日期必须保持文本');
    const daily = await env.call('/api/data/admin.event_daily?event_date=2026-07-01', { cookie: env.admin });
    const dr = daily.body.rows[0];
    assert.equal(typeof dr.event_count, 'number'); assert.equal(dr.event_count, 7);
    assert.equal(typeof dr.event_type, 'string'); assert.equal(dr.event_type, '030002', '带前导零的事件码不得被转成数字');
    assert.equal(typeof dr.event_name, 'string');
  } finally { await stop(env); }
});

test('未导入索引：三类明细诚实空态、事件日统计退回样本聚合并标注口径', async () => {
  const env = await boot({ schema: NO_INDEX_SCHEMA });
  try {
    for (const kind of ['trajectory_daily', 'imu_daily', 'profiles']) {
      const r = await env.call(`/api/data/admin.${kind}?event_date=${DAY}`, { cookie: env.admin });
      assert.equal(r.status, 200, `${kind} 应返回诚实空态，实际 ${r.status}`);
      assert.equal(r.body.hosted_unavailable, true);
      assert.deepEqual(r.body.rows, []);
      assert.equal(r.body.total, 0);
      assert.ok(r.body.hosted_note.includes('尚未导入云端在线库'), `${kind} 应说明未导入：${r.body.hosted_note}`);
      assert.ok(r.body.hosted_note.includes('冒充'), `${kind} 应声明不虚构数字`);
    }
    const daily = await env.call(`/api/data/admin.event_daily?event_date=${DAY}`, { cookie: env.admin });
    assert.equal(daily.body.table, 'replay_events', '未导入索引时退回在线样本聚合');
    assert.deepEqual(Object.fromEntries(daily.body.rows.map(r => [r.event_name, r.event_count])), { 左车道偏移: 2, 疲劳迹象: 1 });
    assert.ok(daily.body.hosted_note.includes('尚未导入') && daily.body.hosted_note.includes('不代表完整观测窗'),
      `必须注明是样本口径而非全量：${daily.body.hosted_note}`);
  } finally { await stop(env); }
});

test('建表未灌数（全表 0 行）等价于未导入：不拿"导入索引为空"冒充结论', async () => {
  const env = await boot({ index: false });
  try {
    const traj = await env.call(`/api/data/admin.trajectory_daily?event_date=${DAY}`, { cookie: env.admin });
    assert.equal(traj.status, 200);
    assert.equal(traj.body.hosted_unavailable, true, '空索引应走缺源降级');
    const daily = await env.call(`/api/data/admin.event_daily?event_date=${DAY}`, { cookie: env.admin });
    assert.equal(daily.body.table, 'replay_events');
    const status = await env.call('/api/data-status', { cookie: env.admin });
    assert.equal(status.body.index_imported, false, '无溯源行即视为未导入');
    assert.equal(status.body.counts.trajectory_daily, 0);
  } finally { await stop(env); }
});

test('范围与权限：司机只见本人车辆，未核实绑定拒绝，受限安全员不越车队', async () => {
  const env = await boot();
  try {
    const own = await env.call(`/api/data/my.events?event_date=${DAY}`, { cookie: env.driver });
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(own.body.total, 3);
    assert.ok(own.body.rows.every(row => row.driver_id === 'DEMO_D0149'));
    const myDaily = await env.call(`/api/data/my.event_daily?event_date=${DAY}`, { cookie: env.driver });
    assert.equal(myDaily.status, 200);
    assert.equal(myDaily.body.total, 2);
    assert.ok(myDaily.body.rows.every(row => row.driver_id === 'DEMO_D0149'));
    const myTraj = await env.call(`/api/data/my.trajectory_daily?event_date=${DAY}`, { cookie: env.driver });
    assert.equal(myTraj.status, 200);
    assert.equal(myTraj.body.total, 1, '司机只见本人车辆的日汇总');
    const myProfile = await env.call('/api/data/my.profiles', { cookie: env.driver });
    assert.equal(myProfile.status, 200);
    assert.equal(myProfile.body.total, 1);

    const unbound = await env.call(`/api/data/my.events?event_date=${DAY}`, { cookie: env.unbound });
    assert.equal(unbound.status, 403);
    assert.equal(unbound.body.error, 'binding_not_verified');
    for (const kind of ['my.event_daily', 'my.trajectory_daily', 'my.imu_daily', 'my.profiles']) {
      const r = await env.call(`/api/data/${kind}?event_date=${DAY}`, { cookie: env.unbound });
      assert.equal(r.status, 403, `${kind} 未核实绑定应拒绝`);
      assert.equal(r.body.error, 'binding_not_verified');
    }
    // 司机不得读管理面明细
    for (const kind of ['admin.events', 'admin.event_daily', 'admin.trajectory_daily', 'admin.imu_daily', 'admin.profiles']) {
      assert.equal((await env.call(`/api/data/${kind}?event_date=${DAY}`, { cookie: env.driver })).status, 403, kind);
    }
    // 受限安全员（OTHER_FLEET）在范围内无车：空结果而不是越权数据
    const officerTraj = await env.call(`/api/data/admin.trajectory_daily?event_date=${DAY}`, { cookie: env.officer });
    assert.equal(officerTraj.status, 200);
    assert.equal(officerTraj.body.total, 0);
    const officerDaily = await env.call(`/api/data/admin.event_daily?event_date=${DAY}`, { cookie: env.officer });
    assert.equal(officerDaily.body.total, 0);
    // 受限账号借 fleet_id 参数扩权须被拒
    const escalate = await env.call(`/api/data/admin.trajectory_daily?event_date=${DAY}&fleet_id=DEMO_FLEET`, { cookie: env.officer });
    assert.equal(escalate.status, 403);
    assert.equal(escalate.body.error, 'out_of_fleet_scope');
  } finally { await stop(env); }
});

test('AI 数据分析 analyze_fleet_data(/api/agent/analysis) 云端接入在线库真实统计', async () => {
  const env = await boot();
  try {
    const r = await env.call('/api/agent/analysis', { cookie: env.admin, method: 'POST', body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body;
    assert.equal(d.version, 'original', '云端无权重版本重算通道，评分口径版本如实为发行初始口径');
    assert.equal(d.period.latest_available, '2026-07-31');
    assert.equal(d.period.end, '2026-07-31');
    assert.equal(d.period.start, '2026-07-25');
    assert.equal(d.period.days_available, 7, '周内 7 天真实评分，不补造缺失日期');
    assert.equal(d.count, 1, '期末日按 as_of_date+gpsno 去重：score_history 行被同日 score_snapshots 行覆盖');
    assert.equal(d.average, 72.5, '均分由后端按去重后的期末行真实计算');
    assert.deepEqual(d.level_counts, { A: 0, B: 0, C: 1, D: 0 });
    assert.equal(d.comparison.date, '2026-07-24');
    assert.ok(Array.isArray(d.dimensions) && d.dimensions.length === 6);
    assert.ok(d.dimensions.every(x => typeof x.average_deduction === 'number'));
    assert.ok(d.limitations.some(x => x.includes('云端在线库的发行数据集')), '限制条款必须说明云端统计范围');
    assert.ok(d.limitations.some(x => x.includes('近14天观察窗口')));
    const cd = await env.call('/api/agent/analysis', { cookie: env.admin, method: 'POST', body: { cohort: 'cd' } });
    assert.equal(cd.status, 200); assert.equal(cd.body.cohort, 'cd');
    const bad = await env.call('/api/agent/analysis', { cookie: env.admin, method: 'POST', body: { cohort: 'nonsense' } });
    assert.equal(bad.status, 400); assert.equal(bad.body.error, 'agent_cohort_invalid');
    const badDate = await env.call('/api/agent/analysis', { cookie: env.admin, method: 'POST', body: { end_date: '2026-13-45' } });
    assert.equal(badDate.status, 400); assert.equal(badDate.body.error, 'agent_date_invalid');
    const noData = await env.call('/api/agent/analysis', { cookie: env.admin, method: 'POST', body: { end_date: '2026-06-02' } });
    assert.equal(noData.status, 404); assert.equal(noData.body.error, 'agent_no_data_for_date');
    assert.equal((await env.call('/api/agent/analysis', { cookie: env.driver, method: 'POST', body: {} })).status, 403);
  } finally { await stop(env); }
});

test('AI 周报云端只回后端数字与建议：不产出假附件、不编造下载链接', async () => {
  const env = await boot();
  try {
    const r = await env.call('/api/agent/report', { cookie: env.admin, method: 'POST', body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.artifact, null, '云端没有 agent-store 文件通道，artifact 必须为 null');
    assert.equal(r.body.status, 'ok');
    assert.equal(r.body.data.period.end, '2026-07-31');
    assert.equal(r.body.data.count, 1);
    assert.equal(r.body.data.version, 'original');
    assert.ok(Array.isArray(r.body.data.advice) && r.body.data.advice.length > 0);
    assert.ok(r.body.data.hosted_note.includes('不提供周报'), 'hosted_note 应说明文件产物属本地专属');
    assert.ok(r.body.data_limitations.includes('不要声称已生成文件'), '限制条款应禁止模型谎报附件');
    const artifact = await env.call('/api/agent/artifact?id=plan-does-not-exist&format=html', { cookie: env.admin });
    assert.equal(artifact.status, 503, '下载端点在云端如实拒绝，不返回空文件冒充');
  } finally { await stop(env); }
});
