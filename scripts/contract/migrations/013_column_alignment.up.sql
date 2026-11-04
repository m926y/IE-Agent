-- 013（第50轮，V42）：与交付模块 UI 契约对齐。注：平台 WAF 会拦截含 DO$$/RENAME 的语句（punish 页），
-- 故云端列名保持 trigger_kind，由宿主输出层映射为 UI 所需 trigger；此处只做无争议的加列与建表。
ALTER TABLE handover_reports ADD COLUMN IF NOT EXISTS accepted_at text;
ALTER TABLE handover_reports ADD COLUMN IF NOT EXISTS accepted_note text;
CREATE TABLE IF NOT EXISTS evaluation_actions(id text PRIMARY KEY,driver_id text,gpsno text,score_version text,risk_level text,kind text,content text,actor_id text,created_at text);
CREATE TABLE IF NOT EXISTS evaluation_training_plans(id text PRIMARY KEY,owner text,driver_id text,gpsno text,score_version text,risk_level text,due_at text,created_at text,payload text,status text,result text);
ALTER TABLE training_tasks ADD COLUMN IF NOT EXISTS stratification_plan_id text;
