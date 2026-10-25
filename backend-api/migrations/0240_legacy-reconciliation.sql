CREATE TABLE IF NOT EXISTS hermes_skills_library (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       ref TEXT UNIQUE NOT NULL,
       name TEXT NOT NULL,
       description TEXT DEFAULT '',
       added_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
       created_at TIMESTAMPTZ DEFAULT NOW()
     )