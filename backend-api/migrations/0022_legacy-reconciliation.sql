DO $$ BEGIN
       ALTER TABLE agents ADD COLUMN network_policy_status JSONB;
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$