CREATE INDEX IF NOT EXISTS idx_agent_schedules_due
       ON agent_schedules(next_run_at) WHERE enabled