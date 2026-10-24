CREATE INDEX IF NOT EXISTS idx_user_group_members_user
       ON user_group_members(user_id, group_id)