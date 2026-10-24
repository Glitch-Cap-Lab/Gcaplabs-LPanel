CREATE TABLE IF NOT EXISTS snapshots (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       agent_id UUID,
       name TEXT NOT NULL,
       description TEXT,
       kind TEXT DEFAULT 'snapshot',
       template_key TEXT,
       built_in BOOLEAN DEFAULT false,
       config JSONB DEFAULT '{}',
       created_at TIMESTAMP DEFAULT NOW()
     )