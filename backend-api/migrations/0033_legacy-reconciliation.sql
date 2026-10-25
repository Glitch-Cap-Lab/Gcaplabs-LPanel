UPDATE agents
        SET sandbox_type = CASE
          WHEN sandbox_profile = 'nemoclaw' THEN 'nemoclaw'
          ELSE 'standard'
        END
      WHERE runtime_family IS NOT NULL
        AND sandbox_profile IS NOT NULL
        AND sandbox_type IS DISTINCT FROM CASE
          WHEN sandbox_profile = 'nemoclaw' THEN 'nemoclaw'
          ELSE 'standard'
        END