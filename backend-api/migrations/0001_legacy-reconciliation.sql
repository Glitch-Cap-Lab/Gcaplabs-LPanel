DO $$ BEGIN
       ALTER TABLE agents ADD COLUMN backend_type VARCHAR(20) NOT NULL DEFAULT 'docker';
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$