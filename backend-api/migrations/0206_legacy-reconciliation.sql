CREATE TABLE IF NOT EXISTS fleet_migrations (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       initiated_by UUID REFERENCES users(id) ON DELETE SET NULL,
       status TEXT NOT NULL DEFAULT 'pending'
         CHECK (status IN ('pending', 'queued', 'in_progress', 'completed', 'partial_failure', 'rolled_back')),
       source_selection JSONB NOT NULL DEFAULT '{}',
       target_selection JSONB NOT NULL DEFAULT '{}',
       agent_ids JSONB NOT NULL DEFAULT '[]',
       before_state JSONB NOT NULL DEFAULT '{}',
       after_state JSONB NOT NULL DEFAULT '{}',
       errors JSONB NOT NULL DEFAULT '[]',
       dry_run BOOLEAN NOT NULL DEFAULT false,
       notes TEXT,
       started_at TIMESTAMPTZ,
       completed_at TIMESTAMPTZ,
       rolled_back_at TIMESTAMPTZ,
       created_at TIMESTAMPTZ DEFAULT NOW()
     )