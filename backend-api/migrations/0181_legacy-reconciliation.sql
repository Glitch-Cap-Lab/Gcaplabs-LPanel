CREATE TABLE IF NOT EXISTS workspace_members (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
       user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       role TEXT NOT NULL DEFAULT 'viewer'
         CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
       invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
       created_at TIMESTAMPTZ DEFAULT NOW(),
       UNIQUE(workspace_id, user_id)
     )