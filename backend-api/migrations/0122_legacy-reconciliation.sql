CREATE INDEX IF NOT EXISTS idx_agent_migrations_user_created
       ON agent_migrations(user_id, created_at DESC)