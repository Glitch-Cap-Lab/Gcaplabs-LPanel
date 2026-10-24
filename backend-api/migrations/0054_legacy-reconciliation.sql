INSERT INTO platform_settings(singleton, default_vcpu, default_ram_mb, default_disk_gb)
       VALUES(TRUE, 1, 1024, 10)
       ON CONFLICT (singleton) DO NOTHING