DO $$ BEGIN
       ALTER TABLE agents ADD COLUMN execution_target_id TEXT;
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$