// @ts-nocheck
// One LP protected release operation (dry run, enqueue, recover or status) under the
// per-agent lock. The operator command and the admin route both call this; the owner
// side (account reservation and finalization) stays with each caller.
const { validateManifest, assertAgent, refuse } = require("./protectedReleaseManifest");
const { runProtectedRuntimeRelease } = require("./protectedRuntimeRelease");
const { ProtectedReleaseDocker } = require("./protectedReleaseDocker");
const { createProtectedReleaseState } = require("./protectedReleaseState");
const { readProtectedReleaseStatus } = require("./protectedReleaseStatus");
const { randomUUID } = require("crypto");

const FLAGS = ["--dry-run", "--enqueue", "--recover", "--status"];

async function runProtectedReleaseOperation(flag, input, deps) {
  if (!FLAGS.includes(flag)) throw refuse("PROTECTED_RELEASE_ARGUMENTS_INVALID");
  const { manifest, releaseId, target } = validateManifest(input);
  const controller = new AbortController(), signal = controller.signal;
  const timeout = deps.operationTimeoutMs ?? 900000;
  const deadlineAt = Date.now() + timeout;
  let lock, queue;
  const cancel = () => { const error = refuse("PROTECTED_RELEASE_OPERATION_DEADLINE"); controller.abort(error); lock?.cancelPending?.(error); };
  const lost = () => { const error = refuse("PROTECTED_RELEASE_LOCK_LOST"); controller.abort(error); lock?.cancelPending?.(error); };
  const guard = () => { if (Date.now() >= deadlineAt && !signal.aborted) cancel(); signal.throwIfAborted(); };
  const timer = setTimeout(cancel, timeout);
  try {
    lock = await deps.acquireLock(target.agent_id, { signal }); guard();
    lock.signal?.addEventListener("abort", lost, { once: true });
    if (lock.signal?.aborted) lost(); guard();
    queue = deps.createQueueSession?.(signal);
    if (queue) deps = { ...deps, ...queue };
    const queryable = { query: async (...args) => { guard(); const result = await (lock.query ? lock : deps.db).query(...args); guard(); return result; } };
    const state = createProtectedReleaseState(queryable, target.agent_id), row = await state.read();
    const backend = await deps.loadBackend(target.runtime, { ownerUserId: target.owner_id });
    guard(); const adapter = new ProtectedReleaseDocker(backend, { signal, assertActive: guard });
    const jobId = `protected-release-${releaseId}`;
    const existing = deps.getJob ? await deps.getJob(jobId) : null;
    if (flag === "--status" || (flag === "--enqueue" && existing)) return await readProtectedReleaseStatus({ manifest, adapter, state, job: existing });
    if (flag === "--recover") {
      const status = await readProtectedReleaseStatus({ manifest, adapter, state, job: existing });
      if (!status.receipt && status.phase !== "failed_before_receipt") throw refuse("PROTECTED_RELEASE_RECOVERY_UNAVAILABLE");
    }
    if (flag !== "--recover") assertAgent(manifest, row, { allowQueued: false });
    if (flag === "--dry-run") return await runProtectedRuntimeRelease({ manifest, adapter, state, dryRun: true, saveReceipt: async () => {} });
    const jobData = deps.buildReplacementDeploymentJob(row, { image: manifest.image.binding,
      extra: { protected_release: { manifest, release_id: releaseId, action: flag === "--recover" ? "recover" : "apply",
        ...(flag === "--recover" && existing?.data?.protected_release?.receipt ? { receipt: existing.data.protected_release.receipt } : {}) } } });
    // Old workers refuse retained runtimes unless this marker is true. Only the typed new branch may act.
    jobData.replace_existing_runtime = false;
    if (flag === "--recover" && !jobData.protected_release.receipt) {
      jobData.protected_release.receipt = { release_id: releaseId, phase: "validated", previous_status: target.status,
        candidate_id: null, deployment_id: existing.data.protected_release.deployment_id, refused_before_receipt: true };
    }
    // One existing queue, one attempt: an uncertain release needs explicit recovery, never generic retry.
    guard(); const job = await deps.enqueue(row, jobData, { queryable, provisionLock: lock,
      cancelDeploymentJobsForAgent: deps.cancelJobs,
      addDeploymentJob: data => deps.addJob(data, { attempts: 1, jobId: flag === "--recover" ? `protected-recovery-${releaseId}-${randomUUID()}` : jobId, removeOnComplete: false, removeOnFail: false }) });
    return { release_id: releaseId, phase: "queued", job_id: String(job.id), publication_blocked: true };
  } finally { queue?.close?.(); lock?.signal?.removeEventListener("abort", lost); try { await lock?.release(); } finally { clearTimeout(timer); } }
}

module.exports = { runProtectedReleaseOperation, FLAGS };
