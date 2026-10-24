CREATE INDEX IF NOT EXISTS idx_integration_oauth_states_expires
       ON integration_oauth_states(expires_at)