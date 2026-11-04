-- 012：动作中心云端化两支撑表（=本地 action-center.mjs 启动 DDL 的 PG 等价；idempotent）
-- note: 'audit:'/'report:' 类合成通知的已读、以及用户移除的聚合条目（notes+todos 共用）。
CREATE TABLE IF NOT EXISTS action_center_reads(user_id text NOT NULL, notification_id text NOT NULL, read_at text, PRIMARY KEY(user_id, notification_id));
CREATE TABLE IF NOT EXISTS action_center_hidden(user_id text NOT NULL, item_id text NOT NULL, hidden_at text, PRIMARY KEY(user_id, item_id));
