DO $$ BEGIN
       ALTER TABLE agents ADD COLUMN deploy_target VARCHAR(20);
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$