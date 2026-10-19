// @ts-nocheck
// Durable account deletion, shared with the site's existing request table.
// Requires source migration 20261019141720_headmaster_account_deletion_cleanup_targets.sql.
// Targets and receipts outlive Auth/workspace cascades. Never reconstruct legacy
// requests from live bindings: an empty lookup after cascade is not proof of cleanup.
const { wipeCloudRuntime, deleteMemoryBank, clearRelayUsage } = require("./headmasterAccountWipe");
const TABLE = "headmaster_account_deletion_requests";
const OPERATOR_STEPS = ["cloud_runtime", "memory_bank", "relay_usage"];
const DELETION_STEPS = ["revoke_sessions", "push_registrations", ...OPERATOR_STEPS, "auth_user"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const error = (message, statusCode = 503) => Object.assign(new Error(message), { statusCode });
const uuid = (value) => typeof value === "string" && UUID_RE.test(value);

function validateCleanupTargets(snapshot, ownerId) {
  if (!uuid(ownerId) || snapshot?.version !== 1 || snapshot.owner_id !== ownerId.toLowerCase() || !Array.isArray(snapshot.bindings)) throw error("cleanup_targets_missing", 409);
  const bank = `hermes-u-${ownerId.toLowerCase().replace(/-/g, "_")}`;
  const bindings = snapshot.bindings.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row) || !uuid(row.workspace_id) || (row.agent_id !== null && !uuid(row.agent_id)) || (row.bank_id !== null && row.bank_id !== bank)) throw error("cleanup_targets_invalid", 409);
    return { workspace_id: row.workspace_id.toLowerCase(), agent_id: row.agent_id?.toLowerCase() ?? null, bank_id: row.bank_id };
  });
  return { version: 1, owner_id: ownerId.toLowerCase(), bindings };
}

function createDeletionClient({ env = process.env, fetchImpl = globalThis.fetch, cleanupOps = null } = {}) {
  const url = String(env.HEADMASTER_SUPABASE_URL || "").replace(/\/+$/, "");
  const key = String(env.HEADMASTER_SUPABASE_SERVICE_ROLE_KEY || "");
  if (!url || !key) return null;
  const headers = { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" };
  const rest = (path, init = {}) => fetchImpl(`${url}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const ops = cleanupOps || {
    cloud_runtime: (ownerId, agentId) => wipeCloudRuntime(agentId, {
      db: require("./db"), containerManager: require("./containerManager"),
      acquireLock: require("./agentProvisionLock").acquireAgentProvisionLock,
      releasePort: require("./portAllocations").releaseGatewayPort,
      cancelJobs: require("./redisQueue").cancelDeploymentJobsForAgent,
    }, ownerId),
    memory_bank: (ownerId, bankId) => deleteMemoryBank(bankId, { env, fetchImpl, expectedOwnerId: ownerId }),
    relay_usage: (ownerId) => clearRelayUsage(ownerId, require("./redisQueue").connection),
  };

  async function list() {
    const res = await rest(`${TABLE}?select=id,owner_id,email,source,status,steps,cleanup_targets,cleanup_results,requested_at,completed_at,completed_by&order=requested_at.desc&limit=200`);
    if (!res.ok) throw error("deletions_unavailable");
    return res.json();
  }
  async function get(id) {
    const res = await rest(`${TABLE}?id=eq.${encodeURIComponent(id)}&select=*`);
    if (!res.ok) throw error("deletions_unavailable");
    const rows = await res.json();
    return rows[0] || null;
  }
  // A side effect may be replayed after a crash, but stale receipts must never
  // overwrite progress from another request. Empty representation means conflict.
  async function save(row, update) {
    const params = new URLSearchParams({ id: `eq.${row.id}`, status: `eq.${row.status}`,
      steps: `eq.${JSON.stringify(row.steps || {})}`, cleanup_results: `eq.${JSON.stringify(row.cleanup_results || {})}` });
    const res = await rest(`${TABLE}?${params}`, { method: "PATCH", headers: { prefer: "return=representation" }, body: JSON.stringify(update) });
    if (!res.ok) throw error("deletion_update_failed");
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].id !== row.id) throw error("deletion_conflict", 409);
    return { ...row, ...update, ...rows[0] };
  }
  async function operation(step, ownerId) {
    let res;
    if (step === "revoke_sessions") {
      res = await rest("rpc/headmaster_bump_account_revocation", { method: "POST", body: JSON.stringify({ p_owner_id: ownerId }) });
      return res.ok && typeof await res.json() === "number";
    }
    if (step === "push_registrations") {
      res = await rest(`headmaster_push_registrations?owner_id=eq.${ownerId}`, { method: "DELETE" });
      return res.ok; // A REST 404 may mean the store is unavailable, not no devices.
    }
    if (step === "auth_user") {
      res = await fetchImpl(`${url}/auth/v1/admin/users/${ownerId}`, { method: "DELETE", headers });
      if (res.ok) return true;
      // Auth may already be gone after a successful DELETE whose receipt failed.
      if (res.status === 404) {
        const body = await res.json().catch(() => ({}));
        return body.code === "user_not_found" || body.error_code === "user_not_found";
      }
      return false;
    }
    if (step === "memory_tenant") {
      res = await rest("rpc/headmaster_delete_hindsight_tenant", { method: "POST", body: JSON.stringify({ p_owner_id: ownerId }) });
      return res.ok;
    }
    return false;
  }
  const attempt = async (fn) => { try { const result = await fn(); return result === true || result?.done === true; } catch { return false; } };

  async function run(row, selected, actor) {
    const targets = validateCleanupTargets(row.cleanup_targets, row.owner_id);
    const ownerId = targets.owner_id;
    const ids = {
      cloud_runtime: [...new Set(targets.bindings.map((r) => r.agent_id).filter(Boolean))],
      memory_bank: [...new Set([`hermes-u-${ownerId.replace(/-/g, "_")}`, ...targets.bindings.map((r) => r.bank_id).filter(Boolean)])], relay_usage: [ownerId],
    };
    // Check current progress via CAS, including rows left running by a crash.
    // This is not an exclusive lock: concurrent idempotent effects are safe,
    // while each subsequent CAS prevents stale progress from being committed.
    row = await save(row, { status: "running" });
    for (const step of selected) {
      if (row.steps?.[step] === "done") continue;
      let done;
      if (ids[step]) {
        for (const id of ids[step]) {
          if (row.cleanup_results?.[step]?.[id] === "done") continue;
          done = await attempt(() => ops[step](ownerId, id));
          const cleanup_results = { ...(row.cleanup_results || {}), [step]: { ...(row.cleanup_results?.[step] || {}), [id]: done ? "done" : "failed" } };
          // Stop on persistence failure before attempting another destructive effect.
          row = await save(row, { cleanup_results });
        }
        done = ids[step].every((id) => row.cleanup_results?.[step]?.[id] === "done");
        if (step === "memory_bank" && done) done = await attempt(() => operation("memory_tenant", ownerId));
      } else if (step === "auth_user" && row.steps?.revoke_sessions !== "done") {
        row = await save(row, { steps: { ...(row.steps || {}), auth_user: "skipped" } });
        continue;
      } else {
        done = await attempt(() => operation(step, ownerId));
      }
      row = await save(row, { steps: { ...(row.steps || {}), [step]: done ? "done" : "failed" } });
    }
    const complete = DELETION_STEPS.every((step) => row.steps?.[step] === "done");
    const failed = DELETION_STEPS.some((step) => ["failed", "skipped"].includes(row.steps?.[step]));
    return save(row, { status: complete ? "completed" : failed ? "failed" : "needs_operator",
      completed_at: complete ? new Date().toISOString() : null, completed_by: complete ? String(actor || "admin") : null });
  }
  async function completeStep(id, step, actor) {
    if (!DELETION_STEPS.includes(step)) throw error("step_invalid", 400);
    const row = await get(id);
    if (!row) throw error("not_found", 404);
    return run(row, [step], actor);
  }
  async function deleteAccount(ownerId, actor) {
    if (!uuid(ownerId)) throw error("owner_invalid", 400);
    ownerId = ownerId.toLowerCase();
    // The existing account authority snapshots and fences provisioning in one
    // transaction. No client-side lookup/insert fallback may race that fence.
    const created = await rest("rpc/headmaster_begin_account_deletion", { method: "POST",
      body: JSON.stringify({ p_owner_id: ownerId, p_email: null, p_source: "admin" }) });
    if (!created.ok) {
      const body = await created.json().catch(() => ({}));
      if (body.message === "deletion_busy") throw error("deletion_busy", 409);
      if (body.message === "deletion_already_requested") throw error("deletion_already_requested", 409);
      throw error("deletion_record_failed");
    }
    const rows = await created.json();
    if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]?.id) throw error("deletion_record_failed");
    const row = rows[0];
    // The response itself must prove persistence. Never fill absent fields from
    // local memory before the first destructive operation.
    validateCleanupTargets(row.cleanup_targets, ownerId);
    if (row.owner_id !== ownerId || row.status !== "running" ||
        !row.steps || typeof row.steps !== "object" || Array.isArray(row.steps) ||
        !row.cleanup_results || typeof row.cleanup_results !== "object" || Array.isArray(row.cleanup_results)) throw error("deletion_record_failed");
    return run(row, DELETION_STEPS, actor);
  }
  return { list, completeStep, deleteAccount };
}
module.exports = { createDeletionClient, OPERATOR_STEPS, DELETION_STEPS, validateCleanupTargets };
