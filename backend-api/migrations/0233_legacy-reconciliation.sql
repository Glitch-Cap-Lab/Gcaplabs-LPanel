DO $$ BEGIN
       ALTER TABLE user_groups ADD COLUMN members_version BIGINT NOT NULL DEFAULT 1;
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$