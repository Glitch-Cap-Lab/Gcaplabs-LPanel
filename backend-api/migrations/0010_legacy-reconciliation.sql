DO $$ BEGIN
       ALTER TABLE integration_oauth_states ADD COLUMN client_secret TEXT;
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$