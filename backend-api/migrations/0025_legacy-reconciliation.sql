UPDATE agents
        SET sandbox_profile = CASE
          WHEN sandbox_type = 'nemoclaw' THEN 'nemoclaw'
          WHEN backend_type = 'nemoclaw' THEN 'nemoclaw'
          ELSE 'standard'
        END
      WHERE sandbox_profile IS NULL OR BTRIM(sandbox_profile) = ''