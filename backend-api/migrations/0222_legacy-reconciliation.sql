DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conname = 'remote_hosts_scope_owner_check'
            AND conrelid = 'remote_hosts'::regclass
       ) THEN
         ALTER TABLE remote_hosts
           ADD CONSTRAINT remote_hosts_scope_owner_check CHECK (
             (management_scope = 'user' AND owner_user_id IS NOT NULL AND available_to_all = false)
             OR (management_scope = 'platform' AND owner_user_id IS NULL)
           );
       END IF;
     END $$