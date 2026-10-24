DO $$ BEGIN
       ALTER TABLE agents ADD COLUMN runtime_family VARCHAR(20);
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$