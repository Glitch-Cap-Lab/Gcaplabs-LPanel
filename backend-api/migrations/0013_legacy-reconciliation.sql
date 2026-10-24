CREATE TABLE IF NOT EXISTS channels (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
       type VARCHAR(30) NOT NULL,
       name VARCHAR(100) NOT NULL,
       config JSONB NOT NULL DEFAULT '{}',
       enabled BOOLEAN DEFAULT true,
       created_at TIMESTAMPTZ DEFAULT NOW()
     )