// @ts-nocheck
// Operator checkout entrypoint; worker images execute the same controller via the existing queue.
const fs = require("fs/promises");
const { validateManifest, refuse } = require("../../workers/provisioner/protectedReleaseManifest");
const { runProtectedReleaseOperation, FLAGS } = require("../../workers/provisioner/protectedReleaseOperation");

async function runLocal(argv, deps) {
  if (argv.length !== 3 || argv[0] !== "--manifest" || !FLAGS.includes(argv[2])) {
    throw refuse("Usage: runtime-release --manifest PATH --dry-run|--enqueue|--recover|--status");
  }
  return runProtectedReleaseOperation(argv[2], JSON.parse(await deps.readFile(argv[1], "utf8")), deps);
}

async function run(argv, deps) {
  if (argv.length !== 3 || argv[0] !== "--manifest" || !["--dry-run","--enqueue","--recover","--status"].includes(argv[2])) throw refuse("PROTECTED_RELEASE_ARGUMENTS_INVALID");
  // Parse once. The owner reservation and local queue must hash identical bytes,
  // even if the original file changes while a network call is in progress.
  const {manifest,releaseId} = validateManifest(JSON.parse(await deps.readFile(argv[1],"utf8")));
  const local = {...deps,readFile:async()=>JSON.stringify(manifest)};
  if (argv[2] === "--dry-run") return runLocal(argv,local);
  if (!deps.owner) throw refuse("PROTECTED_RELEASE_OWNER_REQUIRED");
  const prepared = argv[2] === "--enqueue" ? await deps.owner.prepare(manifest,releaseId) : await deps.owner.status(releaseId);
  if (prepared.release_id !== releaseId || !["prepared","binding_pending","lp_updated_owner_pending","metadata_finalized"].includes(prepared.phase)
      || (argv[2] === "--recover" && prepared.metadata_finalized)) throw refuse("PROTECTED_RELEASE_OWNER_UNCONFIRMED");
  // Owner HTTP calls occur before acquireLock and after its finally-release.
  const result = await runLocal(argv,local);
  let owner = prepared;
  if (argv[2] === "--enqueue") {
    try { owner = await deps.owner.finalize(releaseId); }
    catch { owner = {release_id:releaseId,metadata_finalized:false,phase:"binding_pending",publication_blocked:true}; }
  }
  if (owner.release_id !== releaseId) throw refuse("PROTECTED_RELEASE_OWNER_UNCONFIRMED");
  return {...result,owner,metadata_finalized:owner.metadata_finalized === true,
    phase:owner.metadata_finalized ? "metadata_finalized" : result.phase === "external_metadata_pending" ? "lp_updated_owner_pending" : result.phase,
    publication_blocked:true};
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
    if (!supplied && argv[2] !== "--dry-run") {
      const {createOwnerClient,readAccessToken} = require("./runtimeReleaseOwnerClient");
      deps.owner = createOwnerClient({origin:process.env.HEADMASTER_PARENT_ORIGIN,accessToken:await readAccessToken(process.stdin)});
    }
    return await run(argv, deps);
  } finally { if (db) await db.end(); }
}
if (require.main === module) main().then(result => { console.log(JSON.stringify(result)); process.exit(0); }, () => {
  console.error("Protected runtime release refused or incomplete. Review the retained deployment receipt."); process.exit(1);
});
module.exports = { run, main };
