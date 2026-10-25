UPDATE agent_hub_listings
        SET central_share_status = 'not_shared'
      WHERE central_share_status IS NULL