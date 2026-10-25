DO $$ BEGIN
       ALTER TABLE platform_settings ADD COLUMN dev_jwt_secret TEXT;
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$