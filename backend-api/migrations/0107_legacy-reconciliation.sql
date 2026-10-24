CREATE TABLE IF NOT EXISTS backup_schedules (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       schedule_key TEXT NOT NULL UNIQUE,
       kind TEXT NOT NULL DEFAULT 'agent',
       user_id UUID REFERENCES users(id) ON DELETE CASCADE,
       agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
       enabled BOOLEAN NOT NULL DEFAULT false,
       name TEXT,
       frequency TEXT NOT NULL DEFAULT 'daily',
       hour_utc INTEGER NOT NULL DEFAULT 2,
       day_of_week INTEGER NOT NULL DEFAULT 0,
       next_run_at TIMESTAMPTZ,
       last_run_at TIMESTAMPTZ,
       last_backup_id UUID REFERENCES backups(id) ON DELETE SET NULL,
       last_error TEXT,
       created_by UUID REFERENCES users(id) ON DELETE SET NULL,
       created_at TIMESTAMPTZ DEFAULT NOW(),
       updated_at TIMESTAMPTZ DEFAULT NOW()
     )