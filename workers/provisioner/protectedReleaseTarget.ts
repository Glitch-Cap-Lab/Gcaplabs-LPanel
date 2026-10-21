// @ts-nocheck
// One bot's release target, read from LP's own agent row and Docker, so a fleet
// rollout builds each manifest on the server instead of from a hand-made file.
// The account side adds site_binding. Nothing here locks or writes: the dry run and
// the swap re-check every value under the agent lock, so a stale answer is refused there.
const { envFingerprint, refuse } = require("./protectedReleaseManifest");

const ROOT = "/opt/data";

async function describeProtectedReleaseTarget(row, adapter) {
  if (!row || row.external_namespace !== "headmaster" || !row.external_owner_uuid || !row.external_id
      || row.headmaster_owner_id !== row.external_owner_uuid || row.headmaster_workspace_id !== row.external_id) throw refuse("PROTECTED_RELEASE_OWNER_CHANGED");
  if (!["running", "warning"].includes(row.status) || !row.container_id || !row.container_name) throw refuse("PROTECTED_RELEASE_RUNNING_REQUIRED");
  const c = await adapter.inspect(row.container_id);
  const volumes = (c.Mounts || []).filter(x => x.Type === "volume" && x.Destination === ROOT && x.RW).map(x => x.Name);
  if (c.Name !== `/${row.container_name}` || c.Config?.Labels?.["nora.agent.id"] !== row.id || !c.State?.Running
      || volumes.length !== 1 || !Array.isArray(c.Config?.Env)) throw refuse("PROTECTED_RELEASE_RUNTIME_CHANGED");
  return {
    agent_id: row.id, owner_id: row.user_id, account_id: row.external_owner_uuid, workspace_id: row.external_id,
    container_id: c.Id, container_name: row.container_name, image_id: c.Image, image_binding: row.image,
    env_sha256: envFingerprint(c.Config.Env), volume: volumes[0],
    runtime: { container_id: row.container_id, container_name: row.container_name, host: row.host ?? null, backend_type: row.backend_type,
      runtime_family: row.runtime_family, deploy_target: row.deploy_target, execution_target_id: row.execution_target_id, sandbox_profile: row.sandbox_profile },
    status: row.status,
  };
}

module.exports = { describeProtectedReleaseTarget };
