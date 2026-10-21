// Terminal-failure outage proofs: dependency loss while a release is failing must leave durable
// recovery evidence, never a second mutation, and must never leak the advisory lock.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
process.env.PROTECTED_RELEASE_FIXTURE_ONLY = "1";
const { fixture, database, protectedJobData } = require("./protectedRelease.test");
delete process.env.PROTECTED_RELEASE_FIXTURE_ONLY;
const { runProtectedReleaseJob } = require("./protectedReleaseJob");
const { digest } = require("./protectedReleaseManifest");

const namesFor = f => { const id = digest(f.manifest); return { old: `hm-owned-release-${id.slice(0, 16)}`, stage: `.protected-release-${id}` }; };
const mutations = events => events.filter(x => /^(stop|start|create|rename|rollback-row|commit):/.test(x) || ["commit", "rollback-row"].includes(x));

// Mirrors the worker: a provider mutation lock plus the per-agent provision lock, both counted.
function locks(db) {
  const state = { provider: { acquired: 0, held: 0 }, agent: { acquired: 0, held: 0 } };
  const withProviderMutationLock = async (_owner, fn) => {
    state.provider.acquired++; state.provider.held++;
    try { return await fn({ signal: new AbortController().signal }); } finally { state.provider.held--; }
  };
  const provisionLock = () => {
    state.agent.acquired++; state.agent.held++;
    return { query: (...args) => db.query(...args), signal: new AbortController().signal, deadlineAt: Date.now() + 3600000,
      cancelPending() {}, release() { state.agent.held--; } };
  };
  return { state, withProviderMutationLock, provisionLock };
}

async function attempt(f, db, job, l, extra = {}) {
  const provisionLock = l.provisionLock();
  try {
    // Each fixture stages in its own folder: test files run in parallel and share one manifest digest.
    return await runProtectedReleaseJob(job, { db, agentRow: f.row(), loadBackend: async () => f.backend, stagingRoot: path.join(f.root, ".worker-tmp"),
      withProviderMutationLock: l.withProviderMutationLock, provisionLock, checkReadiness: async () => ({ ok: true }), ...extra });
  } finally { provisionLock.release(); }
}

test("database outage while recording the terminal rollback leaves a recovery-required receipt and refuses blind retry", async t => {
  const f = await fixture(t), inner = database(f); let down = false, l;
  const db = { deployments: inner.deployments, async query(sql, params) {
    if (down && /^\s*UPDATE (agents SET container_id|deployments SET status)/.test(sql)) throw Object.assign(new Error("connect ECONNREFUSED db"), { code: "ECONNREFUSED" });
    return inner.query(sql, params);
  } };
  l = locks(db);
  const job = { id: "db-outage", data: protectedJobData(f) };
  const journalAdapter = { updateData: async data => { job.data = data; } };
  // The candidate fails readiness; the compensating terminal status write then hits the outage.
  down = true;
  const checkReadiness = async () => { if (f.events.includes("start:candidate")) throw new Error("health failed"); return { ok: true }; };
  await assert.rejects(attempt(f, db, job, l, { journalAdapter, checkReadiness }), /RECOVERY_REQUIRED/);
  const receipt = await f.adapter.readReceipt(f.manifest.targets[0], namesFor(f));
  assert.equal(receipt.phase, "recovery_required");
  assert.equal(receipt.candidate_id, "candidate");
  // The terminal status could not be written: the queued deployment is not falsely reported failed.
  assert.equal(inner.deployments.get("00000000-0000-0000-0000-000000000010"), "queued");
  assert.equal(f.row().container_id, "old");
  assert.ok(!f.events.includes("start:old"), "old writer must not restart while recovery is unproven");
  assert.equal(f.events.filter(x => x === "create:candidate").length, 1);
  assert.deepEqual([l.state.provider.held, l.state.agent.held], [0, 0], "both advisory locks released after the failure");

  // Database returns. A blind apply retry is refused as unsafe and mutates nothing.
  down = false; const boundary = f.events.length, written = f.receipts.length;
  await assert.rejects(attempt(f, db, job, l, { journalAdapter }), /RECOVERY_REQUIRED/);
  assert.deepEqual(f.events.slice(boundary), []);
  assert.equal(f.receipts.length, written);
  assert.deepEqual([l.state.provider.acquired, l.state.agent.acquired, l.state.provider.held, l.state.agent.held], [2, 2, 0, 0]);

  // Explicit recovery under freshly acquired locks completes and records the terminal status.
  job.data = protectedJobData(f); job.data.protected_release.action = "recover"; job.data.protected_release.receipt = receipt;
  const recovered = await attempt(f, db, job, l, { journalAdapter });
  assert.equal(recovered.phase, "rolled_back");
  assert.equal(inner.deployments.get("00000000-0000-0000-0000-000000000010"), "failed");
  assert.equal(f.row().status, "running"); assert.equal(f.row().container_id, "old");
  assert.deepEqual([l.state.provider.held, l.state.agent.held], [0, 0]);
});

test("Redis outage at receipt save and queue ACK keeps the volume receipt, stops nothing twice and refuses retry", async t => {
  const f = await fixture(t), db = database(f), l = locks(db);
  const job = { id: "redis-outage", data: protectedJobData(f) }; let redisDown = false, saves = 0;
  const journalAdapter = { updateData: async data => {
    if (redisDown || data.protected_release.receipt.phase === "candidate_created") { redisDown = true; throw new Error("Redis connection is closed"); }
    saves++; job.data = data;
  } };
  await assert.rejects(attempt(f, db, job, l, { journalAdapter }), /RECOVERY_REQUIRED/);
  // The queue never learned about the candidate, but the canonical volume receipt did.
  assert.notEqual(job.data.protected_release.receipt?.phase, "candidate_created");
  const receipt = await f.adapter.readReceipt(f.manifest.targets[0], namesFor(f));
  assert.equal(receipt.phase, "recovery_required"); assert.equal(receipt.transport_uncertain, true); assert.equal(receipt.lp_committed, false);
  assert.ok(saves >= 1);
  assert.equal(f.events.filter(x => x === "stop:old").length, 1);
  assert.equal(f.events.filter(x => x === "create:candidate").length, 1);
  assert.ok(!f.events.includes("start:old") && !f.events.includes("start:candidate") && !f.events.includes("commit"));
  assert.equal(f.row().container_id, "old");
  assert.deepEqual([l.state.provider.held, l.state.agent.held], [0, 0]);

  // Queue still has no receipt: the retry must trust the volume, refuse, and mutate nothing.
  const boundary = f.events.length;
  await assert.rejects(attempt(f, db, job, l, { journalAdapter }), /RECOVERY_REQUIRED/);
  assert.deepEqual(f.events.slice(boundary), []);
  assert.equal(f.events.filter(x => x === "create:candidate").length, 1);
  assert.deepEqual([l.state.provider.acquired, l.state.agent.acquired, l.state.provider.held, l.state.agent.held], [2, 2, 0, 0]);

  // Redis back: explicit recovery rolls back exactly once and the locks cycle cleanly again.
  redisDown = false; job.data = protectedJobData(f); job.data.protected_release.action = "recover";
  const recovered = await attempt(f, db, job, l, { journalAdapter: { updateData: async data => { job.data = data; } } });
  assert.equal(recovered.phase, "rolled_back");
  assert.equal(f.events.filter(x => x === "start:old").length, 1);
  assert.deepEqual([l.state.provider.held, l.state.agent.held], [0, 0]);
  assert.equal(mutations(f.events).filter(x => x === "create:candidate").length, 1);
});

test("Redis outage at the final queue ACK after the database commit stays recovery-required and recovers explicitly", async t => {
  const f = await fixture(t), db = database(f), l = locks(db), deploymentId = "00000000-0000-0000-0000-000000000010";
  const job = { id: "redis-final-ack", data: protectedJobData(f) };
  const journalAdapter = { updateData: async data => { if (data.protected_release.receipt.phase === "external_metadata_pending") throw new Error("Redis connection is closed"); job.data = data; } };
  await assert.rejects(attempt(f, db, job, l, { journalAdapter }), /RECOVERY_REQUIRED/);
  // The ACK is uncertain, so nothing is compensated automatically and the candidate stays the only writer.
  assert.equal(f.row().container_id, "candidate");
  const receipt = await f.adapter.readReceipt(f.manifest.targets[0], namesFor(f));
  assert.equal(receipt.phase, "recovery_required"); assert.equal(receipt.transport_uncertain, true);
  assert.equal(f.events.filter(x => x === "stop:old").length, 1); assert.ok(!f.events.includes("start:old"));
  assert.deepEqual([l.state.provider.held, l.state.agent.held], [0, 0]);
  const boundary = f.events.length;
  // The stale apply job no longer matches the committed binding, so it is refused before any mutation.
  await assert.rejects(attempt(f, db, job, l, { journalAdapter }), /state changed|RECOVERY_REQUIRED/);
  assert.deepEqual(f.events.slice(boundary), []);
  job.data = protectedJobData(f); job.data.protected_release.action = "recover";
  const recovered = await attempt(f, db, job, l, { journalAdapter: { updateData: async data => { job.data = data; } } });
  assert.equal(recovered.phase, "rolled_back"); assert.equal(f.row().container_id, "old");
  assert.equal(db.deployments.get(deploymentId), "failed");
  assert.equal(f.events.filter(x => x === "start:old").length, 1);
  assert.deepEqual([l.state.provider.held, l.state.agent.held], [0, 0]);
});
