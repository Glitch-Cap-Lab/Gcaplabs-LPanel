UPDATE platform_settings SET agent_hub_url = 'https://norafleet.ai', updated_at = NOW()
       WHERE agent_hub_url = 'https://nora.solomontsao.com'