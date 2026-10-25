DO $$ BEGIN
       ALTER TABLE agents ADD COLUMN sandbox_type VARCHAR(20) DEFAULT 'standard';
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$