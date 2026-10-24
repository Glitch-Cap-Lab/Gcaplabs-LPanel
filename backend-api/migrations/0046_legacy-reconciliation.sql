DO $$ BEGIN
       ALTER TABLE remote_hosts ADD COLUMN ssh_host_key TEXT;
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$