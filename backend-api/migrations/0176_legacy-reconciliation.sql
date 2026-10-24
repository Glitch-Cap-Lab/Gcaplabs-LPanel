DELETE FROM workspace_agents a
       USING workspace_agents b
      WHERE a.ctid < b.ctid
        AND a.workspace_id = b.workspace_id
        AND a.agent_id = b.agent_id