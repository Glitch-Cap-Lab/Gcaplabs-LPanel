// @ts-nocheck
const mockDb = { query: jest.fn() };
const mockSync = jest.fn();
const mockResume = jest.fn();
const mockLock = jest.fn(async (_owner, fn) => fn());
jest.mock("../db", () => mockDb);
jest.mock("../authSync", () => ({
  syncAuthToUserAgents: mockSync,
  resumeAgentWithProviderAuth: mockResume,
  PROVIDER_AUTH_QUARANTINE_REASON: "provider_auth_reconciliation_failed",
}));
jest.mock("../llmProviders", () => ({ withProviderStateLock: mockLock }));
const { updateManagedConfig, managedConfigStatus, validateConfig } = require("../headmasterConfig");
const owner = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const workspace = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const body = {
  expected_revision: 0,
  owner_uuid: owner,
  workspace_uuid: workspace,
  memory_bank_id: `hermes-u-${owner.replace(/-/g, "_")}`,
  memory_gateway_url: "http://memory:8888",
};
let row;
beforeEach(() => {
  jest.clearAllMocks();
  row = {
    id: "agent",
    user_id: "operator",
    runtime_family: "hermes",
    external_namespace: "headmaster",
    external_owner_uuid: owner,
    external_id: workspace,
    headmaster_integration_desired_revision: 0,
    headmaster_integration_applied_revision: 0,
  };
  mockSync.mockReset().mockResolvedValue([{ agentId: row.id, status: "synced" }]);
  mockDb.query.mockReset().mockImplementation(async (sql, params) => {
    if (sql.includes("SET headmaster_owner_id")) {
      [
        row.headmaster_owner_id,
        row.headmaster_workspace_id,
        row.headmaster_memory_bank_id,
        row.headmaster_memory_gateway_url,
      ] = params;
      row.headmaster_integration_desired_revision++;
      row.headmaster_integration_deployment_status = "pending";
    } else if (sql.includes("SET headmaster_integration_applied_revision")) {
      if (params[2]) row.headmaster_integration_applied_revision = params[1];
      row.headmaster_integration_deployment_status = params[3];
    }
    return { rows: [{ ...row }] };
  });
});
test("saves, applies through the full sync under its owner lock, and returns names only", async () => {
  expect(await updateManagedConfig(row, body)).toEqual({
    integration_key_names: [
      "HEADMASTER_OWNER_ID",
      "HEADMASTER_WORKSPACE_ID",
      "HEADMASTER_MEMORY_BANK_ID",
      "HEADMASTER_MEMORY_GATEWAY_URL",
    ],
    desired_revision: 1,
    applied_revision: 1,
    deployment_status: "applied",
  });
  expect(mockLock).toHaveBeenCalledWith("operator", expect.any(Function));
  expect(mockSync).toHaveBeenCalledWith("operator", "agent", {
    providerLockHeld: true,
    apiKeyWorkspaceId: null,
  });
});
test("identical applied patch and retry do not write or restart", async () => {
  await updateManagedConfig(row, body);
  mockDb.query.mockClear();
  mockSync.mockClear();
  await updateManagedConfig(row, body);
  await updateManagedConfig(row, null, { retry: true });
  expect(mockDb.query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true);
  expect(mockSync).not.toHaveBeenCalled();
});
test.each([
  [],
  [{ agentId: "agent", status: "failed" }],
  [{ agentId: "agent", status: "skipped" }],
  [{ agentId: "agent", status: "synced", staged: true }],
])("does not acknowledge non-applied sync result %#", async (...args) => {
  mockSync.mockResolvedValue(args);
  const result = await updateManagedConfig(row, body);
  expect(result).toMatchObject({
    desired_revision: 1,
    applied_revision: 0,
    deployment_status: "failed",
  });
});
test("thrown apply failure remains retryable and retry does not increment desired revision", async () => {
  mockSync.mockRejectedValueOnce(new Error("private runtime error"));
  expect(await updateManagedConfig(row, body)).toMatchObject({
    desired_revision: 1,
    applied_revision: 0,
    deployment_status: "failed",
  });
  expect(await updateManagedConfig(row, null, { retry: true })).toMatchObject({
    desired_revision: 1,
    applied_revision: 1,
    deployment_status: "applied",
  });
});
test("rejects stale changes, foreign identity, unsupported runtime and empty retries", async () => {
  await expect(updateManagedConfig(row, { ...body, expected_revision: 2 })).rejects.toMatchObject({
    statusCode: 409,
  });
  row.external_id = owner;
  await expect(updateManagedConfig(row, body)).rejects.toMatchObject({ statusCode: 409 });
  row.runtime_family = "openclaw";
  await expect(updateManagedConfig(row, body)).rejects.toMatchObject({ statusCode: 400 });
  row.runtime_family = "hermes";
  await expect(updateManagedConfig(row, null, { retry: true })).rejects.toMatchObject({
    statusCode: 400,
  });
  expect(mockSync).not.toHaveBeenCalled();
});
test.each([
  { expected_revision: -1 },
  { expected_revision: "0" },
  { owner_uuid: "invalid" },
  { memory_bank_id: "foreign" },
  { memory_gateway_url: "file:///tmp/x" },
  { memory_gateway_url: "https://user:password@example.com" },
])("validates config %j", (patch) => {
  expect(() => validateConfig({ ...body, ...patch })).toThrow();
});
test("fresh status is unconfigured", () => {
  expect(managedConfigStatus(row)).toEqual({
    integration_key_names: [],
    desired_revision: 0,
    applied_revision: 0,
    deployment_status: "unconfigured",
  });
});

test("retry safely starts an auth-quarantined runtime and waits for lifecycle success", async () => {
  mockSync.mockRejectedValueOnce(new Error("failed"));
  await updateManagedConfig(row, body);
  row.status = "stopped";
  row.paused_reason = "provider_auth_reconciliation_failed";
  mockResume.mockResolvedValue({ syncResult: { status: "synced" } });
  expect(await updateManagedConfig(row, null, { retry: true })).toMatchObject({
    applied_revision: 1,
    deployment_status: "applied",
  });
  expect(mockResume).toHaveBeenCalledWith(expect.objectContaining({ id: "agent" }), "start", {
    providerLockHeld: true,
  });
});

test("concurrent duplicate requests reconcile once after re-reading under the lock", async () => {
  let tail = Promise.resolve();
  mockLock.mockImplementation((_owner, operation) => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  });
  const [first, second] = await Promise.all([
    updateManagedConfig(row, body),
    updateManagedConfig(row, body),
  ]);
  expect(first).toEqual(second);
  expect(mockSync).toHaveBeenCalledTimes(1);
  expect(row.headmaster_integration_desired_revision).toBe(1);
});

test("deployment metadata is complete, private and bound to the same immutable identity", () => {
  const { deploymentConfig } = require("../headmasterConfig");
  const config = { ...body, memory_gateway_url: "http://headmaster-memory-gateway:8791" };
  const input = {
    external_identity: {
      namespace: "headmaster",
      external_id: config.workspace_uuid,
      owner_uuid: config.owner_uuid,
    },
    headmaster_integration_config: config,
  };
  expect(deploymentConfig({}, "hermes")).toBeNull();
  expect(deploymentConfig(input, "hermes")).toEqual([
    config.owner_uuid,
    config.workspace_uuid,
    config.memory_bank_id,
    config.memory_gateway_url,
  ]);
  expect(() => deploymentConfig(input, "openclaw")).toThrow();
  expect(() =>
    deploymentConfig(
      { ...input, external_identity: { ...input.external_identity, owner_uuid: "another-owner" } },
      "hermes",
    ),
  ).toThrow();
  expect(() =>
    deploymentConfig({ external_identity: input.external_identity }, "hermes"),
  ).toThrow();
  expect(() =>
    deploymentConfig(
      {
        ...input,
        headmaster_integration_config: {
          ...config,
          memory_gateway_url: "http://headmaster-hindsight:8888",
        },
      },
      "hermes",
    ),
  ).toThrow();
});

test("managed allocation comes from a canonical selected row, and missing values revoke it", () => {
  const {
    headmasterEnv,
    HEADMASTER_AGENT_COLUMNS,
    HEADMASTER_ENV_NAMES,
  } = require("../headmasterConfig");
  const selectedRow = Object.fromEntries(
    HEADMASTER_AGENT_COLUMNS.map((column) => [column, "value"]),
  );
  selectedRow.disk_gb = 10;
  const env = headmasterEnv(selectedRow);
  expect(Object.keys(env).filter((key) => env[key])).toEqual(HEADMASTER_ENV_NAMES);
  expect(env.HEADMASTER_STORAGE_ALLOCATION_BYTES).toBe(String(10 * 1024 ** 3));
  expect(
    headmasterEnv({ ...selectedRow, disk_gb: undefined }).HEADMASTER_STORAGE_ALLOCATION_BYTES,
  ).toBeUndefined();
  expect(headmasterEnv({ disk_gb: 10 }).HEADMASTER_STORAGE_ALLOCATION_BYTES).toBeUndefined();
});

test("customer template env cannot preserve reserved identity or storage inputs", () => {
  const { withoutHeadmasterEnv } = require("../headmasterConfig");
  expect(
    withoutHeadmasterEnv({
      HEADMASTER_OWNER_ID: "spoof",
      HEADMASTER_STORAGE_ALLOCATION_BYTES: "999",
      GITHUB_TOKEN: "keep",
    }),
  ).toEqual({ GITHUB_TOKEN: "keep" });
});
