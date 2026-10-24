CREATE TABLE IF NOT EXISTS agent_hub_listing_versions (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       listing_id UUID REFERENCES agent_hub_listings(id) ON DELETE CASCADE,
       snapshot_id UUID REFERENCES snapshots(id) ON DELETE CASCADE,
       version_number INTEGER NOT NULL,
       clone_mode TEXT DEFAULT 'files_only',
       created_at TIMESTAMP DEFAULT NOW(),
       UNIQUE(listing_id, version_number),
       UNIQUE(listing_id, snapshot_id)
     )