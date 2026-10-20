// @ts-nocheck
// Every managed identity writer takes identity -> agent locks in that order.
// Reuse the existing bounded PostgreSQL advisory-lock implementation. No new
// request-key ledger: historical deployments never persisted that key.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function conflict(message = "Managed runtime identity needs operator review") {
  return Object.assign(new Error(message), { statusCode: 409, code: "managed_identity_conflict" });
}
function identityLockKey(identity) {
  if (identity?.namespace !== "headmaster" || !UUID_RE.test(identity.ownerUuid || "") || !UUID_RE.test(identity.externalId || "")) throw conflict();
  return `headmaster-identity:${identity.ownerUuid.toLowerCase()}:${identity.externalId.toLowerCase()}`;
}
async function withManagedIdentityLock(identity, operation, { acquireLock = require("./agentProvisionLock").acquireAgentProvisionLock } = {}) {
  const lock = await acquireLock(identityLockKey(identity), { applicationName: "headmaster-managed-identity" });
  try { return await operation(); } finally { await lock.release(); }
}
async function findManagedIdentityAgents(db, identity) {
  const { rows } = await db.query(`SELECT * FROM agents WHERE external_namespace = 'headmaster'
    AND external_owner_uuid = $1 AND external_id = $2 ORDER BY id LIMIT 2`, [identity.ownerUuid, identity.externalId]);
  if (!Array.isArray(rows) || rows.length > 1) throw conflict();
  if (rows[0] && (rows[0].external_namespace !== "headmaster" || rows[0].external_owner_uuid !== identity.ownerUuid || rows[0].external_id !== identity.externalId)) throw conflict();
  return rows;
}
async function findReusableManagedAgent(db, identity, { userId, config, runtimeFields }) {
  const rows = await findManagedIdentityAgents(db, identity);
  if (!rows[0]) return null;
  const row = rows[0];
  if (row.user_id !== userId || row.runtime_family !== "hermes" || row.headmaster_owner_id !== config[0] ||
      row.headmaster_workspace_id !== config[1] || row.headmaster_memory_bank_id !== config[2] || row.headmaster_memory_gateway_url !== config[3] ||
      row.deploy_target !== runtimeFields.deploy_target || (row.execution_target_id || null) !== (runtimeFields.execution_target_id || null) ||
      row.sandbox_profile !== runtimeFields.sandbox_profile) throw conflict();
  return row;
}
module.exports = { withManagedIdentityLock, identityLockKey, findManagedIdentityAgents, findReusableManagedAgent, conflict };
