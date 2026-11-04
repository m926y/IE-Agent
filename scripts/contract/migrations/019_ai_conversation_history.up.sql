-- 每个登录账号一份完整 AI 助手会话快照；由服务端按当前会话身份读写。
-- 仅新增独立表，兼容平台迁移入口。
CREATE TABLE IF NOT EXISTS ai_conversation_history(owner_user_id text PRIMARY KEY,snapshot_json text NOT NULL,version_no BIGINT NOT NULL DEFAULT 1,updated_at text NOT NULL);
