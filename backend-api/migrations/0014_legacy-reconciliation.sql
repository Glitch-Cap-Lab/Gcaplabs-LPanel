CREATE TABLE IF NOT EXISTS channel_messages (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
       direction VARCHAR(10) NOT NULL,
       content TEXT NOT NULL,
       metadata JSONB DEFAULT '{}',
       created_at TIMESTAMPTZ DEFAULT NOW()
     )