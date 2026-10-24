INSERT INTO agent_hub_listing_versions(listing_id, snapshot_id, version_number, clone_mode)
       SELECT ml.id, ml.snapshot_id, COALESCE(ml.current_version, 1), 'files_only'
         FROM agent_hub_listings ml
         LEFT JOIN agent_hub_listing_versions v
           ON v.listing_id = ml.id AND v.snapshot_id = ml.snapshot_id
        WHERE ml.snapshot_id IS NOT NULL
          AND v.id IS NULL