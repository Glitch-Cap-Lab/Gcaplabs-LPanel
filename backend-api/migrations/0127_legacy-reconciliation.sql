CREATE TABLE IF NOT EXISTS openclaw_channel_state (
       agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
       channel_id TEXT NOT NULL,
       config_encrypted TEXT NOT NULL,
       created_at TIMESTAMPTZ DEFAULT NOW(),
       updated_at TIMESTAMPTZ DEFAULT NOW(),
       PRIMARY KEY (agent_id, channel_id)
     )