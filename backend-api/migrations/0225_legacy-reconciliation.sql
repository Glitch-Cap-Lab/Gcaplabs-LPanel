CREATE UNIQUE INDEX IF NOT EXISTS idx_user_groups_name_unique
       ON user_groups(LOWER(name))