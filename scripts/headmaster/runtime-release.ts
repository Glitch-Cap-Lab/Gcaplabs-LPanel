// @ts-nocheck
// Operator checkout entrypoint; worker images execute the same controller via the existing queue.
const fs = require("fs/promises");
const { validateManifest, assertAgent, refuse } = require("../../workers/provisioner/protectedReleaseManifest");
const { runProtectedRuntimeRelease } = require("../../workers/provisioner/protectedRuntimeRelease");
const { ProtectedReleaseDocker } = require("../../workers/provisioner/protectedReleaseDocker");
const { createProtectedReleaseState } = require("../../workers/provisioner/protectedReleaseState");
const { readProtectedReleaseStatus } = require("../../workers/provisioner/protectedReleaseStatus");
const { randomUUID } = require("crypto");

async function run(argv, deps) {
  if (argv.length !== 3 || argv[0] !== "--manifest" || !["--dry-run", "--enqueue", "--recover", "--status"].includes(argv[2])) {
    throw refuse("Usage: runtime-release --manifest PATH --dry-run|--enqueue|--recover|--status");
  }
  const { manifest, releaseId, target } = validateManifest(JSON.parse(await deps.readFile(argv[1], "utf8")));
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
    if (argv[2] === "--status" || (argv[2] === "--enqueue" && existing)) return await readProtectedReleaseStatus({ manifest, adapter, state, job: existing });
    if (argv[2] === "--recover") {
      const status = await readProtectedReleaseStatus({ manifest, adapter, state, job: existing });
      if (!status.receipt && status.phase !== "failed_before_receipt") throw refuse("PROTECTED_RELEASE_RECOVERY_UNAVAILABLE");
    }
    if (argv[2] !== "--recover") assertAgent(manifest, row, { allowQueued: false });
    if (argv[2] === "--dry-run") return await runProtectedRuntimeRelease({ manifest, adapter, state, dryRun: true, saveReceipt: async () => {} });
    const jobData = deps.buildReplacementDeploymentJob(row, { image: manifest.image.id,
      extra: { protected_release: { manifest, release_id: releaseId, action: argv[2] === "--recover" ? "recover" : "apply",
        ...(argv[2] === "--recover" && existing?.data?.protected_release?.receipt ? { receipt: existing.data.protected_release.receipt } : {}) } } });
    // Old workers refuse retained runtimes unless this marker is true. Only the typed new branch may act.
    jobData.replace_existing_runtime = false;
    if (argv[2] === "--recover" && !jobData.protected_release.receipt) {
      jobData.protected_release.receipt = { release_id: releaseId, phase: "validated", previous_status: target.status,
        candidate_id: null, deployment_id: existing.data.protected_release.deployment_id, refused_before_receipt: true };
    }
    // One existing queue, one attempt: an uncertain release needs explicit recovery, never generic retry.
    guard(); const job = await deps.enqueue(row, jobData, { queryable, provisionLock: lock,
      cancelDeploymentJobsForAgent: deps.cancelJobs,
      addDeploymentJob: data => deps.addJob(data, { attempts: 1, jobId: argv[2] === "--recover" ? `protected-recovery-${releaseId}-${randomUUID()}` : jobId, removeOnComplete: false, removeOnFail: false }) });
    return { release_id: releaseId, phase: "queued", job_id: String(job.id), publication_blocked: true };
  } finally { queue?.close?.(); lock?.signal?.removeEventListener("abort", lost); try { await lock?.release(); } finally { clearTimeout(timer); } }
}

async function main(argv = process.argv.slice(2), supplied = null) {
  let db;
  try {
    const deps = supplied || (() => {
      const locks = require("../../backend-api/agentProvisionLock");
      const queue = require("../../backend-api/redisQueue");
      db = require("../../backend-api/db");
      return { db, readFile: fs.readFile, acquireLock: locks.acquireAgentProvisionLock,
        buildReplacementDeploymentJob: locks.buildReplacementDeploymentJob, enqueue: locks.enqueueReplacementDeployment,
        createQueueSession: queue.createProtectedQueueSession,
        loadBackend: async () => new (require("../../workers/provisioner/backends/hermes"))() };
    })();
    return await run(argv, deps);
  } finally { if (db) await db.end(); }
}
if (require.main === module) main().then(result => { console.log(JSON.stringify(result)); process.exit(0); }, () => {
  console.error("Protected runtime release refused or incomplete. Review the retained deployment receipt."); process.exit(1);
});
module.exports = { run, main };
