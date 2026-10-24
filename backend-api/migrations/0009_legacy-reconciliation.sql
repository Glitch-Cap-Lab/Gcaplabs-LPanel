DO $$ BEGIN
       ALTER TABLE integration_oauth_states ADD COLUMN client_id TEXT;
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$