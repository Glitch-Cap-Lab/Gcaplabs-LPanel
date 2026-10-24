CREATE TABLE IF NOT EXISTS agent_schedules (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
       created_by UUID REFERENCES users(id) ON DELETE SET NULL,
       name TEXT NOT NULL,
       cron TEXT NOT NULL,
       timezone TEXT NOT NULL DEFAULT 'UTC',
       action_type TEXT NOT NULL DEFAULT 'prompt'
         CHECK (action_type IN ('prompt', 'restart', 'stop', 'start', 'redeploy')),
       prompt TEXT,
       enabled BOOLEAN NOT NULL DEFAULT TRUE,
       last_run_at TIMESTAMPTZ,
       last_status TEXT,
       next_run_at TIMESTAMPTZ,
       created_at TIMESTAMPTZ DEFAULT NOW(),
       updated_at TIMESTAMPTZ DEFAULT NOW()
     )