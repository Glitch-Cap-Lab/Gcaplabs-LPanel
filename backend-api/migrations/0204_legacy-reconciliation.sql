CREATE TABLE IF NOT EXISTS agent_versions (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
       version_number INTEGER NOT NULL,
       config JSONB NOT NULL DEFAULT '{}',
       created_by UUID REFERENCES users(id) ON DELETE SET NULL,
       message TEXT,
       source TEXT NOT NULL DEFAULT 'edit'
         CHECK (source IN ('edit', 'deploy', 'redeploy', 'duplicate', 'hub-install', 'restore', 'rollback')),
       created_at TIMESTAMPTZ DEFAULT NOW(),
       UNIQUE(agent_id, version_number)
     )