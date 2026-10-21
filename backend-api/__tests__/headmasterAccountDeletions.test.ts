// @ts-nocheck
const { createDeletionClient, DELETION_STEPS } = require("../headmasterAccountDeletions");
const ENV = { HEADMASTER_SUPABASE_URL: "https://project.example", HEADMASTER_SUPABASE_SERVICE_ROLE_KEY: "test-service-key" };
const OWNER = "11111111-2222-3333-4444-555555555555";
const AGENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const AGENT2 = "aaaaaaaa-bbbb-cccc-dddd-ffffffffffff";
const BANK = `hermes-u-${OWNER.replace(/-/g, "_")}`;
const WORKSPACE = "00000000-0000-0000-0000-000000000001";
const binding = (agent = AGENT, workspace = WORKSPACE) => ({ workspace_id: workspace, nora_agent_id: agent, hindsight_bank_id: BANK, workspaces: { owner_id: OWNER } });
const targets = (bindings = [binding()]) => ({ version: 1, owner_id: OWNER, bindings: bindings.map((b) => ({ workspace_id: b.workspace_id, agent_id: b.nora_agent_id, bank_id: b.hindsight_bank_id })) });
const ok = (body = {}) => ({ ok: true, status: 200, json: async () => structuredClone(body) });
const fail = (status = 500, body = {}) => ({ ok: false, status, json: async () => body });
const receiptRow = (extra = {}) => ({ id: "r1", owner_id: OWNER, status: "failed", steps: {}, cleanup_targets: targets(), cleanup_results: {}, ...extra });
function fixture({ row = null, bindings = [binding()], intercept = () => null, cleanupOps } = {}) {
  let current = row && structuredClone(row);
  const calls = [];
  const fetchImpl = jest.fn(async (url, init = {}) => {
    const parsed = new URL(url), method = init.method || "GET";
    const body = init.body && JSON.parse(init.body);
    calls.push({ path: parsed.pathname, query: parsed.searchParams, method, body });
    const override = await intercept({ url: parsed, method, body, current, calls, set: (value) => { current = value; } });
    if (override) return override;
    if (parsed.pathname.endsWith("/headmaster_begin_account_deletion")) {
      current = receiptRow({ status: "running", steps: { revoke_sessions: "done" }, cleanup_targets: targets(bindings) });
      return ok([current]);
    }
    if (parsed.pathname.endsWith("/headmaster_account_deletion_requests")) {
      if (method === "POST") { current = { ...body, id: "r1" }; return ok([current]); }
      if (method === "GET") return ok(current ? [current] : []);
      if (method === "PATCH") {
        for (const field of ["status", "steps", "cleanup_results"]) {
          const actual = field === "status" ? current[field] : JSON.stringify(current[field] || {});
          if (parsed.searchParams.get(field) !== `eq.${actual}`) return ok([]);
        }
        current = { ...current, ...body };
        return ok([current]);
      }
    }
    if (parsed.pathname.endsWith("/headmaster_bump_account_revocation")) return ok(1);
    if (parsed.pathname.endsWith("/headmaster_push_registration_purge_owner")) return ok(2);
    return ok();
  });
  const ops = cleanupOps || { cloud_runtime: jest.fn(async () => ({ done: true })), memory_bank: jest.fn(async () => ({ done: true })), relay_usage: jest.fn(async () => ({ done: true })) };
  return { client: createDeletionClient({ env: ENV, fetchImpl, cleanupOps: ops }), fetchImpl, calls, ops, read: () => current };
}
const authCalls = (f) => f.calls.filter((c) => c.path.includes("/auth/v1/admin/users/"));

describe("durable account deletion", () => {
  test("requires configuration and valid owner", async () => {
    expect(createDeletionClient({ env: {} })).toBeNull();
    await expect(fixture().client.deleteAccount("bad", "ops")).rejects.toThrow("owner_invalid");
  });
  test("consumes the atomic authoritative snapshot and completes real cleanup for all bindings", async () => {
    const f = fixture({ bindings: [binding(), binding(AGENT2, "00000000-0000-0000-0000-000000000002")] });
    const row = await f.client.deleteAccount(OWNER.toUpperCase(), "ops");
    expect(row.status).toBe("completed");
    expect(DELETION_STEPS.every((s) => row.steps[s] === "done")).toBe(true);
    expect(row.cleanup_targets.bindings).toHaveLength(2);
    expect(f.ops.cloud_runtime.mock.calls).toEqual([[OWNER, AGENT], [OWNER, AGENT2]]);
    expect(f.ops.memory_bank).toHaveBeenCalledTimes(1);
    expect(f.ops.relay_usage).toHaveBeenCalledWith(OWNER, OWNER);
    expect(f.calls[0].path).toBe("/rest/v1/rpc/headmaster_begin_account_deletion");
    expect(f.calls[0].body).toEqual({ p_owner_id: OWNER, p_email: null, p_source: "admin" });
    expect(f.calls.some((c) => c.path.endsWith("/headmaster_bump_account_revocation"))).toBe(false);
    expect(f.calls.some((c) => c.path.endsWith("/headmaster_runtime_bindings"))).toBe(false);
    expect(row.completed_by).toBe("ops");
  });
  test.each(["rpc", "snapshot", "results", "revocation", "receipt"])("%s persistence failure stops Auth deletion", async (kind) => {
    const f = fixture({ intercept: ({ url, method, body }) => {
      if (url.pathname.endsWith("/headmaster_begin_account_deletion")) {
        if (kind === "rpc") return fail();
        if (kind === "snapshot") return ok([receiptRow({ status: "running", cleanup_targets: undefined })]);
        if (kind === "results") return ok([receiptRow({ status: "running", cleanup_results: undefined })]);
        if (kind === "revocation") return ok([receiptRow({ status: "running", steps: {} })]);
      }
      if (kind === "receipt" && method === "PATCH" && body.cleanup_results) return fail();
    } });
    await expect(f.client.deleteAccount(OWNER, "ops")).rejects.toThrow();
    expect(authCalls(f)).toHaveLength(0);
    if (kind !== "receipt") expect(f.ops.cloud_runtime).not.toHaveBeenCalled();
    expect(f.calls.some((c) => c.path.endsWith("/headmaster_runtime_bindings"))).toBe(false);
  });
  test.each(["deletion_busy", "deletion_already_requested", "deletion_targets_unresolved"])("atomic authority %s prevents cleanup without fallback", async (message) => {
    const f = fixture({ intercept: ({ url }) => url.pathname.endsWith("/headmaster_begin_account_deletion") ? fail(400, { message }) : null });
    await expect(f.client.deleteAccount(OWNER, "ops")).rejects.toMatchObject({ message, statusCode: 409 });
    expect(f.calls).toHaveLength(1);
    expect(f.ops.cloud_runtime).not.toHaveBeenCalled();
  });
  test("per-target receipt failure stops the next destructive effect", async () => {
    const f = fixture({ bindings: [binding(), binding(AGENT2, "00000000-0000-0000-0000-000000000002")], intercept: ({ method, body }) => {
      if (method === "PATCH" && body.cleanup_results?.cloud_runtime?.[AGENT]) return fail();
    } });
    await expect(f.client.deleteAccount(OWNER, "ops")).rejects.toThrow("deletion_update_failed");
    expect(f.ops.cloud_runtime).toHaveBeenCalledTimes(1);
    expect(f.ops.memory_bank).not.toHaveBeenCalled();
    expect(authCalls(f)).toHaveLength(0);
  });
  test("revocation failure prevents Auth; both steps can later be retried", async () => {
    let unavailable = true;
    const steps = Object.fromEntries(DELETION_STEPS.map((s) => [s, "done"]));
    const f = fixture({ row: receiptRow({ steps: { ...steps, revoke_sessions: "failed", auth_user: "skipped" } }), intercept: ({ url }) => unavailable && url.pathname.endsWith("/headmaster_bump_account_revocation") ? fail() : null });
    expect((await f.client.completeStep("r1", "revoke_sessions", "ops")).steps.revoke_sessions).toBe("failed");
    expect((await f.client.completeStep("r1", "auth_user", "ops")).steps.auth_user).toBe("skipped");
    expect(authCalls(f)).toHaveLength(0);
    unavailable = false;
    await f.client.completeStep("r1", "revoke_sessions", "ops");
    expect((await f.client.completeStep("r1", "auth_user", "ops")).status).toBe("completed");
  });
  test("push and Auth failures remain failed and have real retry operations", async () => {
    let unavailable = true;
    const f = fixture({ intercept: ({ url }) => unavailable && (url.pathname.includes("/auth/v1/") || url.pathname.endsWith("/headmaster_push_registration_purge_owner")) ? fail() : null });
    const row = await f.client.deleteAccount(OWNER, "ops");
    expect(row.steps).toMatchObject({ push_registrations: "failed", auth_user: "failed" });
    unavailable = false;
    await f.client.completeStep("r1", "push_registrations", "ops");
    expect((await f.client.completeStep("r1", "auth_user", "ops")).status).toBe("completed");
  });
  test("cleanup survives restart after Auth and bindings are gone; only failed targets replay", async () => {
    const row = receiptRow({ steps: { revoke_sessions: "done", push_registrations: "done", auth_user: "done", cloud_runtime: "failed", memory_bank: "done", relay_usage: "done" }, cleanup_targets: targets([binding(), binding(AGENT2, WORKSPACE)]), cleanup_results: { cloud_runtime: { [AGENT]: "done", [AGENT2]: "failed" } } });
    const f = fixture({ row, bindings: [] });
    expect((await f.client.completeStep("r1", "cloud_runtime", "ops")).status).toBe("completed");
    expect(f.ops.cloud_runtime.mock.calls).toEqual([[OWNER, AGENT2]]);
    expect(f.calls.some((c) => c.path.endsWith("/headmaster_runtime_bindings"))).toBe(false);
  });
  test.each([{ bindings: [] }, { bindings: [binding()] }])("bank finalizer runs with empty targets or existing successful bank receipts", async ({ bindings }) => {
    let unavailable = true;
    const row = receiptRow({ cleanup_targets: targets(bindings), cleanup_results: { memory_bank: { [BANK]: "done" } } });
    const f = fixture({ row, intercept: ({ url }) => unavailable && url.pathname.endsWith("/headmaster_delete_hindsight_tenant") ? fail() : null });
    expect((await f.client.completeStep("r1", "memory_bank", "ops")).steps.memory_bank).toBe("failed");
    unavailable = false;
    expect((await f.client.completeStep("r1", "memory_bank", "ops")).steps.memory_bank).toBe("done");
    expect(f.ops.memory_bank).not.toHaveBeenCalled();
    expect(f.calls.filter((c) => c.path.endsWith("/headmaster_delete_hindsight_tenant"))).toHaveLength(2);
  });
  test("does not mark a failed actual wipe done", async () => {
    const f = fixture({ row: receiptRow(), cleanupOps: { cloud_runtime: async () => { throw Error("unavailable"); } } });
    const row = await f.client.completeStep("r1", "cloud_runtime", "ops");
    expect(row.steps.cloud_runtime).toBe("failed");
    expect(row.cleanup_results.cloud_runtime[AGENT]).toBe("failed");
    expect(row.status).toBe("failed");
  });
  test("valid empty snapshots still wipe the canonical owner bank before tenant removal", async () => {
    const f = fixture({ row: receiptRow({ cleanup_targets: targets([]) }) });
    expect((await f.client.completeStep("r1", "memory_bank", "ops")).steps.memory_bank).toBe("done");
    expect(f.ops.memory_bank).toHaveBeenCalledWith(OWNER, BANK);
    expect(f.calls.some((c) => c.path.endsWith("/headmaster_delete_hindsight_tenant"))).toBe(true);
  });
  test("two operators retrying different steps cannot overwrite each other's progress", async () => {
    let releaseCloud, releaseRelay;
    const cloud = new Promise((resolve) => { releaseCloud = resolve; });
    const relay = new Promise((resolve) => { releaseRelay = resolve; });
    const ops = { cloud_runtime: jest.fn(() => cloud), relay_usage: jest.fn(() => relay) };
    const f = fixture({ row: receiptRow({ status: "running" }), cleanupOps: ops });
    const cloudRun = f.client.completeStep("r1", "cloud_runtime", "ops1");
    const relayRun = f.client.completeStep("r1", "relay_usage", "ops2");
    while (!ops.cloud_runtime.mock.calls.length || !ops.relay_usage.mock.calls.length) await new Promise((resolve) => setImmediate(resolve));
    releaseCloud({ done: true });
    await cloudRun;
    releaseRelay({ done: true });
    await expect(relayRun).rejects.toMatchObject({ message: "deletion_conflict", statusCode: 409 });
    expect(f.read().steps.cloud_runtime).toBe("done");
    expect(f.read().cleanup_results.cloud_runtime[AGENT]).toBe("done");
    expect(f.read().cleanup_results.relay_usage).toBeUndefined();
  });
  test("legacy null snapshots and invalid foreign banks never become completed", async () => {
    for (const cleanup_targets of [null, { ...targets(), bindings: [{ workspace_id: WORKSPACE, agent_id: AGENT, bank_id: `hermes-u-${AGENT.replace(/-/g, "_")}` }] }]) {
      const f = fixture({ row: receiptRow({ cleanup_targets, steps: Object.fromEntries(DELETION_STEPS.map((s) => [s, "done"])) }) });
      await expect(f.client.completeStep("r1", "relay_usage", "ops")).rejects.toThrow(/cleanup_targets/);
      expect(f.calls.some((c) => c.method === "PATCH")).toBe(false);
    }
  });
  test("recovers running rows but CAS refuses to overwrite another caller's progress", async () => {
    const f = fixture({ row: receiptRow({ status: "running" }), intercept: ({ method, body, current, set }) => {
      if (method === "PATCH" && body.cleanup_results) {
        set({ ...current, steps: { ...current.steps, push_registrations: "done" } });
      }
    } });
    await expect(f.client.completeStep("r1", "cloud_runtime", "ops")).rejects.toMatchObject({ message: "deletion_conflict", statusCode: 409 });
    expect(f.read().steps.push_registrations).toBe("done");
    expect(f.read().cleanup_results).toEqual({});
  });
  test("push device cleanup is the service-only purge RPC for this owner, with a legacy fallback only when the function is missing", async () => {
    const run = async (rpcAnswer) => {
      const f = fixture({ row: receiptRow({ status: "running", steps: { revoke_sessions: "done" } }), intercept: ({ url }) => url.pathname.endsWith("/headmaster_push_registration_purge_owner") ? rpcAnswer : null });
      const row = await f.client.completeStep("r1", "push_registrations", "ops");
      return { row, calls: f.calls.filter((c) => c.path.includes("headmaster_push_registration")) };
    };
    const ok1 = await run(null);
    expect(ok1.row.steps.push_registrations).toBe("done");
    expect(ok1.calls).toEqual([expect.objectContaining({ path: expect.stringMatching(/\/rpc\/headmaster_push_registration_purge_owner$/), method: "POST", body: { p_owner_id: OWNER } })]);
    // Function not created yet (migration unapplied): the old owner-scoped delete still works.
    const legacy = await run(fail(404, { code: "PGRST202" }));
    expect(legacy.row.steps.push_registrations).toBe("done");
    expect(legacy.calls.map((c) => [c.method, c.query.get("owner_id")])).toEqual([["POST", null], ["DELETE", `eq.${OWNER}`]]);
    // Anything else, including a plain 404 or a non-count answer, never records the step as done.
    for (const answer of [fail(404, {}), fail(500, {}), ok({}), ok("x")]) {
      const bad = await run(answer);
      expect(bad.row.steps.push_registrations).toBe("failed");
      expect(bad.calls.some((c) => c.method === "DELETE")).toBe(false);
    }
  });
  test("Auth missing receipt can be recovered only for a precise user-not-found response", async () => {
    const f = fixture({ row: receiptRow({ steps: { revoke_sessions: "done" } }), intercept: ({ url }) => url.pathname.includes("/auth/v1/") ? fail(404, { code: "user_not_found" }) : null });
    expect((await f.client.completeStep("r1", "auth_user", "ops")).steps.auth_user).toBe("done");
  });
  test("grace sweeper wipes each claimed account as the owner's own request and keeps going past a failure", async () => {
    const OTHER = "22222222-3333-4444-5555-666666666666";
    const log = { error: jest.fn() };
    const f = fixture({ intercept: ({ url, body }) => {
      if (url.pathname.endsWith("/headmaster_claim_due_account_deletions")) return ok([{ owner_id: OTHER, email: null }, { owner_id: OWNER, email: "a@example.test" }]);
      if (url.pathname.endsWith("/headmaster_begin_account_deletion") && body.p_owner_id === OTHER) return fail(400, { message: "deletion_busy" });
      return null;
    } });
    const results = await f.client.sweepDueDeletions({ limit: 5, log });
    expect(f.calls[0]).toMatchObject({ path: "/rest/v1/rpc/headmaster_claim_due_account_deletions", body: { p_limit: 5 } });
    const begins = f.calls.filter((c) => c.path.endsWith("/headmaster_begin_account_deletion")).map((c) => c.body);
    expect(begins).toEqual([{ p_owner_id: OTHER, p_email: null, p_source: "app" }, { p_owner_id: OWNER, p_email: "a@example.test", p_source: "app" }]);
    expect(results).toEqual([{ owner_id: OTHER, status: "error", error: "deletion_busy" }, { owner_id: OWNER, status: "completed" }]);
    expect(f.read().completed_by).toBe("grace-sweeper");
    expect(log.error).toHaveBeenCalledTimes(1);
  });
  test("grace sweeper does nothing when nothing is due and reports a failed claim", async () => {
    const none = fixture({ intercept: ({ url }) => url.pathname.endsWith("/headmaster_claim_due_account_deletions") ? ok([]) : null });
    expect(await none.client.sweepDueDeletions()).toEqual([]);
    expect(none.calls).toHaveLength(1);
    const broken = fixture({ intercept: ({ url }) => url.pathname.endsWith("/headmaster_claim_due_account_deletions") ? fail(404) : null });
    await expect(broken.client.sweepDueDeletions()).rejects.toThrow("deletion_claim_failed");
  });
  test("requires all six successful steps for completed", async () => {
    const f = fixture({ row: receiptRow({ steps: { relay_usage: "pending_operator" } }) });
    expect((await f.client.completeStep("r1", "relay_usage", "ops")).status).toBe("needs_operator");
    await expect(f.client.completeStep("r1", "anything", "ops")).rejects.toThrow("step_invalid");
  });
});
