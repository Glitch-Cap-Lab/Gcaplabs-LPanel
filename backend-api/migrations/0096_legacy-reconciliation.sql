CREATE TABLE IF NOT EXISTS container_stats (
       id BIGSERIAL PRIMARY KEY,
       agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
       cpu_percent NUMERIC NOT NULL DEFAULT 0,
       memory_usage_mb INTEGER NOT NULL DEFAULT 0,
       memory_limit_mb INTEGER NOT NULL DEFAULT 0,
       memory_percent NUMERIC NOT NULL DEFAULT 0,
       network_rx_mb NUMERIC NOT NULL DEFAULT 0,
       network_tx_mb NUMERIC NOT NULL DEFAULT 0,
       disk_read_mb NUMERIC NOT NULL DEFAULT 0,
       disk_write_mb NUMERIC NOT NULL DEFAULT 0,
       pids INTEGER NOT NULL DEFAULT 0,
       recorded_at TIMESTAMPTZ DEFAULT NOW()
     )