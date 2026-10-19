// @ts-nocheck
const { validateManifest, refuse } = require("./protectedReleaseManifest");
const { runProtectedRuntimeRelease } = require("./protectedRuntimeRelease");
const { ProtectedReleaseDocker } = require("./protectedReleaseDocker");
const { createProtectedReleaseState } = require("./protectedReleaseState");
const { waitForAgentReadiness } = require("./healthChecks");

async function runProtectedReleaseJob(job, { db, agentRow, loadBackend, withProviderMutationLock, checkReadiness = null }) {
  const payload = job.data.protected_release;
  if (!payload) return null;
  const { manifest, releaseId, target } = validateManifest(payload.manifest);
  if (payload.release_id !== releaseId || target.agent_id !== String(job.data.id)
      || target.owner_id !== agentRow.user_id || job.data.replace_existing_runtime !== true
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(payload.deployment_id || "")) throw refuse("PROTECTED_RELEASE_JOB_INVALID");
  const backend = await loadBackend(target.runtime, { ownerUserId: target.owner_id });
  if (!backend?.docker) throw refuse("PROTECTED_RELEASE_BACKEND_UNSUPPORTED");
  return withProviderMutationLock(target.owner_id, async () => {
    const adapter = new ProtectedReleaseDocker(backend, { checkReadiness: checkReadiness || (() => waitForAgentReadiness({
      host: target.container_name, runtimeHost: target.container_name, runtimePort: 8642,
      gatewayHost: target.container_name, gatewayPort: 9119,
    })) });
    return runProtectedRuntimeRelease({ manifest, action: payload.action, adapter,
      state: createProtectedReleaseState(db, target.agent_id, payload.deployment_id), receipt: payload.receipt, deploymentId: payload.deployment_id,
      saveReceipt: async receipt => {
        // Preserve the exact immutable request in existing BullMQ job metadata.
        await job.updateData({ ...job.data, protected_release: { ...payload, manifest, receipt } });
      } });
  });
}
module.exports = { runProtectedReleaseJob };
