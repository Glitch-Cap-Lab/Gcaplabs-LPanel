CREATE TABLE IF NOT EXISTS remote_host_group_grants (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       remote_host_id TEXT NOT NULL REFERENCES remote_hosts(id) ON DELETE CASCADE,
       group_id UUID NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
       created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
       created_at TIMESTAMPTZ DEFAULT NOW(),
       UNIQUE(remote_host_id, group_id)
     )