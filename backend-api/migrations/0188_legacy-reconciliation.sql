CREATE TABLE IF NOT EXISTS api_keys (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
       created_by UUID REFERENCES users(id) ON DELETE SET NULL,
       label TEXT NOT NULL,
       key_hash TEXT NOT NULL UNIQUE,
       key_prefix TEXT NOT NULL,
       scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
       status TEXT NOT NULL DEFAULT 'active'
         CHECK (status IN ('active', 'revoked')),
       expires_at TIMESTAMPTZ,
       last_used_at TIMESTAMPTZ,
       revoked_at TIMESTAMPTZ,
       created_at TIMESTAMPTZ DEFAULT NOW()
     )