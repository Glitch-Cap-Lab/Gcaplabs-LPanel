CREATE TABLE IF NOT EXISTS agent_hub_api_keys (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id UUID REFERENCES users(id) ON DELETE CASCADE,
       label TEXT NOT NULL,
       key_hash TEXT NOT NULL UNIQUE,
       key_prefix TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'active',
       last_used_at TIMESTAMP,
       revoked_at TIMESTAMP,
       created_at TIMESTAMP DEFAULT NOW()
     )