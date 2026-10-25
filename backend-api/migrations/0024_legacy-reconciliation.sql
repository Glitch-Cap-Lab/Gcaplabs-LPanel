UPDATE agents
        SET deploy_target = CASE
          WHEN backend_type IN ('kubernetes', 'k3s') THEN 'k8s'
          WHEN backend_type = 'hermes' THEN 'docker'
          WHEN backend_type = 'nemoclaw' THEN 'docker'
          WHEN backend_type IN ('docker', 'k8s', 'proxmox') THEN backend_type
          ELSE 'docker'
        END
      WHERE deploy_target IS NULL OR BTRIM(deploy_target) = ''