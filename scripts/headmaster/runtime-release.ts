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
  const lock = await deps.acquireLock(target.agent_id);
  try {
    const state = createProtectedReleaseState(deps.db, target.agent_id), row = await state.read();
    const backend = await deps.loadBackend(target.runtime, { ownerUserId: target.owner_id });
    const adapter = new ProtectedReleaseDocker(backend);
    const jobId = `protected-release-${releaseId}`;
    const existing = deps.getJob ? await deps.getJob(jobId) : null;
    if (argv[2] === "--status" || (argv[2] === "--enqueue" && existing)) return readProtectedReleaseStatus({ manifest, adapter, state, job: existing });
    if (argv[2] === "--recover") {
      const status = await readProtectedReleaseStatus({ manifest, adapter, state, job: existing });
      if (!status.receipt) throw refuse("PROTECTED_RELEASE_RECOVERY_UNAVAILABLE");
    }
    if (argv[2] !== "--recover") assertAgent(manifest, row, { allowQueued: false });
    if (argv[2] === "--dry-run") return runProtectedRuntimeRelease({ manifest, adapter, state, dryRun: true, saveReceipt: async () => {} });
    const jobData = deps.buildReplacementDeploymentJob(row, { image: manifest.image.id,
      extra: { protected_release: { manifest, release_id: releaseId, action: argv[2] === "--recover" ? "recover" : "apply",
        ...(argv[2] === "--recover" && existing?.data?.protected_release?.receipt ? { receipt: existing.data.protected_release.receipt } : {}) } } });
    // One existing queue, one attempt: an uncertain release needs explicit recovery, never generic retry.
    const job = await deps.enqueue(row, jobData, { queryable: deps.db, provisionLock: lock,
      cancelDeploymentJobsForAgent: deps.cancelJobs,
      addDeploymentJob: data => deps.addJob(data, { attempts: 1, jobId: argv[2] === "--recover" ? `protected-recovery-${releaseId}-${randomUUID()}` : jobId, removeOnComplete: false, removeOnFail: false }) });
    return { release_id: releaseId, phase: "queued", job_id: String(job.id), publication_blocked: true };
  } finally { await lock.release(); }
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
        cancelJobs: queue.cancelDeploymentJobsForAgent, addJob: queue.addDeploymentJob, getJob: id => queue.deployQueue.getJob(id),
        loadBackend: async () => new (require("../../workers/provisioner/backends/hermes"))() };
    })();
    return await run(argv, deps);
  } finally { if (db) await db.end(); }
}
if (require.main === module) main().then(result => { console.log(JSON.stringify(result)); process.exit(0); }, () => {
  console.error("Protected runtime release refused or incomplete. Review the retained deployment receipt."); process.exit(1);
});
module.exports = { run, main };
