UPDATE agents
        SET runtime_family = CASE
          WHEN backend_type = 'hermes' THEN 'hermes'
          ELSE 'openclaw'
        END
      WHERE runtime_family IS NULL OR BTRIM(runtime_family) = ''