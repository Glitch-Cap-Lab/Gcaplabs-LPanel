CREATE INDEX IF NOT EXISTS idx_remote_hosts_owner
       ON remote_hosts(owner_user_id, enabled, is_default, label)