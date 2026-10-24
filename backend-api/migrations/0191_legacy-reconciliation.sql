CREATE TABLE IF NOT EXISTS alert_rules (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
       created_by UUID REFERENCES users(id) ON DELETE SET NULL,
       name TEXT NOT NULL,
       event_pattern TEXT NOT NULL,
       channels JSONB NOT NULL DEFAULT '[]'::jsonb,
       enabled BOOLEAN NOT NULL DEFAULT true,
       last_fired_at TIMESTAMPTZ,
       last_error TEXT,
       created_at TIMESTAMPTZ DEFAULT NOW(),
       updated_at TIMESTAMPTZ DEFAULT NOW()
     )