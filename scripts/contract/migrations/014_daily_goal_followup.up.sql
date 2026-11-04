-- 014（第51轮，V43）：司机安全简报面板云端补齐。目标求助的管理处置三列（对齐本地 driver-integration
-- driver_safety_goals.handled_at/handled_by/handled_note 语义；第49轮云端动作中心曾以 status='active' 等价
-- 未处置，本轮补真实列后改回 !handled_at 判定）。只做无争议 ADD COLUMN，不含 RENAME/DO$$（WAF 拦截教训见 R50）。
ALTER TABLE driver_safety_goals ADD COLUMN IF NOT EXISTS handled_at text;
ALTER TABLE driver_safety_goals ADD COLUMN IF NOT EXISTS handled_by text;
ALTER TABLE driver_safety_goals ADD COLUMN IF NOT EXISTS handled_note text;
