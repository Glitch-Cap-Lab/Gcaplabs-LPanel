CREATE INDEX IF NOT EXISTS idx_agent_secret_overrides_agent
       ON agent_secret_overrides(agent_id, env_key)