UPDATE agent_hub_listings
        SET local_visibility = CASE
          WHEN source_type = 'platform' OR status = 'published' THEN 'internal'
          ELSE 'owner'
        END
      WHERE local_visibility IS NULL