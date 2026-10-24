DO $$ BEGIN
       ALTER TABLE agents ADD COLUMN sandbox_profile VARCHAR(20);
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$