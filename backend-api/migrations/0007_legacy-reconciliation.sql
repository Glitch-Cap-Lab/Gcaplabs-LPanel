DO $$ BEGIN
       ALTER TABLE integrations ADD COLUMN mailbox_state JSONB DEFAULT NULL;
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$