CREATE TABLE IF NOT EXISTS usage_metrics (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
       user_id UUID REFERENCES users(id) ON DELETE CASCADE,
       metric_type VARCHAR(50) NOT NULL,
       value NUMERIC NOT NULL DEFAULT 0,
       metadata JSONB DEFAULT '{}',
       recorded_at TIMESTAMPTZ DEFAULT NOW()
     )