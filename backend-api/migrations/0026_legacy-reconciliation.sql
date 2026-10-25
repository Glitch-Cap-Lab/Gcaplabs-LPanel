UPDATE agents
        SET deploy_target = 'k8s'
      WHERE deploy_target IN ('kubernetes', 'k3s')