DO $$ BEGIN
       ALTER TABLE integrations ADD COLUMN cron_job_id TEXT;
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$