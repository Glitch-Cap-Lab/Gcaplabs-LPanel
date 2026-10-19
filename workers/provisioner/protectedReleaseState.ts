// @ts-nocheck
const { assertAgent, refuse } = require("./protectedReleaseManifest");
const { finalizeProvisionedDeployment } = require("./deploymentLifecycle");

function createProtectedReleaseState(db, agentId, deploymentId = null) {
  const read = async () => (await db.query("SELECT * FROM agents WHERE id = $1", [agentId])).rows[0];
  const assertRecoverable = async (manifest, candidateId) => {
    const row = await read();
    assertAgent(manifest, row, { candidateId: candidateId && row?.container_id === candidateId ? candidateId : null });
    return row;
  };
  const switchRuntime = async (manifest, candidateId, rollback = false, previousStatus = "running") => {
    const row = await assertRecoverable(manifest, candidateId);
    const t = manifest.targets[0];
    const wantedId = rollback ? t.runtime.container_id : candidateId;
    const wantedImage = rollback ? t.image_binding : manifest.image.id;
    const updated = await db.query(`UPDATE agents SET container_id = $2, image = $3, status = $4
      WHERE id = $1 AND user_id = $5 AND external_owner_uuid = $6 AND external_id = $7
        AND container_id IS NOT DISTINCT FROM $8 AND image = $9 AND status = $10
      RETURNING id`, [t.agent_id, wantedId, wantedImage, rollback ? previousStatus : "deploying", t.owner_id,
      t.account_id, t.workspace_id, row.container_id, row.image, row.status]);
    if (!updated.rows[0]) throw refuse("PROTECTED_RELEASE_BINDING_CHANGED");
  };
  return {
    read, assertRecoverable,
    async commit(manifest, candidateId) {
      if (!deploymentId) throw refuse("PROTECTED_RELEASE_DEPLOYMENT_ID_REQUIRED");
      await switchRuntime(manifest, candidateId);
      const changed = await db.query("UPDATE deployments SET status = 'deploying' WHERE agent_id = $1 AND id = $2 AND status = 'queued' RETURNING id", [agentId, deploymentId]);
      if (!changed.rows[0]) throw refuse("PROTECTED_RELEASE_DEPLOYMENT_CHANGED");
      const result = await finalizeProvisionedDeployment(db, { agentId, containerId: candidateId, name: "Headmaster runtime", backend: "docker", deploymentId });
      if (!result.finalized) throw refuse("PROTECTED_RELEASE_FINALIZATION_REFUSED");
    },
    async rollback(manifest, candidateId, previousStatus, receipt = {}) {
      await switchRuntime(manifest, candidateId, true, previousStatus);
      const ids = [...new Set([deploymentId, receipt.deployment_id].filter(Boolean))];
      if (!ids.length) throw refuse("PROTECTED_RELEASE_DEPLOYMENT_ID_REQUIRED");
      await db.query("UPDATE deployments SET status = 'failed' WHERE agent_id = $1 AND id = ANY($2::uuid[]) AND status IN ('queued', 'deploying', 'completed')", [agentId, ids]);
    },
  };
}
module.exports = { createProtectedReleaseState };
