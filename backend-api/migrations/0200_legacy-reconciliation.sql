DO $$ BEGIN
       ALTER TABLE agents ADD COLUMN paused_reason TEXT;
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$