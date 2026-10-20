// @ts-nocheck
const express = require("express");
const request = require("supertest");
const { inspectProvisionRecovery, recoverProvisionIdentity } = require("../headmasterProvisionRecovery");
const { bindExternalIdentity } = require("../headmasterIdentityBinding");
const { buildRouter } = require("../routes/adminHeadmasterAccounts");
const { createAccountAdminClient } = require("../headmasterAccountAdmins");
const OWNER = "11111111-1111-4111-8111-111111111111", WORKSPACE = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333", JOB = "44444444-4444-4444-8444-444444444444";
const identity = { namespace: "headmaster", ownerUuid: OWNER, externalId: WORKSPACE };
const agent = () => ({ id: AGENT, user_id: "operator", external_namespace: "headmaster", external_owner_uuid: OWNER, external_id: WORKSPACE, runtime_family: "hermes", status: "running", gateway_token: "never-return" });
const job = () => ({ id: JOB, owner_id: OWNER, workspace_id: WORKSPACE, desired_action: "provision", status: "failed", step: "deploying", nora_agent_id: null, fence: 7, authorization_revision: 3, workspaces: { owner_id: OWNER } });
const expected = () => ({ candidateAgentId: AGENT, expectedFence: 7, expectedJobAuthorizationRevision: 3, expectedOwnerAuthorizationRevision: 9 });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function locks() {
  const tails = new Map(), entered = [];
  return { entered, acquireLock: jest.fn(async (key) => {
    const previous = tails.get(key) || Promise.resolve();
    const held = deferred(); tails.set(key, previous.then(() => held.promise));
    await previous; entered.push(key);
    return { release: jest.fn(async () => held.resolve()) };
  }) };
}
function fixture({ rows = [agent()], selectedJob = job(), currentRevision = 9 } = {}) {
  const mutex = locks();
  const db = { query: jest.fn(async (sql, params) => {
    if (sql.includes("external_namespace = 'headmaster'")) return { rows: rows.filter((r) => r.external_namespace === "headmaster" && r.external_owner_uuid === params[0] && r.external_id === params[1]) };
    if (sql.trim().startsWith("UPDATE agents")) return { rows: [] };
    if (sql.includes("WHERE id = $1")) return { rows: rows.filter((r) => r.id === params[0]) };
    throw Error("unexpected query");
  }) };
  const client = { recoveryAuthority: jest.fn(async () => ({ owner_id: OWNER, authorization_revision: currentRevision })), recoveryJobs: jest.fn(async () => [selectedJob]),
    recoverProvisionJob: jest.fn(async (j, _a, agentId) => ({ ...j, nora_agent_id: agentId })) };
  return { db, client, mutex, deps: { db, acquireLock: mutex.acquireLock } };
}
describe("provisioning identity recovery", () => {
  test("exposes only a unique immutable owner/workspace proof, not secrets or recorded request keys", async () => {
    const f = fixture(); const result = await inspectProvisionRecovery(f.client, OWNER, f.deps);
    expect(result).toMatchObject({ owner_authorization_revision: 9, request_key_recorded: false, proof: "immutable_owner_workspace", jobs: [{ state: "matched", candidate: { id: AGENT } }] });
    expect(JSON.stringify(result)).not.toContain("never-return");
    expect(f.client.recoverProvisionJob).not.toHaveBeenCalled();
  });
  test("saves only the discovered ID on the authoritative job and preserves old job/current owner revision separately", async () => {
    const f = fixture(); const result = await recoverProvisionIdentity(f.client, OWNER, JOB, expected(), f.deps);
    expect(result.recovered).toBe(true);
    expect(result.job).toMatchObject({ nora_agent_id: AGENT, status: "failed", step: "deploying", fence: 7, authorization_revision: 3 });
    expect(f.client.recoverProvisionJob).toHaveBeenCalledWith(expect.objectContaining({ authorization_revision: 3 }), expect.objectContaining({ authorization_revision: 9 }), AGENT);
    expect(f.mutex.entered).toEqual([`headmaster-identity:${OWNER}:${WORKSPACE}`, AGENT]);
  });
  test.each([[], [agent(), { ...agent(), id: JOB }], [{ ...agent(), external_owner_uuid: JOB }], [{ ...agent(), external_id: JOB }], [{ ...agent(), external_namespace: "other" }], [{ ...agent(), runtime_family: "openclaw" }]])("blocks missing, ambiguous, foreign or unsupported runtimes", async (...rows) => {
    const f = fixture({ rows });
    await expect(recoverProvisionIdentity(f.client, OWNER, JOB, expected(), f.deps)).rejects.toMatchObject({ statusCode: 409 });
    expect(f.client.recoverProvisionJob).not.toHaveBeenCalled();
  });
  test.each([{ status: "running" }, { step: "queued" }, { desired_action: "suspend" }, { nora_agent_id: JOB }])("blocks active/ineligible/already-different job targets", async (change) => {
    const f = fixture({ selectedJob: { ...job(), ...change } });
    await expect(recoverProvisionIdentity(f.client, OWNER, JOB, expected(), f.deps)).rejects.toMatchObject({ statusCode: 409 });
    expect(f.client.recoverProvisionJob).not.toHaveBeenCalled();
  });
  test.each(["expectedFence", "expectedJobAuthorizationRevision", "expectedOwnerAuthorizationRevision"])("rejects stale %s", async (field) => {
    const f = fixture();
    await expect(recoverProvisionIdentity(f.client, OWNER, JOB, { ...expected(), [field]: 1 }, f.deps)).rejects.toThrow("recovery_job_changed");
    expect(f.db.query).not.toHaveBeenCalled();
  });
  test("rejects a foreign authoritative workspace rather than trusting UI fields", async () => {
    const f = fixture({ selectedJob: { ...job(), workspaces: { owner_id: JOB } } });
    await expect(recoverProvisionIdentity(f.client, OWNER, JOB, expected(), f.deps)).rejects.toThrow("recovery_unavailable");
    expect(f.client.recoverProvisionJob).not.toHaveBeenCalled();
  });
  test("rechecks the candidate after acquiring its lifecycle lock", async () => {
    const f = fixture(); f.db.query.mockResolvedValueOnce({ rows: [agent()] }).mockResolvedValueOnce({ rows: [] });
    await expect(recoverProvisionIdentity(f.client, OWNER, JOB, expected(), f.deps)).rejects.toThrow("recovery_identity_mismatch");
    expect(f.client.recoverProvisionJob).not.toHaveBeenCalled();
  });
  test("releases both locks after a failed/timed-out RPC", async () => {
    const f = fixture(); f.client.recoverProvisionJob.mockRejectedValueOnce(Error("timeout"));
    await expect(recoverProvisionIdentity(f.client, OWNER, JOB, expected(), f.deps)).rejects.toThrow("timeout");
    await expect(recoverProvisionIdentity(f.client, OWNER, JOB, expected(), f.deps)).resolves.toMatchObject({ recovered: true });
  });
  test("recovery and adoption serialize across a real asynchronous RPC barrier", async () => {
    const f = fixture(), entered = deferred(), release = deferred();
    f.client.recoverProvisionJob.mockImplementationOnce(async (j) => { entered.resolve(); await release.promise; return { ...j, nora_agent_id: AGENT }; });
    const recovery = recoverProvisionIdentity(f.client, OWNER, JOB, expected(), f.deps); await entered.promise;
    const adoption = bindExternalIdentity(f.db, AGENT, identity, { acquireLock: f.mutex.acquireLock });
    await new Promise((r) => setImmediate(r));
    expect(f.db.query.mock.calls.some(([sql]) => sql.trim().startsWith("UPDATE agents"))).toBe(false);
    release.resolve(); await recovery; expect((await adoption).newlyAdopted).toBe(false);
  });
});

describe("recovery admin boundary and persistence client", () => {
  const makeApp = (f, user = { id: "operator", role: "admin" }, apiKey = null) => {
    const a = express(); a.use((req, _res, next) => { req.user = user; req.apiKey = apiKey; next(); });
    a.use("/accounts", buildRouter({ clientFactory: () => f.client, recoveryDeps: f.deps, recoveryAudit: f.audit || jest.fn() })); return a;
  };
  test.each([{ role: "user" }, { apiKey: true }])("refuses non-admin and API-key recovery", async (auth) => {
    const f = fixture(); const a = makeApp(f, { id: "operator", role: auth.role || "admin" }, auth.apiKey ? { id: "key" } : null);
    await request(a).post(`/accounts/${OWNER}/provision-recovery/${JOB}`).send(expected()).expect(403);
    expect(f.client.recoverProvisionJob).not.toHaveBeenCalled();
  });
  test("only POST saves identity and audit contains bounded proof IDs", async () => {
    const f = fixture(); f.audit = jest.fn(); const a = makeApp(f);
    await request(a).get(`/accounts/${OWNER}/provision-recovery/${JOB}`).expect(404);
    await request(a).put(`/accounts/${OWNER}/provision-recovery/${JOB}`).send(expected()).expect(404);
    await request(a).post(`/accounts/${OWNER}/provision-recovery/${JOB}`).send(expected()).expect(200);
    expect(f.audit).toHaveBeenCalledWith({ actor: "operator", ownerId: OWNER, jobId: JOB, workspaceId: WORKSPACE, agentId: AGENT, proof: "immutable_owner_workspace" });
  });
  test("POST cannot supply a forged owner/workspace or bypass candidate confirmation", async () => {
    const f = fixture();
    await request(makeApp(f)).post(`/accounts/${OWNER}/provision-recovery/${JOB}`).send({ ...expected(), candidateAgentId: JOB, workspaceId: JOB }).expect(409);
    expect(f.client.recoverProvisionJob).not.toHaveBeenCalled();
  });
  test("REST client sends the exact narrow RPC and requires its complete durable response", async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => [{ ...job(), nora_agent_id: AGENT }] }));
    const client = createAccountAdminClient({ env: { HEADMASTER_SUPABASE_URL: "https://example.invalid", HEADMASTER_SUPABASE_SERVICE_ROLE_KEY: "fixture" }, fetchImpl });
    await client.recoverProvisionJob(job(), { authorization_revision: 9 }, AGENT);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://example.invalid/rest/v1/rpc/headmaster_recover_provision_job_identity");
    expect(JSON.parse(init.body)).toEqual({ p_job_id: JOB, p_owner_id: OWNER, p_workspace_id: WORKSPACE, p_expected_fence: 7, p_expected_job_authorization_revision: 3, p_expected_owner_authorization_revision: 9, p_nora_agent_id: AGENT });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    fetchImpl.mockResolvedValueOnce({ ok: true, json: async () => [{ id: JOB }] });
    await expect(client.recoverProvisionJob(job(), { authorization_revision: 9 }, AGENT)).rejects.toThrow("recovery_unavailable");
  });
});
