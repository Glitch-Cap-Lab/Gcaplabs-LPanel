CREATE TABLE IF NOT EXISTS workspace_invitations (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
       email TEXT NOT NULL,
       role TEXT NOT NULL DEFAULT 'viewer'
         CHECK (role IN ('admin', 'editor', 'viewer')),
       token_hash TEXT NOT NULL UNIQUE,
       invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
       status TEXT NOT NULL DEFAULT 'pending'
         CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
       accepted_by UUID REFERENCES users(id) ON DELETE SET NULL,
       accepted_at TIMESTAMPTZ,
       expires_at TIMESTAMPTZ NOT NULL,
       created_at TIMESTAMPTZ DEFAULT NOW()
     )