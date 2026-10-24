CREATE INDEX IF NOT EXISTS idx_kubernetes_clusters_enabled
       ON kubernetes_clusters(enabled, is_default, label)