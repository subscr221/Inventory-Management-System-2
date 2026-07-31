DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_pick_line_cross_dock_task'
      AND conrelid = 'pick_line'::regclass
  ) THEN
    ALTER TABLE pick_line
      ADD CONSTRAINT fk_pick_line_cross_dock_task
      FOREIGN KEY (cross_dock_task_id) REFERENCES cross_dock_task(cross_dock_task_id);
  END IF;
END $$;
