// @ts-nocheck
// Race-free binding of an agent to its immutable Headmaster identity.
//
// The account-side provisioner and the runtime's own bind script can call
// /integrations/headmaster/adopt at the same time. A read-then-write lets the
// later writer overwrite an identity the earlier one already set. Instead the
// first bind is a single conditional UPDATE that only succeeds while the agent
// is still unbound; every other caller re-reads the (now immutable) row and
// either matches it (idempotent no-op) or gets a 409.

function identityConflict() {
  const error = new Error("Agent is already bound to a different external identity");
  error.statusCode = 409;
  error.code = "external_identity_immutable";
  return error;
}

function sameIdentity(row, { namespace, externalId, ownerUuid }) {
  return (
    row.external_namespace === namespace &&
    row.external_id === externalId &&
    row.external_owner_uuid === ownerUuid
  );
}

/**
 * Bind `agentId` to the identity, atomically.
 *
 * @returns {Promise<{agent: Object, newlyAdopted: boolean}>}
 * @throws 409 when the agent is bound to a different identity, 404 when gone.
 */
async function bindExternalIdentity(db, agentId, identity, deps = {}) {
  if (identity.namespace === "headmaster") {
    const { withManagedIdentityLock, findManagedIdentityAgents, conflict } = require("./headmasterIdentityLock");
    const acquireLock = deps.acquireLock || require("./agentProvisionLock").acquireAgentProvisionLock;
    return withManagedIdentityLock(identity, async () => {
      const lock = await acquireLock(agentId, { applicationName: "headmaster-identity-adoption" });
      try {
        const matches = await findManagedIdentityAgents(db, identity);
        if (matches[0] && matches[0].id !== agentId) throw conflict();
        return bindIdentity(db, agentId, identity);
      } finally { await lock.release(); }
    }, { acquireLock });
  }
  return bindIdentity(db, agentId, identity);
}

async function bindIdentity(db, agentId, identity) {
  const { namespace, externalId, ownerUuid } = identity;
  const claimed = await db.query(
    `UPDATE agents
        SET external_namespace = $1, external_id = $2, external_owner_uuid = $3
      WHERE id = $4 AND external_namespace IS NULL
      RETURNING *`,
    [namespace, externalId, ownerUuid, agentId],
  );
  if (claimed.rows[0]) return { agent: claimed.rows[0], newlyAdopted: true };

  const current = await db.query("SELECT * FROM agents WHERE id = $1", [agentId]);
  const row = current.rows[0];
  if (!row) {
    const error = new Error("Agent not found");
    error.statusCode = 404;
    throw error;
  }
  if (row.external_namespace == null || !sameIdentity(row, identity)) {
    throw identityConflict();
  }
  return { agent: row, newlyAdopted: false };
}

module.exports = { bindExternalIdentity, identityConflict };
