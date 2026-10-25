INSERT INTO workspace_members (workspace_id, user_id, role)
       SELECT id, user_id, 'owner' FROM workspaces WHERE user_id IS NOT NULL
       ON CONFLICT (workspace_id, user_id) DO NOTHING