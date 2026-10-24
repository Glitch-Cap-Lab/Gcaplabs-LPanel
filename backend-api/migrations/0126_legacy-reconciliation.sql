CREATE TABLE IF NOT EXISTS hermes_runtime_state (
       agent_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
       model_config JSONB DEFAULT '{}',
       channel_configs JSONB DEFAULT '{}',
       created_at TIMESTAMPTZ DEFAULT NOW(),
       updated_at TIMESTAMPTZ DEFAULT NOW()
     )