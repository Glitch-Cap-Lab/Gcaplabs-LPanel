DO $$ BEGIN
       ALTER TABLE agents ADD COLUMN mcp_servers JSONB DEFAULT '[]';
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$