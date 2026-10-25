UPDATE agent_hub_listings
        SET published_at = COALESCE(published_at, created_at, NOW())
      WHERE status = 'published' AND published_at IS NULL