CREATE INDEX IF NOT EXISTS idx_remote_host_group_grants_group
       ON remote_host_group_grants(group_id, remote_host_id)