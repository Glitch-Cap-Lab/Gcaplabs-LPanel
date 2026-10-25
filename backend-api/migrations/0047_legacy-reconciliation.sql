CREATE TABLE IF NOT EXISTS gateway_port_allocations (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       host_key TEXT NOT NULL,
       agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
       port INTEGER NOT NULL,
       purpose TEXT NOT NULL DEFAULT 'gateway',
       created_at TIMESTAMPTZ DEFAULT NOW(),
       UNIQUE(host_key, port)
     )