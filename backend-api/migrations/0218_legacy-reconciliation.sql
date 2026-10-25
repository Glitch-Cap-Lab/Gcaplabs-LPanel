DO $$ BEGIN
       ALTER TABLE remote_hosts ADD COLUMN available_to_all BOOLEAN NOT NULL DEFAULT false;
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$