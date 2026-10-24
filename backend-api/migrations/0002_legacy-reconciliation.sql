CREATE TABLE IF NOT EXISTS integration_catalog (
       id VARCHAR(50) PRIMARY KEY,
       name VARCHAR(100) NOT NULL,
       icon VARCHAR(50),
       category VARCHAR(50) NOT NULL,
       description TEXT,
       auth_type VARCHAR(20),
       config_schema JSONB NOT NULL DEFAULT '{}',
       enabled BOOLEAN DEFAULT true
     )