DO $$ BEGIN
       ALTER TABLE integrations ADD COLUMN config JSONB DEFAULT '{}';
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$