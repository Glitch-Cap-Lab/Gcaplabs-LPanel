// @ts-nocheck
// Internal account-deletion steps (decision 31) that need the platform:
// wipe the Cloud runtime (container + home volume + agent row), delete the
// Hindsight memory bank, and clear managed-inference relay usage in Redis.
// Called only by the Headmaster account API (gcaplabs-site delete-account
// route) with the shared internal secret. Every step is idempotent: a missing
// agent, bank or key counts as done.

const crypto = require("crypto");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BANK_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
// Both managed-inference stores (services/headmaster-inference/quota.mjs).
const RELAY_PREFIXES = ["headmaster-inference", "headmaster-inference-byo"];

function secretMatches(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string" || expected.length < 32) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** @param deps { db, containerManager, acquireLock, releasePort, cancelJobs } */
async function wipeCloudRuntime(agentId, deps, expectedOwnerId) {
  if (!UUID_RE.test(String(agentId || ""))) throw Object.assign(new Error("agent_invalid"), { statusCode: 400 });
  if (!UUID_RE.test(String(expectedOwnerId || ""))) throw Object.assign(new Error("owner_invalid"), { statusCode: 400 });
  const lock = await deps.acquireLock(agentId, { applicationName: "headmaster-account-deletion" });
  try {
    const { rows } = await deps.db.query("SELECT * FROM agents WHERE id = $1", [agentId]);
    const agent = rows[0];
    if (!agent) return { done: true, existed: false };
    // Check the immutable managed identity while holding the lifecycle lock.
    if (agent.external_namespace !== "headmaster" || String(agent.external_owner_uuid || "").toLowerCase() !== expectedOwnerId.toLowerCase()) {
      throw Object.assign(new Error("runtime_owner_mismatch"), { statusCode: 409 });
    }
    if (typeof deps.containerManager.canDestroy !== "function" || !deps.containerManager.canDestroy(agent) || typeof deps.containerManager.destroy !== "function") throw Object.assign(new Error("runtime_destroy_unavailable"), { statusCode: 503 });
    await deps.cancelJobs(agent.id);
    // destroy() removes the container and its volumes (the runtime home dir).
    await deps.containerManager.destroy(agent);
    await deps.releasePort(agent.id).catch(() => {});
    await deps.db.query("DELETE FROM agents WHERE id = $1", [agent.id]);
    return { done: true, existed: true };
  } finally {
    await lock.release();
  }
}

/** Owner UUID of a Headmaster bank id (`hermes-u-<owner uuid with _>`), else null. */
function ownerIdForBank(bankId) {
  const m = /^hermes-u-([0-9a-f]{8})_([0-9a-f]{4})_([0-9a-f]{4})_([0-9a-f]{4})_([0-9a-f]{12})$/i.exec(String(bankId || ""));
  return m ? m.slice(1).join("-").toLowerCase() : null;
}

/**
 * DELETE the bank on the Hindsight API (HINDSIGHT_API_URL, optional HINDSIGHT_API_KEY).
 * Headmaster's Hindsight runs the tenant extension: it needs the gateway key as the
 * bearer plus `x-headmaster-owner-id` to pick the owner's schema, so a Headmaster
 * bank (`hermes-u-...`) also sends that header.
 */
async function deleteMemoryBank(bankId, { env = process.env, fetchImpl = globalThis.fetch, expectedOwnerId } = {}) {
  if (!BANK_RE.test(String(bankId || ""))) throw Object.assign(new Error("bank_invalid"), { statusCode: 400 });
  if (!UUID_RE.test(String(expectedOwnerId || ""))) throw Object.assign(new Error("owner_invalid"), { statusCode: 400 });
  const ownerId = ownerIdForBank(bankId);
  if (bankId !== `hermes-u-${expectedOwnerId.toLowerCase().replace(/-/g, "_")}`) throw Object.assign(new Error("bank_owner_mismatch"), { statusCode: 409 });
  const base = String(env.HINDSIGHT_API_URL || "").replace(/\/+$/, "");
  if (!base) throw Object.assign(new Error("hindsight_not_configured"), { statusCode: 503 });
  const headers = env.HINDSIGHT_API_KEY ? { authorization: `Bearer ${env.HINDSIGHT_API_KEY}` } : {};
  if (ownerId) headers["x-headmaster-owner-id"] = ownerId;
  const res = await fetchImpl(`${base}/v1/default/banks/${encodeURIComponent(bankId)}`, { method: "DELETE", headers });
  if (res.ok || res.status === 404) return { done: true, existed: res.status !== 404 };
  throw Object.assign(new Error("hindsight_delete_failed"), { statusCode: 502 });
}

/** Deletes every relay usage/quota key for the owner. SCAN, never KEYS. */
async function clearRelayUsage(ownerId, redis) {
  if (!UUID_RE.test(String(ownerId || ""))) throw Object.assign(new Error("owner_invalid"), { statusCode: 400 });
  ownerId = ownerId.toLowerCase();
  let removed = 0;
  for (const prefix of RELAY_PREFIXES) {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", `${prefix}:${ownerId}:*`, "COUNT", 200);
      cursor = next;
      if (keys.length) removed += await redis.del(...keys);
    } while (cursor !== "0");
  }
  return { done: true, removed };
}

module.exports = { secretMatches, wipeCloudRuntime, deleteMemoryBank, clearRelayUsage, ownerIdForBank, RELAY_PREFIXES };
