// @ts-nocheck
const { validateManifest, refuse } = require("./protectedReleaseManifest");
const { runProtectedRuntimeRelease } = require("./protectedRuntimeRelease");
const { ProtectedReleaseDocker } = require("./protectedReleaseDocker");
const { createProtectedReleaseState } = require("./protectedReleaseState");
const { waitForAgentReadiness } = require("./healthChecks");

async function abortable(promise, signal) {
  signal.throwIfAborted(); let abort;
  try { const result = await Promise.race([promise, new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true }); })]); signal.throwIfAborted(); return result; }
  finally { signal.removeEventListener("abort", abort); }
}

async function createReceiptJournal(job, signal, RedisConnectionClass = require("bullmq").RedisConnection) {
  // Same BullMQ backend/key/script, owned transport only. Never disconnect the worker's shared connection.
  const shared = await abortable(job.queue.client, signal);
  const connection = shared.duplicate({ connectionName: "headmaster-protected-release-journal", commandTimeout: 30000, connectTimeout: 5000, maxRetriesPerRequest: 0, retryStrategy: () => null, enableOfflineQueue: false });
  const cancel = () => connection.disconnect(false);
  signal.addEventListener("abort", cancel, { once: true });
  const owned = new RedisConnectionClass(connection, { shared: false, blocking: false }); owned.on("error", () => {});
  try {
    await abortable(owned.client, signal);
    const backend = Object.create(job.backend), queue = Object.create(job.backend.queue);
    Object.defineProperty(queue, "client", { get: () => owned.client }); backend.queue = queue;
    return { async updateData(data) { signal.throwIfAborted(); await abortable(backend.updateData(job, data), signal); signal.throwIfAborted(); job.data = data; }, close() { signal.removeEventListener("abort", cancel); cancel(); void owned.close(true).catch(() => {}); } };
  } catch (error) { signal.removeEventListener("abort", cancel); cancel(); void owned.close(true).catch(() => {}); throw error; }
}

async function runProtectedReleaseJob(job, { db, agentRow, loadBackend, withProviderMutationLock, checkReadiness = null, provisionLock = null, journalAdapter = null, operationTimeoutMs = 900000, stagingRoot = undefined }) {
  const payload = job.data.protected_release;
  if (!payload) return null;
  const { manifest, releaseId, target } = validateManifest(payload.manifest);
  if (payload.release_id !== releaseId || target.agent_id !== String(job.data.id)
      || target.owner_id !== agentRow.user_id || job.data.replace_existing_runtime !== false
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(payload.deployment_id || "")) throw refuse("PROTECTED_RELEASE_JOB_INVALID");
  require("../../backend-api/agentProvisionLock").assertReplacementJobMatchesAgent({ ...agentRow, id: target.agent_id }, job.data);
  const controller = new AbortController(), signal = controller.signal;
  const available = (provisionLock?.deadlineAt ?? Infinity) - Date.now();
  // Leave a fixed safety margin for cancellation/owned-helper stop before the lease watchdog.
  const duration = Math.min(operationTimeoutMs, available - 120000);
  if (!(duration > 0)) throw refuse("PROTECTED_RELEASE_OPERATION_DEADLINE");
  const deadlineAt = Date.now() + duration;
  const expire = () => { const reason = refuse("PROTECTED_RELEASE_OPERATION_DEADLINE"); controller.abort(reason); provisionLock?.cancelPending?.(reason); };
  const timer = setTimeout(expire, duration);
  const lose = () => { const reason = refuse("PROTECTED_RELEASE_LOCK_LOST"); controller.abort(reason); provisionLock?.cancelPending?.(reason); };
  provisionLock?.signal?.addEventListener("abort", lose, { once: true });
  const guard = () => { if (Date.now() >= deadlineAt && !signal.aborted) expire(); if (provisionLock?.signal?.aborted && !signal.aborted) lose(); signal.throwIfAborted(); };
  let journal;
  try {
    guard();
    journal = journalAdapter || await createReceiptJournal(job, signal);
    const backend = await abortable(loadBackend(target.runtime, { ownerUserId: target.owner_id }), signal);
    if (!backend?.docker) throw refuse("PROTECTED_RELEASE_BACKEND_UNSUPPORTED");
    return await withProviderMutationLock(target.owner_id, async providerLock => {
    providerLock?.signal?.addEventListener("abort", lose, { once: true });
    guard();
    const queryable = provisionLock?.query ? provisionLock : db;
    const guardedDb = { query: async (...args) => { guard(); const result = await queryable.query(...args); guard(); return result; } };
    const adapter = new ProtectedReleaseDocker(backend, { stagingRoot, signal, assertActive: guard, checkReadiness: checkReadiness || ((_, readinessSignal) => waitForAgentReadiness({
      host: target.container_name, runtimeHost: target.container_name, runtimePort: 8642,
      gatewayHost: target.container_name, gatewayPort: 9119,
    }, { signal: readinessSignal, beforeAttempt: guard })) });
    try { return await runProtectedRuntimeRelease({ manifest, action: payload.action, adapter,
      state: createProtectedReleaseState(guardedDb, target.agent_id, payload.deployment_id), receipt: payload.receipt, deploymentId: payload.deployment_id,
      saveReceipt: async receipt => {
        // Preserve the exact immutable request in existing BullMQ job metadata.
        guard();
        try { await abortable(journal.updateData({ ...job.data, protected_release: { ...payload, manifest, receipt } }), signal); }
        catch { throw refuse("PROTECTED_RELEASE_JOURNAL_UNCERTAIN"); }
        guard();
      } }); } finally { providerLock?.signal?.removeEventListener("abort", lose); }
  }, { signal });
  } finally { clearTimeout(timer); provisionLock?.signal?.removeEventListener("abort", lose); journal?.close?.(); }
}
module.exports = { runProtectedReleaseJob, createReceiptJournal };
