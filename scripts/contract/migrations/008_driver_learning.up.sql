-- Driver learning extension. Required for new assignments and persistent self-check.
-- Does not alter scores, risk facts or historical learning_record text.
ALTER TABLE training_tasks ADD COLUMN IF NOT EXISTS course_snapshot jsonb;
ALTER TABLE training_tasks ADD COLUMN IF NOT EXISTS learning_progress jsonb;
COMMENT ON COLUMN training_tasks.course_snapshot IS 'Approved course content/version captured at assignment; legacy tasks may capture at first learning save, distinguished by captured_stage';
COMMENT ON COLUMN training_tasks.learning_progress IS 'System-use self-check v1 answers and server-calculated result; does not replace staff review';
