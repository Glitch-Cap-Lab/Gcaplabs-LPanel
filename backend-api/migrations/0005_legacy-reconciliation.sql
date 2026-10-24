DO $$ BEGIN
       ALTER TABLE integrations ADD COLUMN status VARCHAR(20) DEFAULT 'active';
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$