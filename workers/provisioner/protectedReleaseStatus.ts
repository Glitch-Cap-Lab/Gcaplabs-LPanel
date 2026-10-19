// @ts-nocheck
const { validateManifest, assertAgent, digest, refuse } = require("./protectedReleaseManifest");

// Shared read adapter: callers must hold the existing agent provision lock and authorize the owner.
async function readProtectedReleaseStatus({ manifest: input, adapter, state, job = null }) {
  const { manifest, releaseId, target } = validateManifest(input);
  if (job && (job.data?.protected_release?.release_id !== releaseId
      || digest(job.data.protected_release.manifest) !== releaseId
      || String(job.data.id) !== target.agent_id)) throw refuse("PROTECTED_RELEASE_JOB_INVALID");
  const row = await state.read();
  assertAgent(manifest, row, { candidateId: row?.image === manifest.image.binding ? row.container_id : null });
  await adapter.verifyImageBinding(manifest);
  const names = { old: `${target.container_name}-release-${releaseId.slice(0, 16)}`, stage: `.protected-release-${releaseId}` };
  await adapter.retained(target, names);
  const receipt = await adapter.readReceipt(target, names) || job?.data?.protected_release?.receipt || null;
  if (receipt && receipt.release_id !== releaseId) throw refuse("PROTECTED_RELEASE_RECEIPT_MISMATCH");
  const candidate = await adapter.candidate(target, releaseId);
  if (candidate) await adapter.verifyCandidate(candidate, manifest, releaseId);
  assertAgent(manifest, row, { candidateId: candidate?.Id === row?.container_id ? candidate.Id : null });
  const runtime = await adapter.observe(target, candidate);
  const queueState = job ? await job.getState() : null;
  return { release_id: releaseId, manifest, phase: receipt?.phase || (queueState === "failed" ? "failed_before_receipt" : job ? "queued" : "not_queued"),
    job_id: job ? String(job.id) : null, queue_state: queueState, receipt,
    observed: { agent_id: row.id, owner_id: row.user_id, account_id: row.external_owner_uuid,
      workspace_id: row.external_id, container_id: row.container_id, image_binding: row.image, status: row.status, runtime },
    external_metadata_confirmed: false, publication_blocked: true };
}
module.exports = { readProtectedReleaseStatus };
