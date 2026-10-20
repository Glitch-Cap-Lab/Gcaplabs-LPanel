// @ts-nocheck
const express = require("express");
const request = require("supertest");
const { buildRouter } = require("../routes/internalAccountDeletion");

const SECRET = "s".repeat(40);
const AGENT = "11111111-2222-3333-4444-555555555555";
const OWNER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function app(opts) {
  const a = express();
  a.use("/internal", buildRouter({ env: { HEADMASTER_ACCOUNT_DELETION_SECRET: SECRET, HINDSIGHT_API_URL: "http://hindsight.test" }, ...opts }));
  return a;
}

function deps(agent) {
  const calls = [];
  return {
    calls,
    db: { query: jest.fn(async (sql) => { calls.push(sql.split(" ")[0]); return { rows: agent ? [agent] : [] }; }) },
    containerManager: { canDestroy: () => true, destroy: jest.fn(async () => calls.push("destroy")) },
    acquireLock: jest.fn(async () => ({ release: async () => calls.push("release") })),
    releasePort: jest.fn(async () => {}),
    cancelJobs: jest.fn(async () => calls.push("cancel")),
  };
}

describe("internal account deletion", () => {
  test("rejects without the secret", async () => {
    await request(app({ deps: deps(null) })).post("/internal/relay-usage").send({ ownerId: OWNER }).expect(401);
  });

  test("rejects a configured secret shorter than 32 chars even when it matches", async () => {
    const short = "s".repeat(31);
    const a = express(); a.use("/internal", buildRouter({ env: { HEADMASTER_ACCOUNT_DELETION_SECRET: short } }));
    await request(a).post("/internal/relay-usage").set("x-headmaster-internal-secret", short).send({ ownerId: OWNER }).expect(401);
  });

  test("rejects a wrong secret of the right length", async () => {
    await request(app({ deps: deps(null) })).post("/internal/relay-usage")
      .set("x-headmaster-internal-secret", "t".repeat(40)).send({ ownerId: OWNER }).expect(401);
  });

  test("503 when the secret is not configured", async () => {
    const a = express(); a.use("/internal", buildRouter({ env: {} }));
    await request(a).post("/internal/relay-usage").set("x-headmaster-internal-secret", SECRET).expect(503);
  });

  test("cloud runtime: destroys container then deletes the agent row", async () => {
    const d = deps({ id: AGENT, external_namespace: "headmaster", external_owner_uuid: OWNER });
    const res = await request(app({ deps: d })).post("/internal/cloud-runtime")
      .set("x-headmaster-internal-secret", SECRET).send({ agentId: AGENT, ownerId: OWNER }).expect(200);
    expect(res.body).toEqual({ done: true, existed: true });
    expect(d.calls).toEqual(["SELECT", "cancel", "destroy", "DELETE", "release"]);
  });

  test("cloud runtime: missing agent is done", async () => {
    const res = await request(app({ deps: deps(null) })).post("/internal/cloud-runtime")
      .set("x-headmaster-internal-secret", SECRET).send({ agentId: AGENT, ownerId: OWNER }).expect(200);
    expect(res.body.existed).toBe(false);
  });

  test("memory bank: DELETE on Hindsight, 404 counts as done", async () => {
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 404 }));
    const res = await request(app({ deps: deps(null), fetchImpl })).post("/internal/memory-bank")
      .set("x-headmaster-internal-secret", SECRET).send({ bankId: `hermes-u-${OWNER.replace(/-/g, "_")}`, ownerId: OWNER }).expect(200);
    expect(res.body.done).toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toBe(`http://hindsight.test/v1/default/banks/hermes-u-${OWNER.replace(/-/g, "_")}`);
    expect(fetchImpl.mock.calls[0][1].method).toBe("DELETE");
  });

  test("memory bank: a Headmaster bank sends the gateway key and its owner header", async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200 }));
    const a = express();
    a.use("/internal", buildRouter({
      env: { HEADMASTER_ACCOUNT_DELETION_SECRET: SECRET, HINDSIGHT_API_URL: "http://hindsight.test/", HINDSIGHT_API_KEY: "g".repeat(40) },
      deps: deps(null), fetchImpl,
    }));
    const bankId = `hermes-u-${OWNER.replace(/-/g, "_")}`;
    const res = await request(a).post("/internal/memory-bank")
      .set("x-headmaster-internal-secret", SECRET).send({ bankId, ownerId: OWNER }).expect(200);
    expect(res.body).toEqual({ done: true, existed: true });
    expect(fetchImpl.mock.calls[0][0]).toBe(`http://hindsight.test/v1/default/banks/${bankId}`);
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ authorization: `Bearer ${"g".repeat(40)}`, "x-headmaster-owner-id": OWNER });
  });

  test("memory bank: a Hindsight auth failure is reported, not counted as done", async () => {
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 401 }));
    const res = await request(app({ deps: deps(null), fetchImpl })).post("/internal/memory-bank")
      .set("x-headmaster-internal-secret", SECRET).send({ bankId: `hermes-u-${OWNER.replace(/-/g, "_")}`, ownerId: OWNER }).expect(502);
    expect(res.body.error).toBe("hindsight_delete_failed");
  });

  test("relay usage: SCANs both prefixes and deletes owner keys", async () => {
    const redis = {
      scan: jest.fn(async (_c, _m, pattern) => ["0", pattern.startsWith("headmaster-inference:") ? [`headmaster-inference:${OWNER}:day`] : []]),
      del: jest.fn(async (...keys) => keys.length),
    };
    const res = await request(app({ deps: deps(null), redisFactory: () => redis })).post("/internal/relay-usage")
      .set("x-headmaster-internal-secret", SECRET).send({ ownerId: OWNER }).expect(200);
    expect(res.body).toEqual({ done: true, removed: 1 });
    expect(redis.scan.mock.calls.map((c) => c[2])).toEqual([`headmaster-inference:${OWNER}:*`, `headmaster-inference-byo:${OWNER}:*`]);
  });

  test("bad ids are 400", async () => {
    await request(app({ deps: deps(null) })).post("/internal/relay-usage")
      .set("x-headmaster-internal-secret", SECRET).send({ ownerId: "x" }).expect(400);
  });
});


// Missing owner is never a legacy bypass of the tenant boundary.
describe("account deletion owner boundary", () => {
  test("requires owner on runtime and bank calls", async () => {
    await request(app({ deps: deps(null) })).post("/internal/cloud-runtime")
      .set("x-headmaster-internal-secret", SECRET).send({ agentId: AGENT }).expect(400);
    await request(app({ deps: deps(null) })).post("/internal/memory-bank")
      .set("x-headmaster-internal-secret", SECRET).send({ bankId: "hm-bank_1" }).expect(400);
  });
  test.each([{ external_namespace: "other", external_owner_uuid: OWNER }, { external_namespace: "headmaster", external_owner_uuid: AGENT }])("rejects foreign runtime inside the lifecycle lock", async (identity) => {
    const d = deps({ id: AGENT, ...identity });
    const res = await request(app({ deps: d })).post("/internal/cloud-runtime")
      .set("x-headmaster-internal-secret", SECRET).send({ agentId: AGENT, ownerId: OWNER }).expect(409);
    expect(res.body.error).toBe("runtime_owner_mismatch");
    expect(d.calls).toEqual(["SELECT", "release"]);
    expect(d.containerManager.destroy).not.toHaveBeenCalled();
  });
  test("missing destroy support retains runtime row and jobs", async () => {
    const d = deps({ id: AGENT, external_namespace: "headmaster", external_owner_uuid: OWNER });
    d.containerManager.canDestroy = () => false;
    const res = await request(app({ deps: d })).post("/internal/cloud-runtime")
      .set("x-headmaster-internal-secret", SECRET).send({ agentId: AGENT, ownerId: OWNER }).expect(503);
    expect(res.body.error).toBe("runtime_destroy_unavailable");
    expect(d.calls).toEqual(["SELECT", "release"]);
  });
  test("foreign or noncanonical banks are rejected before HTTP", async () => {
    const fetchImpl = jest.fn();
    for (const bankId of [`hermes-u-${AGENT.replace(/-/g, "_")}`, "hm-bank_1"]) {
      await request(app({ fetchImpl })).post("/internal/memory-bank")
        .set("x-headmaster-internal-secret", SECRET).send({ bankId, ownerId: OWNER }).expect(409);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  test("GET cannot invoke a destructive operation", async () => {
    const d = deps(null);
    await request(app({ deps: d })).get("/internal/cloud-runtime").set("x-headmaster-internal-secret", SECRET).expect(404);
    expect(d.db.query).not.toHaveBeenCalled();
  });
});
