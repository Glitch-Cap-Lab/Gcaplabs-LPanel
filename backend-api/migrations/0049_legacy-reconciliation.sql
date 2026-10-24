DO $$ BEGIN
       ALTER TABLE gateway_port_allocations ADD COLUMN purpose TEXT NOT NULL DEFAULT 'gateway';
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$