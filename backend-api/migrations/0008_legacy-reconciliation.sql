CREATE TABLE IF NOT EXISTS integration_oauth_states (
       state TEXT PRIMARY KEY,
       provider VARCHAR(50) NOT NULL,
       user_id UUID REFERENCES users(id) ON DELETE CASCADE,
       agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
       code_verifier TEXT NOT NULL,
       client_id TEXT,
       client_secret TEXT,
       config JSONB NOT NULL DEFAULT '{}',
       redirect_path TEXT,
       created_at TIMESTAMPTZ DEFAULT NOW(),
       expires_at TIMESTAMPTZ NOT NULL
     )