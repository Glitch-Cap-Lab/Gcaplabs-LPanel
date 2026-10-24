DO $$ BEGIN
       ALTER TABLE agents ADD COLUMN dashboard_port INTEGER;
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$