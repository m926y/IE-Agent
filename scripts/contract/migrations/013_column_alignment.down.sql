DROP TABLE IF EXISTS evaluation_actions; DROP TABLE IF EXISTS evaluation_training_plans;
ALTER TABLE training_tasks DROP COLUMN IF EXISTS stratification_plan_id;
ALTER TABLE handover_reports DROP COLUMN IF EXISTS accepted_at; ALTER TABLE handover_reports DROP COLUMN IF EXISTS accepted_note;
