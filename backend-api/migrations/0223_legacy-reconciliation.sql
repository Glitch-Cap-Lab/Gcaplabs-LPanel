CREATE INDEX IF NOT EXISTS idx_remote_hosts_platform
       ON remote_hosts(management_scope, available_to_all, enabled, is_default, label)