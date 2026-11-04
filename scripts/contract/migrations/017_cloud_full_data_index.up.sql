-- 017（第57轮，V50）：云端全量数据索引补齐——属主提供 2026-09-21 处理后的清洗数据
-- （processed/cleaned：vehicle_profile 500 车、trajectory_daily 28,827 车·日、imu_daily 14,836 车·日、
-- risk_events 3,152,654 条事件、vehicle_day 28,847 车·日；观测窗 2026-06-01 至 2026-07-31，500 车与
-- 云端 drivers/vehicle_labels/score_snapshots 的 gpsno 交集 500/500）。
-- 这四张表在托管库里沿用本地全量索引的契约名（local_*），使本地与云端共用同一套 RESOURCE_DEFS 资源名；
-- 内容由 scripts/import-cloud-index.py 导入，原始数据不进 Git（红线：发行数据经 Release 附件提供）。
-- 列名保持清洗数据的真实来源名（run_time_hours / accel_norm_outlier_rows / gps_speed_max 等），
-- 与 UI 契约名不同处一律在宿主输出层映射（R50 教训：WAF 拦 RENAME/DO$$，且不得为迁就 UI 而重命名事实列）。
-- vehicle_day.parquet 不导入：其 28,847 车·日 = trajectory_daily ∪ imu_daily，零独有事实行（已核验）。
-- risk_events.parquet（3,152,654 条）不整表导入：仅导入其按 车辆×日×事件类型 的真实日聚合（198,873 行），
-- 原始逐条日志留在发行包（云端「事件明细」仍为已发行的回放日样本，界面如实标注）。
-- 不做 RENAME/DO$$；不含任何 UPDATE/DELETE。
CREATE TABLE IF NOT EXISTS local_profiles(
  gpsno text NOT NULL PRIMARY KEY,
  energy_type text,
  monthly_mileage_km numeric,
  monthly_drive_hours numeric,
  monthly_stop_count numeric,
  highway_mileage_ratio numeric,
  morning_drive_time_ratio numeric,
  dusk_drive_time_ratio numeric,
  night_drive_time_ratio numeric,
  night_mileage_ratio numeric,
  source_version text
);
CREATE TABLE IF NOT EXISTS local_trajectory_daily(
  gpsno text NOT NULL,
  event_date date NOT NULL,
  source_rows bigint,
  valid_speed_rows bigint,
  invalid_speed_rows bigint,
  speed_mean_kmh numeric,
  speed_std_kmh numeric,
  speed_max_kmh numeric,
  moving_rows bigint,
  valid_coordinate_rows bigint,
  invalid_coordinate_rows bigint,
  invalid_course_rows bigint,
  invalid_distance_rows bigint,
  large_distance_gap_rows bigint,
  distance_km numeric,
  invalid_run_time_rows bigint,
  run_time_hours numeric,
  source_version text,
  PRIMARY KEY (gpsno, event_date)
);
CREATE INDEX IF NOT EXISTS local_trajectory_daily_date_idx ON local_trajectory_daily(event_date, gpsno);
CREATE TABLE IF NOT EXISTS local_imu_daily(
  gpsno text NOT NULL,
  event_date date NOT NULL,
  source_rows bigint,
  imei_count bigint,
  date_mismatch_rows bigint,
  missing_ems_speed_rows bigint,
  missing_gps_speed_rows bigint,
  ems_speed_mean numeric,
  ems_speed_max numeric,
  gps_speed_mean numeric,
  gps_speed_max numeric,
  ems_gps_abs_diff_mean numeric,
  accel_x_mean numeric,
  accel_x_std numeric,
  accel_x_abs_max numeric,
  accel_y_mean numeric,
  accel_y_std numeric,
  accel_y_abs_max numeric,
  accel_z_mean numeric,
  accel_z_std numeric,
  accel_z_abs_max numeric,
  accel_norm_mean numeric,
  accel_norm_std numeric,
  accel_norm_max numeric,
  gyro_x_mean numeric,
  gyro_x_std numeric,
  gyro_x_abs_max numeric,
  gyro_y_mean numeric,
  gyro_y_std numeric,
  gyro_y_abs_max numeric,
  gyro_z_mean numeric,
  gyro_z_std numeric,
  gyro_z_abs_max numeric,
  gyro_norm_mean numeric,
  gyro_norm_std numeric,
  gyro_norm_max numeric,
  accel_norm_outlier_rows bigint,
  gyro_norm_gt20_rows bigint,
  source_version text,
  PRIMARY KEY (gpsno, event_date)
);
CREATE INDEX IF NOT EXISTS local_imu_daily_date_idx ON local_imu_daily(event_date, gpsno);
CREATE TABLE IF NOT EXISTS local_event_daily(
  gpsno text NOT NULL,
  event_date date NOT NULL,
  event_type text NOT NULL,
  event_name text NOT NULL,
  event_count bigint NOT NULL,
  source_version text,
  PRIMARY KEY (gpsno, event_date, event_type, event_name)
);
CREATE INDEX IF NOT EXISTS local_event_daily_date_idx ON local_event_daily(event_date, gpsno);
-- 全量索引溯源：一批数据集一行（主键 = source_version）。运行时由数据状态面板读出，
-- 使"这些数字来自哪批清洗数据、覆盖哪个观测窗、源有多少行"随数据一起入库，
-- 而不是把数字硬编码在服务端文案里（换批数据即失效=谎报风险）。
CREATE TABLE IF NOT EXISTS local_index_provenance(
  source_version text PRIMARY KEY,
  dataset text,
  observation_start date,
  observation_end date,
  vehicle_count integer,
  source_event_rows bigint,
  source_trajectory_rows bigint,
  source_imu_rows bigint,
  profile_rows integer,
  trajectory_daily_rows integer,
  imu_daily_rows integer,
  event_daily_groups integer,
  quality_report_at text,
  imported_at text,
  imported_by text,
  notes text
);
