UPDATE agent_hub_listings
        SET status = CASE WHEN COALESCE(built_in, false) THEN 'published' ELSE 'pending_review' END
      WHERE status IS NULL