UPDATE agent_hub_listings
        SET share_target = CASE
          WHEN source_type = 'platform' THEN 'internal'
          ELSE 'internal'
        END
      WHERE share_target IS NULL