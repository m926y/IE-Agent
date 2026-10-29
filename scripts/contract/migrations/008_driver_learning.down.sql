-- Destructive rollback: export these two columns before applying.
ALTER TABLE training_tasks DROP COLUMN IF EXISTS learning_progress;
ALTER TABLE training_tasks DROP COLUMN IF EXISTS course_snapshot;
