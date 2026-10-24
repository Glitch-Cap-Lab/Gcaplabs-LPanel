UPDATE remote_hosts
        SET management_scope = 'user',
            created_by_user_id = COALESCE(created_by_user_id, owner_user_id),
            available_to_all = false
      WHERE management_scope IS NULL OR management_scope = 'user'