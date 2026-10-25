CREATE TABLE IF NOT EXISTS platform_settings (
       singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
       default_vcpu INTEGER NOT NULL DEFAULT 1,
       default_ram_mb INTEGER NOT NULL DEFAULT 1024,
       default_disk_gb INTEGER NOT NULL DEFAULT 10,
       default_locale TEXT NOT NULL DEFAULT 'en',
       system_banner_enabled BOOLEAN NOT NULL DEFAULT false,
       system_banner_severity TEXT NOT NULL DEFAULT 'warning',
       system_banner_title TEXT NOT NULL DEFAULT '',
       system_banner_message TEXT NOT NULL DEFAULT '',
       agent_hub_default_share_target TEXT NOT NULL DEFAULT 'both',
       agent_hub_url TEXT NOT NULL DEFAULT 'https://nora.solomontsao.com',
       agent_hub_api_key_encrypted TEXT,
       created_at TIMESTAMP DEFAULT NOW(),
       updated_at TIMESTAMP DEFAULT NOW()
     )