CREATE TABLE IF NOT EXISTS agent_hub_reports (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       listing_id UUID REFERENCES agent_hub_listings(id) ON DELETE CASCADE,
       reporter_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
       reason TEXT NOT NULL,
       details TEXT,
       status TEXT DEFAULT 'open',
       reviewed_at TIMESTAMP,
       reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
       created_at TIMESTAMP DEFAULT NOW()
     )