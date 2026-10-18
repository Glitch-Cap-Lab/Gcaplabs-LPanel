const assert = require("node:assert/strict");
const Module = require("node:module");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const { HEADMASTER_ENV_NAMES } = require("../../backend-api/headmasterConfig.ts");
const { HEADMASTER_STORAGE_ENV } = require("../../agent-runtime/lib/headmasterStorage.ts");
const K8sBackend = require("./backends/k8s.ts");
const HermesBackend = require("./backends/hermes.ts");

let agentRow;
let integrationEnv;

// As in headmasterInferenceProvider.test.js, intercept worker startup so no
// queue, database, Redis connection or health server is created. Keep the real
// effective-state, reconciliation, bootstrap and backend updater implementations.
function loadWorker() {
  const originalLoad = Module._load;
  const originalLog = console.log;
  const noop = () => [];
  const genericModule = new Proxy({}, { get: () => noop });
  const actualModules = new Set([
    "../../agent-runtime/lib/headmasterInference",
    "../../agent-runtime/lib/containerCommand",
    "../../agent-runtime/lib/runtimeBootstrap",
    "../../agent-runtime/lib/hermesRuntimeBootstrap",
    "./deploymentLifecycle",
  ]);
  Module._load = function (request, parent) {
    if (parent?.filename?.replaceAll("\\", "/").endsWith("/workers/provisioner/worker.ts")) {
      if (request === "bullmq") {
        return {
          Worker: class {
            on() {}
          },
          UnrecoverableError: class extends Error {},
        };
      }
      if (request === "crypto" || actualModules.has(request)) {
        return originalLoad.apply(this, arguments);
      }
      if (request === "ioredis") return class {};
      if (request === "pg") {
        return {
          Pool: class {
            async query(sql) {
              if (!/FROM agents WHERE id = \$1/.test(sql) || !agentRow) return { rows: [] };
              // Model a SELECT projection: omitted columns cannot accidentally
              // reach reconciliation just because the fixture holds a full row.
              const columns = sql.slice(sql.indexOf("SELECT") + 6, sql.indexOf("FROM")).split(",");
              return {
                rows: [
                  Object.fromEntries(columns.map((name) => [name.trim(), agentRow[name.trim()]])),
                ],
              };
            }
          },
          Client: class {},
        };
      }
      if (request === "http") return { createServer: () => ({ listen() {} }) };
      if (request === "../../backend-api/lib/connectionConfig") {
        return { buildPostgresConfig: () => ({}), createRedisClient: () => ({}) };
      }
      if (request === "../../agent-runtime/lib/backendCatalog") {
        return { getDefaultBackend: () => "docker", getEnabledBackends: () => ["docker"] };
      }
      if (request === "../../backend-api/llmProviders") {
        return {
          getManagedProviderEnvNames: () => [
            ...HEADMASTER_ENV_NAMES,
            "NORA_HERMES_MANAGED_ENV_B64",
            "NORA_HERMES_MODEL_CONFIG_B64",
          ],
          getDeploymentProvider: async () => ({ provider: "openai", model: "gpt-5" }),
        };
      }
      if (request === "../../backend-api/integrations") {
        return {
          getIntegrationEnvVars: async () => integrationEnv,
          getIntegrationsForSync: async () => [],
        };
      }
      if (request === "./healthChecks")
        return { waitForAgentReadiness: async () => ({ ok: true }) };
      if (request === "../../backend-api/redisQueue") return { ALERT_DELIVERY_ATTEMPTS: 1 };
      if (request.startsWith(".")) return genericModule;
    }
    return originalLoad.apply(this, arguments);
  };
  console.log = () => {};
  try {
    return require("./worker.ts");
  } finally {
    Module._load = originalLoad;
    console.log = originalLog;
  }
}

const { reconcileRuntimeLlmAuth } = loadWorker();
const STATE_ENV = "NORA_K8S_MANAGED_ENV_B64";
const MANAGED_ANNOTATION = "norafleet.ai/managed-env-names";
const managedNames = [...HEADMASTER_ENV_NAMES, "INTEGRATION_TOKEN"];

function successfulExec() {
  const stream = new PassThrough();
  stream.end();
  return { stream, exec: { inspect: async () => ({ Running: false, ExitCode: 0 }) } };
}

function kubernetesFixture(initialAllocation = "10737418240") {
  const deployment = {
    metadata: { annotations: { [MANAGED_ANNOTATION]: JSON.stringify(managedNames) } },
    spec: {
      template: {
        metadata: {},
        spec: {
          containers: [
            {
              name: "agent",
              env: [
                { name: "AGENT_ID", value: "agent-1" },
                { name: HEADMASTER_STORAGE_ENV, value: initialAllocation },
              ],
            },
          ],
        },
      },
    },
  };
  let secret = { metadata: { name: "nora-hermes-test-env" }, data: {} };
  // Use the real updater, namespace lookup and secret writer, replacing only
  // the Kubernetes API transport with in-memory resources.
  const backend = Object.assign(Object.create(K8sBackend.prototype), {
    namespace: "agents",
    runtimeNamespaces: { hermes: "agents" },
    appsApi: {
      readNamespacedDeployment: async () => structuredClone(deployment),
      patchNamespacedDeployment: async ({ body }) => {
        for (const { path, value } of body) {
          const keys = path.slice(1).split("/");
          const target = keys.slice(0, -1).reduce((obj, key) => obj[key], deployment);
          target[keys.at(-1)] = structuredClone(value);
        }
      },
    },
    coreApi: {
      readNamespacedSecret: async () => structuredClone(secret),
      replaceNamespacedSecret: async ({ body }) => {
        secret = {
          ...body,
          data: {
            ...body.data,
            ...Object.fromEntries(
              Object.entries(body.stringData || {}).map(([key, value]) => [
                key,
                Buffer.from(value).toString("base64"),
              ]),
            ),
          },
        };
      },
    },
    exec: async () => successfulExec(),
  });
  return {
    backend,
    startupEnv() {
      const env = Object.fromEntries(
        deployment.spec.template.spec.containers[0].env.map((entry) => [
          entry.name,
          entry.valueFrom
            ? Buffer.from(secret.data[entry.valueFrom.secretKeyRef.key] || "", "base64").toString()
            : entry.value,
        ]),
      );
      const state = JSON.parse(Buffer.from(env[STATE_ENV], "base64").toString());
      for (const name of state.managedNames) delete env[name];
      return { ...env, ...state.values };
    },
  };
}

function dockerFixture() {
  let state = { managedNames, values: { [HEADMASTER_STORAGE_ENV]: "10737418240" } };
  const backend = Object.assign(Object.create(HermesBackend.prototype), {
    docker: { getContainer: () => ({}) },
    _readManagedEnvState: async () => state,
    _managedEnvFileOwnership: async () => ({}),
    _putBootstrapFiles: async (_container, files) => {
      state = JSON.parse(files.find((file) => file.name.endsWith("state.json")).content);
    },
    exec: async () => successfulExec(),
    restart: async () => {},
  });
  return { backend, startupEnv: () => state.values };
}

function reconcile(fixture, bootstrappedProviderFingerprint = null, resolvedBackend = "k8s") {
  return reconcileRuntimeLlmAuth({
    agentId: "agent-1",
    userId: "operator",
    runtimeFamily: "hermes",
    containerId: "nora-hermes-test",
    resolvedBackend,
    provisioner: fixture.backend,
    bootstrappedProviderFingerprint,
  });
}

test("Kubernetes worker reconciliation retains canonical storage across credential replacement", async () => {
  agentRow = { external_namespace: "headmaster", disk_gb: 10 };
  integrationEnv = { INTEGRATION_TOKEN: "first-token" };
  const fixture = kubernetesFixture();
  const first = await reconcile(fixture);
  assert.equal(first.status, "synced");
  assert.equal(fixture.startupEnv()[HEADMASTER_STORAGE_ENV], String(10 * 1024 ** 3));

  integrationEnv = { INTEGRATION_TOKEN: "rotated-token", [HEADMASTER_STORAGE_ENV]: "999" };
  const rotated = await reconcile(fixture, first.providerFingerprint);
  assert.equal(rotated.status, "synced");
  assert.equal(fixture.startupEnv().INTEGRATION_TOKEN, "rotated-token");
  assert.equal(fixture.startupEnv()[HEADMASTER_STORAGE_ENV], String(10 * 1024 ** 3));
  assert.equal(fixture.startupEnv().AGENT_ID, "agent-1");
  assert.equal((await reconcile(fixture, rotated.providerFingerprint)).status, "skipped");
});

test("a changed canonical allocation is reconciled with otherwise unchanged credentials", async () => {
  agentRow = { external_namespace: "headmaster", disk_gb: 10 };
  integrationEnv = {};
  const fixture = kubernetesFixture();
  const first = await reconcile(fixture);
  agentRow = { ...agentRow, disk_gb: 20 };
  assert.equal((await reconcile(fixture, first.providerFingerprint)).status, "synced");
  assert.equal(fixture.startupEnv()[HEADMASTER_STORAGE_ENV], String(20 * 1024 ** 3));
  const current = await reconcile(fixture);
  agentRow = { ...agentRow, disk_gb: null };
  const cleared = await reconcile(fixture, current.providerFingerprint);
  assert.equal(cleared.status, "synced");
  assert.ok(!fixture.startupEnv()[HEADMASTER_STORAGE_ENV]);
  assert.equal((await reconcile(fixture, cleared.providerFingerprint)).status, "skipped");
});

test("missing or invalid canonical storage revokes a stale or forged Kubernetes allocation", async () => {
  for (const disk_gb of [undefined, null, 0, -1, 1.5, "10", "invalid", Number.MAX_SAFE_INTEGER]) {
    agentRow = { external_namespace: "headmaster", disk_gb };
    integrationEnv = { [HEADMASTER_STORAGE_ENV]: "999" };
    const fixture = kubernetesFixture();
    assert.equal((await reconcile(fixture)).status, "synced");
    assert.ok(!fixture.startupEnv()[HEADMASTER_STORAGE_ENV], `disk_gb=${disk_gb}`);
  }
});

test("an ordinary Hermes runtime cannot adopt an integration's forged storage allocation", async () => {
  agentRow = { external_namespace: null, disk_gb: 10 };
  integrationEnv = { [HEADMASTER_STORAGE_ENV]: "999" };
  const fixture = kubernetesFixture();
  assert.equal((await reconcile(fixture)).status, "synced");
  assert.ok(!fixture.startupEnv()[HEADMASTER_STORAGE_ENV]);
});

test("Docker's actual managed-state updater retains canonical storage and clears invalid metadata", async () => {
  agentRow = { external_namespace: "headmaster", disk_gb: 10 };
  integrationEnv = { [HEADMASTER_STORAGE_ENV]: "999" };
  const fixture = dockerFixture();
  const first = await reconcile(fixture, null, "docker");
  assert.equal(first.status, "synced");
  assert.equal(fixture.startupEnv()[HEADMASTER_STORAGE_ENV], String(10 * 1024 ** 3));
  agentRow = { ...agentRow, disk_gb: null };
  assert.equal((await reconcile(fixture, first.providerFingerprint, "docker")).status, "synced");
  assert.ok(!fixture.startupEnv()[HEADMASTER_STORAGE_ENV]);
});
