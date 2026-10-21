// @ts-nocheck
// Recover only an existing runtime's immutable owner/workspace identity. The
// deployment request key was not persisted; it is not evidence for old jobs.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const validId = (value) => typeof value === "string" && UUID_RE.test(value);
const fence = (value) => Number.isSafeInteger(value) && value >= 0;
const revision = (value) => Number.isSafeInteger(value) && value >= 1;
const eligible = (job) => job.desired_action === "provision" && typeof job.step === "string" && job.step !== "queued" && ["queued", "failed", "cancelled"].includes(job.status);

function normalizeOwner(value) {
  if (!validId(value)) throw fail("owner_invalid", 400);
  return value.toLowerCase();
}
function validateAuthority(authority, ownerId) {
  if (authority?.owner_id !== ownerId || !revision(authority.authorization_revision)) throw fail("recovery_unavailable", 503);
}
function validateJob(job, ownerId) {
  if (!job || !validId(job.id) || !validId(job.workspace_id) || job.owner_id !== ownerId || job.workspaces?.owner_id !== ownerId ||
      !fence(job.fence) || !revision(job.authorization_revision)) throw fail("recovery_unavailable", 503);
}
async function candidateFor(job, db) {
  const { rows } = await db.query(
    `SELECT id, status, runtime_family, external_namespace, external_id, external_owner_uuid
       FROM agents WHERE external_namespace = 'headmaster'
        AND external_owner_uuid = $1 AND external_id = $2 ORDER BY id LIMIT 2`,
    [job.owner_id, job.workspace_id],
  );
  if (!Array.isArray(rows)) throw fail("recovery_unavailable", 503);
  if (!rows.length) return { state: "no_match", candidate: null };
  if (rows.length !== 1) return { state: "ambiguous", candidate: null };
  const row = rows[0];
  if (!validId(row.id) || row.external_namespace !== "headmaster" || row.external_owner_uuid !== job.owner_id || row.external_id !== job.workspace_id) return { state: "identity_mismatch", candidate: null };
  if (row.runtime_family !== "hermes") return { state: "unsupported_runtime", candidate: null };
  return { state: "matched", candidate: { id: row.id, status: row.status, runtime_family: row.runtime_family } };
}
const jobView = (job) => ({ id: job.id, owner_id: job.owner_id, workspace_id: job.workspace_id, status: job.status, step: job.step,
  fence: job.fence, authorization_revision: job.authorization_revision, nora_agent_id: job.nora_agent_id });

async function inspectProvisionRecovery(client, owner, deps) {
  const ownerId = normalizeOwner(owner);
  const authority = await client.recoveryAuthority(ownerId);
  validateAuthority(authority, ownerId);
  const jobs = await client.recoveryJobs(ownerId);
  const views = [];
  for (const job of jobs) {
    validateJob(job, ownerId);
    const proof = eligible(job) ? await candidateFor(job, deps.db) : { state: job.status === "running" ? "running" : "ineligible", candidate: null };
    views.push({ ...jobView(job), ...proof });
  }
  return { owner_id: ownerId, owner_authorization_revision: authority.authorization_revision,
    proof: "immutable_owner_workspace", request_key_recorded: false, jobs: views };
}

async function recoverProvisionIdentity(client, owner, jobId, expected, deps) {
  const ownerId = normalizeOwner(owner);
  if (!validId(jobId) || !validId(expected?.candidateAgentId) ||
      !fence(expected?.expectedFence) || !revision(expected?.expectedJobAuthorizationRevision) || !revision(expected?.expectedOwnerAuthorizationRevision)) throw fail("recovery_input_invalid", 400);
  const authority = await client.recoveryAuthority(ownerId);
  validateAuthority(authority, ownerId);
  const jobs = await client.recoveryJobs(ownerId, jobId.toLowerCase());
  if (jobs.length !== 1) throw fail("recovery_job_not_found", 404);
  const job = jobs[0];
  validateJob(job, ownerId);
  if (job.id !== jobId.toLowerCase() || job.fence !== expected.expectedFence || job.authorization_revision !== expected.expectedJobAuthorizationRevision ||
      authority.authorization_revision !== expected.expectedOwnerAuthorizationRevision) throw fail("recovery_job_changed");
  if (!eligible(job)) throw fail(job.status === "running" ? "recovery_running" : "recovery_ineligible");
  return require("./headmasterIdentityLock").withManagedIdentityLock({ namespace: "headmaster", ownerUuid: ownerId, externalId: job.workspace_id }, async () => {
    const match = await candidateFor(job, deps.db);
    if (match.state !== "matched") throw fail(`recovery_${match.state}`);
    const agentId = match.candidate.id;
    if (agentId !== expected.candidateAgentId.toLowerCase() || (job.nora_agent_id != null && job.nora_agent_id !== agentId)) throw fail("recovery_identity_mismatch");
    const lock = await deps.acquireLock(agentId, { applicationName: "headmaster-provision-identity-recovery" });
    try {
      const current = await candidateFor(job, deps.db);
      if (current.state !== "matched" || current.candidate.id !== agentId) throw fail("recovery_identity_mismatch");
      const saved = await client.recoverProvisionJob(job, authority, agentId);
      return { owner_id: ownerId, job: jobView(saved), candidate: current.candidate,
        proof: "immutable_owner_workspace", request_key_recorded: false, recovered: true };
    } finally { await lock.release(); }
  }, { acquireLock: deps.acquireLock });
}
module.exports = { inspectProvisionRecovery, recoverProvisionIdentity, candidateFor };
