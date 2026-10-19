// @ts-nocheck
const { createHash } = require("crypto");
const { canonicalize } = require("./protectedReleaseArchive");

function refuse(code) { return Object.assign(new Error(code), { code }); }
function keys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => !allowed.includes(key))) throw refuse("PROTECTED_RELEASE_MANIFEST_INVALID");
}
const digest = value => createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
const uuid = value => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const imageId = value => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
const sha = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const name = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value);

function validateManifest(input) {
  // Clone first: callers cannot mutate the captured release input during an await.
  const m = JSON.parse(JSON.stringify(input));
  keys(m, ["format", "sources", "image", "targets", "env_delta"]);
  if (m.format !== "headmaster-protected-runtime-release/v1") throw refuse("PROTECTED_RELEASE_MANIFEST_INVALID");
  keys(m.sources, ["core", "webapp", "lpanel"]);
  if (!["core", "webapp", "lpanel"].every(key => /^[0-9a-f]{40}$/.test(m.sources[key]))) throw refuse("PROTECTED_RELEASE_SOURCE_INVALID");
  keys(m.image, ["id", "contract_sha256", "dependency_sha256", "uid", "gid"]);
  if (!imageId(m.image.id) || !sha(m.image.contract_sha256) || !sha(m.image.dependency_sha256)
      || m.image.uid !== 10000 || m.image.gid !== 10000) throw refuse("PROTECTED_RELEASE_IMAGE_INVALID");
  // This first supported slice is one local runtime, with sequential fleet orchestration held.
  if (!Array.isArray(m.targets) || m.targets.length !== 1) throw refuse("PROTECTED_RELEASE_TARGET_INVALID");
  const t = m.targets[0];
  keys(t, ["agent_id", "owner_id", "account_id", "workspace_id", "container_id", "container_name", "image_id", "image_binding", "env_sha256", "volume", "runtime", "status"]);
  if (!uuid(t.agent_id) || !uuid(t.owner_id) || !uuid(t.account_id) || !uuid(t.workspace_id)
      || !name(t.container_id) || !name(t.container_name) || !name(t.volume)
      || !imageId(t.image_id) || typeof t.image_binding !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._\/:@-]{0,255}$/.test(t.image_binding)
      || !sha(t.env_sha256)) throw refuse("PROTECTED_RELEASE_TARGET_INVALID");
  keys(t.runtime, ["container_id", "container_name", "host", "backend_type", "runtime_family", "deploy_target", "execution_target_id", "sandbox_profile"]);
  if (!name(t.runtime.container_id) || !["running", "warning"].includes(t.status) || t.runtime.container_name !== t.container_name
      || t.runtime.runtime_family !== "hermes" || t.runtime.backend_type !== "docker" || t.runtime.deploy_target !== "docker"
      || t.runtime.execution_target_id !== "docker" || t.runtime.sandbox_profile !== "standard"
      || !(t.runtime.host === null || name(t.runtime.host))) throw refuse("PROTECTED_RELEASE_TARGET_INVALID");
  keys(m.env_delta, ["set"]);
  keys(m.env_delta.set, ["HERMES_BOT_DESKTOP"]);
  if (Object.values(m.env_delta.set).some(value => !["0", "1"].includes(value))) throw refuse("PROTECTED_RELEASE_ENV_INVALID");
  return { manifest: m, releaseId: digest(m), target: t };
}

function envFingerprint(env) {
  return digest([...env].sort());
}

function assertAgent(m, row, { candidateId = null, allowQueued = true } = {}) {
  const t = m.targets[0];
  if (!row || row.id !== t.agent_id || row.user_id !== t.owner_id
      || row.external_namespace !== "headmaster" || row.external_owner_uuid !== t.account_id || row.external_id !== t.workspace_id
      || row.headmaster_owner_id !== t.account_id || row.headmaster_workspace_id !== t.workspace_id) throw refuse("PROTECTED_RELEASE_OWNER_CHANGED");
  const expected = candidateId ? { ...t.runtime, container_id: candidateId } : t.runtime;
  if (Object.entries(expected).some(([key, value]) => row[key] !== value)
      || row.image !== (candidateId ? m.image.id : t.image_binding)
      || !(allowQueued ? [candidateId ? "running" : t.status, "queued", "deploying"] : [t.status]).includes(row.status)) {
    throw refuse("PROTECTED_RELEASE_BINDING_CHANGED");
  }
}

module.exports = { validateManifest, envFingerprint, assertAgent, digest, refuse };
