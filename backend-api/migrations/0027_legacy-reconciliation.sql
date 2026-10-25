UPDATE agents
        SET execution_target_id = CASE
          WHEN deploy_target = 'k8s' THEN 'k8s'
          WHEN deploy_target IN ('docker', 'proxmox') THEN deploy_target
          ELSE COALESCE(NULLIF(deploy_target, ''), 'docker')
        END
      WHERE execution_target_id IS NULL OR BTRIM(execution_target_id) = ''