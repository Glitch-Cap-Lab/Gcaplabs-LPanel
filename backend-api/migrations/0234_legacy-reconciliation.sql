CREATE TABLE IF NOT EXISTS remote_host_id_tombstones (
       remote_host_id TEXT PRIMARY KEY,
       management_scope TEXT NOT NULL CHECK (management_scope IN ('user', 'platform')),
       deleted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
       deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )