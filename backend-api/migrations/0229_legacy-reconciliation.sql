CREATE INDEX IF NOT EXISTS idx_remote_host_user_grants_user
       ON remote_host_user_grants(user_id, remote_host_id)