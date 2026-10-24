DO $$ BEGIN
       ALTER TABLE integrations ADD COLUMN catalog_id VARCHAR(50) REFERENCES integration_catalog(id);
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$