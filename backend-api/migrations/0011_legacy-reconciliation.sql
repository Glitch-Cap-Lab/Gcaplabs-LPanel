DO $$ BEGIN
       ALTER TABLE integration_oauth_states ADD COLUMN config JSONB NOT NULL DEFAULT '{}';
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$