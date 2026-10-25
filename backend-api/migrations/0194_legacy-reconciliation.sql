CREATE TABLE IF NOT EXISTS workspace_budgets (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
       period TEXT NOT NULL DEFAULT 'monthly'
         CHECK (period IN ('daily', 'weekly', 'monthly')),
       limit_usd NUMERIC(12, 2) NOT NULL,
       soft_threshold_pct INTEGER NOT NULL DEFAULT 80
         CHECK (soft_threshold_pct BETWEEN 0 AND 100),
       last_alerted_at TIMESTAMPTZ,
       last_alerted_pct INTEGER,
       created_at TIMESTAMPTZ DEFAULT NOW(),
       updated_at TIMESTAMPTZ DEFAULT NOW(),
       UNIQUE(workspace_id, period)
     )