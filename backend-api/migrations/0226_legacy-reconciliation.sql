CREATE TABLE IF NOT EXISTS user_group_members (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       group_id UUID NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
       user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
       created_at TIMESTAMPTZ DEFAULT NOW(),
       UNIQUE(group_id, user_id)
     )