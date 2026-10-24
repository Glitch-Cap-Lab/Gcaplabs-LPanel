DO $$ BEGIN
       ALTER TABLE remote_hosts ADD COLUMN access_version BIGINT NOT NULL DEFAULT 1;
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$