CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_agents_unique
       ON workspace_agents(workspace_id, agent_id)