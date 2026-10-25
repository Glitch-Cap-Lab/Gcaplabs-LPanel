UPDATE agents
        SET backend_type = CASE
          WHEN deploy_target IN ('kubernetes', 'k3s') THEN 'k8s'
          WHEN deploy_target IN ('docker', 'k8s', 'proxmox') THEN deploy_target
          ELSE 'docker'
        END
      WHERE runtime_family IS NOT NULL
        AND deploy_target IS NOT NULL
        AND sandbox_profile IS NOT NULL
        AND backend_type IS DISTINCT FROM CASE
          WHEN deploy_target IN ('kubernetes', 'k3s') THEN 'k8s'
          WHEN deploy_target IN ('docker', 'k8s', 'proxmox') THEN deploy_target
          ELSE 'docker'
        END