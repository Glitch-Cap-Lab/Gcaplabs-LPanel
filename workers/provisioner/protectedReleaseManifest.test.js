// Schema contract for the declarative immutable release input (plan W7). Realistic values only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateManifest } = require("./protectedReleaseManifest");

const clone = value => JSON.parse(JSON.stringify(value));
const hex = (char, n) => char.repeat(n);
const release = () => ({
  format: "headmaster-protected-runtime-release/v1",
  sources: { core: "3f9c1b7a5e2d4c8b9a0f6e1d2c3b4a5968778695", webapp: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", lpanel: "91a8c88eda79921623746c301cfa2d4920ab3762" },
  image: { id: `sha256:${hex("4e", 32)}`, binding: "headmaster-hermes:1.2.0-rc1", contract_sha256: hex("ab", 32), dependency_sha256: hex("cd", 32), uid: 10000, gid: 10000 },
  targets: [{
    agent_id: "5b0c3a2e-1f4d-4a6b-8c9d-0e1f2a3b4c5d", owner_id: "7d8e9f10-2a3b-4c5d-8e6f-1a2b3c4d5e6f",
    account_id: "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d", workspace_id: "c4d5e6f7-0812-4a3b-9c4d-5e6f7a8b9c0d",
    container_id: "hm-4f2a91", container_name: "hm-owner-4f2a91", image_id: `sha256:${hex("1f", 32)}`, image_binding: "headmaster-hermes:1.1.9",
    site_binding: { image_binding: "headmaster-hermes:1.1.9", deployment_generation: 7, authorization_revision: 3, revocation_generation: 0 },
    env_sha256: hex("9e", 32), volume: "hm-owner-4f2a91-data", status: "running",
    runtime: { container_id: "hm-4f2a91", container_name: "hm-owner-4f2a91", host: "hm-owner-4f2a91", backend_type: "docker", runtime_family: "hermes", deploy_target: "docker", execution_target_id: "docker", sandbox_profile: "standard" },
  }],
  env_delta: { set: { HERMES_BOT_DESKTOP: "1" } },
});
const refused = (mutate, code) => {
  const input = release(); mutate(input);
  assert.throws(() => validateManifest(input), error => error.code === code, `${code} for ${mutate}`);
};

test("a complete release input validates, derives a stable id and is not aliased to the caller's object", () => {
  const input = release(), first = validateManifest(input);
  assert.match(first.releaseId, /^[0-9a-f]{64}$/);
  // Key order is not identity: the id hashes canonical JSON.
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  assert.equal(validateManifest(reordered).releaseId, first.releaseId);
  input.sources.core = hex("0", 40);
  assert.equal(first.manifest.sources.core, release().sources.core);
  // Any single field of the immutable input moves the release id.
  for (const mutate of [m => { m.sources.webapp = hex("e", 40); }, m => { m.image.contract_sha256 = hex("11", 32); }, m => { m.image.dependency_sha256 = hex("22", 32); },
    m => { m.targets[0].env_sha256 = hex("33", 32); }, m => { m.targets[0].site_binding.deployment_generation = 8; }, m => { m.env_delta.set.HERMES_BOT_DESKTOP = "0"; }]) {
    const next = release(); mutate(next); assert.notEqual(validateManifest(next).releaseId, first.releaseId);
  }
  assert.deepEqual(validateManifest({ ...release(), env_delta: { set: {} } }).manifest.env_delta, { set: {} });
});

test("unknown or missing format versions and unknown fields are refused", () => {
  for (const format of ["headmaster-protected-runtime-release/v2", "headmaster-protected-runtime-release/v0", "headmaster-protected-runtime-release", "", null, 1, undefined]) {
    refused(m => { m.format = format; }, "PROTECTED_RELEASE_MANIFEST_INVALID");
  }
  for (const mutate of [m => { m.extra = true; }, m => { delete m.format; }, m => { m.sources.extra = hex("a", 40); }, m => { m.image.tag_only = "latest"; },
    m => { m.targets[0].extra = 1; }, m => { m.targets[0].runtime.extra = 1; }, m => { m.targets[0].site_binding.extra = 1; }, m => { m.env_delta.unset = ["X"]; }]) {
    refused(mutate, "PROTECTED_RELEASE_MANIFEST_INVALID");
  }
  for (const value of [null, [], "release", 7]) assert.throws(() => validateManifest(value), error => error.code === "PROTECTED_RELEASE_MANIFEST_INVALID");
});

test("source pins and image identity must be exact immutable values", () => {
  for (const bad of [hex("a", 39), hex("a", 41), hex("A", 40), "main", "refs/heads/main", "", null]) {
    for (const key of ["core", "webapp", "lpanel"]) refused(m => { m.sources[key] = bad; }, "PROTECTED_RELEASE_SOURCE_INVALID");
  }
  refused(m => { delete m.sources.lpanel; }, "PROTECTED_RELEASE_SOURCE_INVALID");
  for (const mutate of [m => { m.image.id = "headmaster-hermes:latest"; }, m => { m.image.id = `sha256:${hex("4e", 31)}`; }, m => { m.image.id = `sha512:${hex("4e", 32)}`; },
    m => { m.image.contract_sha256 = "deadbeef"; }, m => { m.image.dependency_sha256 = null; }, m => { m.image.binding = ""; }, m => { m.image.binding = "--privileged"; },
    m => { m.image.uid = 0; }, m => { m.image.gid = 1000; }]) refused(mutate, "PROTECTED_RELEASE_IMAGE_INVALID");
});

test("target set, expected current bindings and neighbours are exact", () => {
  refused(m => { m.targets = []; }, "PROTECTED_RELEASE_TARGET_INVALID");
  refused(m => { m.targets.push(clone(m.targets[0])); }, "PROTECTED_RELEASE_TARGET_INVALID");
  refused(m => { m.targets = "all"; }, "PROTECTED_RELEASE_TARGET_INVALID");
  for (const mutate of [m => { m.targets[0].owner_id = "not-a-uuid"; }, m => { m.targets[0].image_id = "old-tag"; }, m => { m.targets[0].env_sha256 = "short"; },
    m => { m.targets[0].container_name = "../escape"; }, m => { m.targets[0].volume = "/var/lib/docker"; }, m => { m.targets[0].status = "stopped"; },
    m => { m.targets[0].runtime.container_name = "someone-else"; }, m => { m.targets[0].runtime.runtime_family = "openclaw"; }, m => { m.targets[0].runtime.backend_type = "k8s"; },
    m => { m.targets[0].runtime.sandbox_profile = "nemoclaw"; }, m => { m.targets[0].runtime.host = "http://other"; },
    m => { m.targets[0].site_binding.image_binding = "headmaster-hermes:other"; }, m => { m.targets[0].site_binding.deployment_generation = 0; },
    m => { m.targets[0].site_binding.authorization_revision = -1; }, m => { m.targets[0].site_binding.revocation_generation = 1.5; }]) {
    refused(mutate, "PROTECTED_RELEASE_TARGET_INVALID");
  }
  // A null host and a first revocation generation of zero are both legitimate.
  const ok = release(); ok.targets[0].runtime.host = null; ok.targets[0].status = "warning";
  assert.equal(validateManifest(ok).target.status, "warning");
});

test("service env delta is a closed allowlist that cannot carry secrets", () => {
  const secrets = [["API_SERVER_KEY", "sk-live-0123456789abcdef"], ["OPENAI_API_KEY", "1"], ["HERMES_GATEWAY_TOKEN", "eyJhbGciOiJIUzI1NiJ9.e30.x"],
    ["DATABASE_URL", "postgres://admin:hunter2@db/prod"], ["LD_PRELOAD", "/opt/data/private.so"], ["PYTHONPATH", "/opt/data"]];
  for (const [key, value] of secrets) refused(m => { m.env_delta.set = { [key]: value }; }, "PROTECTED_RELEASE_MANIFEST_INVALID");
  for (const value of ["true", "2", "", "sk-live-0123456789abcdef", 1, true, null]) refused(m => { m.env_delta.set.HERMES_BOT_DESKTOP = value; }, "PROTECTED_RELEASE_ENV_INVALID");
  refused(m => { m.env_delta = { set: { HERMES_BOT_DESKTOP: "1" }, remove: ["API_SERVER_KEY"] }; }, "PROTECTED_RELEASE_MANIFEST_INVALID");
  // The error carries only a fixed code, never the offending value.
  try { const input = release(); input.env_delta.set = { API_SERVER_KEY: "sk-live-0123456789abcdef" }; validateManifest(input); assert.fail("must refuse"); }
  catch (error) { assert.ok(!String(error.message).includes("sk-live")); }
});
