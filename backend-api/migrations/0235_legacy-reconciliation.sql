CREATE OR REPLACE FUNCTION enforce_remote_host_agent_target()
     RETURNS TRIGGER
     LANGUAGE plpgsql
     AS $$
     DECLARE
       target_host_id TEXT;
     BEGIN
       IF LOWER(NEW.execution_target_id) LIKE 'remote:%'
          AND NEW.status IS DISTINCT FROM 'deleted' THEN
         target_host_id := LEFT(
           TRIM(BOTH '-' FROM REGEXP_REPLACE(
             REGEXP_REPLACE(LOWER(SUBSTRING(NEW.execution_target_id FROM 8)), '[^a-z0-9-]+', '-', 'g'),
             '-+',
             '-',
             'g'
           )),
           64
         );
         PERFORM pg_advisory_xact_lock(
           hashtextextended('nora:remote-host-mutation:' || target_host_id, 0)
         );
         IF target_host_id = ''
            OR EXISTS (
              SELECT 1 FROM remote_host_id_tombstones WHERE remote_host_id = target_host_id
            )
            OR NOT EXISTS (
              SELECT 1 FROM remote_hosts WHERE id = target_host_id
            ) THEN
           RAISE EXCEPTION 'Remote host execution target % does not exist', NEW.execution_target_id
             USING ERRCODE = '23503';
         END IF;
       END IF;
       RETURN NEW;
     END;
     $$