DO $$ BEGIN
       ALTER TABLE remote_hosts ADD COLUMN management_scope TEXT NOT NULL DEFAULT 'user';
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$