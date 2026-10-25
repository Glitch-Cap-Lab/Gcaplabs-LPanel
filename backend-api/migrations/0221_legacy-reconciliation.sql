DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conname = 'remote_hosts_management_scope_check'
            AND conrelid = 'remote_hosts'::regclass
       ) THEN
         ALTER TABLE remote_hosts
           ADD CONSTRAINT remote_hosts_management_scope_check
           CHECK (management_scope IN ('user', 'platform'));
       END IF;
     END $$