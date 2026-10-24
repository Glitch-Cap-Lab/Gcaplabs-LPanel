CREATE TABLE IF NOT EXISTS workspace_remote_hosts (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
       remote_host_id TEXT REFERENCES remote_hosts(id) ON DELETE CASCADE,
       created_by UUID REFERENCES users(id) ON DELETE SET NULL,
       created_at TIMESTAMP DEFAULT NOW(),
       UNIQUE(workspace_id, remote_host_id)
     )