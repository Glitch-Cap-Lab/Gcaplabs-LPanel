DO $$ BEGIN
       ALTER TABLE remote_hosts ADD COLUMN created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$