-- 018（第60轮）：AI 聊天附件云端化 + 聊天待确认清单（action plan）云端化。
-- 本地完整版把附件解析文本放在 var/ai-uploads、清单放在 SQLite agent_plans；托管运行时是临时的、
-- 且平台红线禁止把上传文件字节写进数据库（无 bytea），因此云端只持久化"解析后的纯文本 + 表格行 + 元数据"，
-- 原始文件字节永不入库（界面与诚实限制文案已说明：云端不能重新下载原文件、不能二次解析）。
-- 24h 过期由 expires_at 承担，读取时惰性清理；清单 30 分钟过期，人工确认才执行（AI 零写库红线不变）。
-- 不做 RENAME/DO$$（WAF 教训）；纯 CREATE。
CREATE TABLE IF NOT EXISTS ai_chat_uploads(upload_id text PRIMARY KEY,owner_user_id text NOT NULL,name text NOT NULL,kind text NOT NULL,kind_label text,extension text,size_bytes BIGINT,chars BIGINT,truncated BOOLEAN NOT NULL DEFAULT false,text_content text,rows_json text,created_at text NOT NULL,expires_at text NOT NULL);
CREATE INDEX IF NOT EXISTS ai_chat_uploads_owner_idx ON ai_chat_uploads(owner_user_id,expires_at);
CREATE INDEX IF NOT EXISTS ai_chat_uploads_expiry_idx ON ai_chat_uploads(expires_at);
CREATE TABLE IF NOT EXISTS ai_action_plans(plan_id text PRIMARY KEY,owner_user_id text NOT NULL,owner_scope text,kind text NOT NULL,state text NOT NULL,source text,payload_json text,preview_json text,result_json text,created_at text NOT NULL,expires_at text NOT NULL);
CREATE INDEX IF NOT EXISTS ai_action_plans_owner_idx ON ai_action_plans(owner_user_id,state,expires_at);
