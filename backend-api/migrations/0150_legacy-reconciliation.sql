UPDATE agent_hub_listings
        SET source_type = CASE WHEN COALESCE(built_in, false) THEN 'platform' ELSE 'community' END
      WHERE source_type IS NULL