// @ts-nocheck
// Persisted Headmaster state rides the same full-environment reconciliation as
// provider changes. Never write only the Headmaster variables into a runtime.
const {
  HEADMASTER_STORAGE_ENV,
  storageAllocationBytes,
} = require("../agent-runtime/lib/headmasterStorage");
const FIELDS = Object.freeze({
  HEADMASTER_OWNER_ID: "headmaster_owner_id",
  HEADMASTER_WORKSPACE_ID: "headmaster_workspace_id",
  HEADMASTER_MEMORY_BANK_ID: "headmaster_memory_bank_id",
  HEADMASTER_MEMORY_GATEWAY_URL: "headmaster_memory_gateway_url",
});
const HEADMASTER_ENV_NAMES = Object.freeze([...Object.keys(FIELDS), HEADMASTER_STORAGE_ENV]);
// Columns that must be selected whenever an agents row is handed to headmasterEnv().
const HEADMASTER_AGENT_COLUMNS = Object.freeze([...Object.values(FIELDS), "disk_gb"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function configError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function headmasterEnv(agent = {}) {
  const values = Object.fromEntries(
    Object.entries(FIELDS).map(([key, field]) => [key, agent[field] || undefined]),
  );
  values[HEADMASTER_STORAGE_ENV] = undefined;
  if (isHeadmasterManagedAgent(agent)) {
    const allocation = storageAllocationBytes(agent);
    values[HEADMASTER_STORAGE_ENV] = allocation === null ? undefined : String(allocation);
  }
  return values;
}

// A Hermes runtime is Headmaster-managed once it has adopted a Headmaster
// identity or carries any Headmaster bootstrap value. Such a runtime gets its
// model from the Headmaster relay, never from the operator's own provider rows.
function isHeadmasterManagedAgent(agent = {}) {
  if (!agent) return false;
  return (
    agent.external_namespace === "headmaster" ||
    Object.values(FIELDS).some((field) => Boolean(agent[field]))
  );
}

async function agentIsHeadmasterManaged(agentId, queryable = require("./db")) {
  if (!agentId) return false;
  const result = await queryable.query(
    `SELECT external_namespace, headmaster_owner_id, headmaster_workspace_id,
            headmaster_memory_bank_id, headmaster_memory_gateway_url
       FROM agents WHERE id = $1`,
    [agentId],
  );
  return isHeadmasterManagedAgent(result?.rows?.[0]);
}

function withoutHeadmasterEnv(values = {}) {
  return Object.fromEntries(
    Object.entries(values).filter(([name]) => !HEADMASTER_ENV_NAMES.includes(name)),
  );
}

function managedConfigStatus(agent) {
  return {
    integration_key_names: Object.entries(headmasterEnv(agent))
      .filter(([, value]) => value)
      .map(([key]) => key),
    desired_revision: Number(agent.headmaster_integration_desired_revision || 0),
    applied_revision: Number(agent.headmaster_integration_applied_revision || 0),
    deployment_status: agent.headmaster_integration_deployment_status || "unconfigured",
  };
}

function validateConfig(body) {
  if (!Number.isSafeInteger(body?.expected_revision) || body.expected_revision < 0) {
    throw configError("expected_revision must be a non-negative integer");
  }
  const { owner_uuid, workspace_uuid, memory_bank_id, memory_gateway_url } = body;
  if (
    typeof owner_uuid !== "string" ||
    !UUID.test(owner_uuid) ||
    typeof workspace_uuid !== "string" ||
    !UUID.test(workspace_uuid)
  ) {
    throw configError("owner_uuid and workspace_uuid must be lowercase UUIDs");
  }
  if (memory_bank_id !== `hermes-u-${owner_uuid.replace(/-/g, "_")}`) {
    throw configError("memory_bank_id must match the owner identity");
  }
  let url;
  try {
    url = new URL(memory_gateway_url);
  } catch {
    /* validated below */
  }
  if (
    typeof memory_gateway_url !== "string" ||
    memory_gateway_url.length > 2048 ||
    // eslint-disable-next-line no-control-regex -- intentional: reject control characters in the URL
    /[\s\x00-\x1f]/.test(memory_gateway_url) ||
    !url ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  ) {
    throw configError(
      "memory_gateway_url must be an HTTP(S) URL without credentials, query, or fragment",
    );
  }
  return [owner_uuid, workspace_uuid, memory_bank_id, memory_gateway_url];
}

// Persist identity and nonsecret bootstrap metadata before the worker can
// start an image whose initialization requires it. Credentials stay in the
// existing managed-environment reconciliation path.
function deploymentConfig(body, runtimeFamily) {
  const identity = body.external_identity;
  const config = body.headmaster_integration_config;
  if (!identity && !config) return null;
  if (runtimeFamily !== "hermes" || identity?.namespace !== "headmaster" || !config)
    throw configError("Complete Headmaster deployment identity and memory metadata are required");
  const values = validateConfig({ ...config, expected_revision: 0 });
  if (identity.external_id !== values[1] || identity.owner_uuid !== values[0])
    throw configError("Headmaster deployment identity and memory metadata must match");
  if (values[3] !== "http://headmaster-memory-gateway:8791")
    throw configError("Headmaster deployment requires the private memory gateway");
  return values;
}

async function updateManagedConfig(agent, body, { retry = false, apiKeyWorkspaceId = null } = {}) {
  const db = require("./db");
  const { withProviderStateLock } = require("./llmProviders");
  const {
    syncAuthToUserAgents,
    resumeAgentWithProviderAuth,
    PROVIDER_AUTH_QUARANTINE_REASON,
  } = require("./authSync");
  const values = retry ? null : validateConfig(body);
  // The existing account lock also serializes unrelated LLM key saves. Re-read
  // under it, and hold it through runtime readiness and the revision fence.
  return withProviderStateLock(agent.user_id, async () => {
    const current = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [
      agent.id,
      agent.user_id,
    ]);
    let row = current.rows[0];
    if (!row) throw configError("Agent not found", 404);
    if (apiKeyWorkspaceId && require("./remoteHosts").isRemoteDockerAgent(row)) {
      throw configError("Remote Docker agent operations require session authentication", 403);
    }
    if (row.runtime_family !== "hermes")
      throw configError("Managed Headmaster config requires a Headmaster runtime");
    const status = managedConfigStatus(row);
    if (!retry) {
      if (
        row.external_namespace !== "headmaster" ||
        row.external_owner_uuid !== values[0] ||
        row.external_id !== values[1]
      ) {
        throw configError("Config must match the agent's adopted Headmaster identity", 409);
      }
      const identical = Object.values(FIELDS).every((field, index) => row[field] === values[index]);
      // A duplicate of an applied request is harmless even with its old fence.
      if (identical && status.applied_revision >= status.desired_revision) return status;
      if (body.expected_revision !== status.desired_revision)
        throw configError("Managed config revision conflict", 409);
      if (!identical) {
        const updated = await db.query(
          `UPDATE agents SET headmaster_owner_id = $1, headmaster_workspace_id = $2,
             headmaster_memory_bank_id = $3, headmaster_memory_gateway_url = $4,
             headmaster_integration_desired_revision = headmaster_integration_desired_revision + 1,
             headmaster_integration_deployment_status = 'pending'
           WHERE id = $5 AND headmaster_integration_desired_revision = $6 RETURNING *`,
          [...values, row.id, status.desired_revision],
        );
        if (!updated.rows[0]) throw configError("Managed config revision conflict", 409);
        row = updated.rows[0];
      }
    } else {
      if (!Object.keys(FIELDS).every((name) => status.integration_key_names.includes(name)))
        throw configError("No complete Headmaster config has been saved");
      if (status.applied_revision >= status.desired_revision) return status;
    }
    const revision = row.headmaster_integration_desired_revision;
    let applied = false;
    try {
      if (row.status === "stopped" && row.paused_reason === PROVIDER_AUTH_QUARANTINE_REASON) {
        // Auth sync quarantines and stops a failed runtime. Its existing safe
        // lifecycle stages the complete environment offline, starts it, waits
        // for readiness and publishes running. Do not wake a user-stopped agent.
        const result = await resumeAgentWithProviderAuth(row, "start", { providerLockHeld: true });
        applied = result.syncResult?.status === "synced";
      } else {
        const results = await syncAuthToUserAgents(row.user_id, row.id, {
          providerLockHeld: true,
          apiKeyWorkspaceId,
        });
        applied = results.some(
          (result) => result.agentId === row.id && result.status === "synced" && !result.staged,
        );
      }
    } catch {
      // Never expose runtime errors/credentials through this status endpoint.
    }
    if (!applied)
      console.warn(
        `[headmasterConfig] Revision ${revision} not applied for agent ${row.id}; retry required`,
      );
    const result = await db.query(
      `UPDATE agents SET headmaster_integration_applied_revision = CASE WHEN $3 THEN $2 ELSE headmaster_integration_applied_revision END,
         headmaster_integration_deployment_status = $4
       WHERE id = $1 AND headmaster_integration_desired_revision = $2 RETURNING *`,
      [row.id, revision, applied, applied ? "applied" : "failed"],
    );
    if (!result.rows[0]) throw configError("Managed config revision conflict", 409);
    return managedConfigStatus(result.rows[0]);
  });
}

module.exports = {
  HEADMASTER_ENV_NAMES,
  HEADMASTER_AGENT_COLUMNS,
  headmasterEnv,
  withoutHeadmasterEnv,
  isHeadmasterManagedAgent,
  agentIsHeadmasterManaged,
  managedConfigStatus,
  validateConfig,
  deploymentConfig,
  updateManagedConfig,
};
