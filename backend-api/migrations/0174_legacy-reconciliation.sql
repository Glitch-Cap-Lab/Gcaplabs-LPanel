CREATE TABLE IF NOT EXISTS workspaces (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id UUID REFERENCES users(id) ON DELETE CASCADE,
       name TEXT NOT NULL,
       created_at TIMESTAMP DEFAULT NOW()
     )