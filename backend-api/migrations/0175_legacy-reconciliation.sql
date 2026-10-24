CREATE TABLE IF NOT EXISTS workspace_agents (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
       agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
       role TEXT DEFAULT 'member',
       created_at TIMESTAMP DEFAULT NOW()
     )