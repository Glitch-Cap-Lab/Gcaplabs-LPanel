CREATE TABLE IF NOT EXISTS llm_providers (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id UUID REFERENCES users(id) ON DELETE CASCADE,
       provider VARCHAR(30) NOT NULL,
       api_key TEXT,
       model VARCHAR(100),
       config JSONB DEFAULT '{}',
       is_default BOOLEAN DEFAULT false,
       created_at TIMESTAMPTZ DEFAULT NOW()
     )