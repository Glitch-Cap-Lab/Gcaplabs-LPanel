CREATE TRIGGER trg_agents_remote_host_target
     BEFORE INSERT OR UPDATE OF execution_target_id, status ON agents
     FOR EACH ROW EXECUTE FUNCTION enforce_remote_host_agent_target()