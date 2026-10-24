DO $$ BEGIN
       ALTER TABLE agents ADD COLUMN gateway_token TEXT;
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$