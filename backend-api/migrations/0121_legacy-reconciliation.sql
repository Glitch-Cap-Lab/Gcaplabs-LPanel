CREATE TABLE IF NOT EXISTS agent_migrations (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id UUID REFERENCES users(id) ON DELETE CASCADE,
       deployed_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
       name TEXT NOT NULL,
       runtime_family VARCHAR(20) NOT NULL DEFAULT 'openclaw',
       source_kind TEXT NOT NULL DEFAULT 'upload',
       source_transport TEXT,
       status TEXT NOT NULL DEFAULT 'ready',
       summary JSONB DEFAULT '{}',
       warnings JSONB DEFAULT '[]',
       encrypted_manifest TEXT NOT NULL,
       created_at TIMESTAMPTZ DEFAULT NOW(),
       expires_at TIMESTAMPTZ
     )