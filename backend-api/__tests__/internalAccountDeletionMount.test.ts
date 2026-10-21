// @ts-nocheck
/**
 * __tests__/internalAccountDeletionMount.test.ts — pins where the Headmaster
 * account-deletion router sits in server.ts. The caller is the account API,
 * which sends only x-headmaster-internal-secret (no user session), so the
 * route must be reachable before the auth wall and before the
 * /internal/headmaster S2S router (which 404s when that feature is off).
 */

const request = require("supertest");

const SECRET = "d".repeat(40);
process.env.HEADMASTER_ACCOUNT_DELETION_SECRET = SECRET;
delete process.env.HEADMASTER_S2S_TOKEN;
delete process.env.HEADMASTER_PARENT_ORIGIN;

const mockDb = { query: jest.fn(), connect: jest.fn() };
jest.mock("../db", () => mockDb);
jest.mock("../redisQueue", () => ({
  addDeploymentJob: jest.fn(),
  getDLQJobs: jest.fn(),
  retryDLQJob: jest.fn(),
  cancelDeploymentJobsForAgent: jest.fn(),
}));
jest.mock("../scheduler", () => ({ selectNode: jest.fn() }));
jest.mock("ioredis", () => jest.fn(() => ({ on: jest.fn(), get: jest.fn(), set: jest.fn(), status: "wait" })));
jest.mock("../containerManager", () => ({ destroy: jest.fn(), canDestroy: () => true }));
jest.mock("../monitoring", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
  getMetrics: jest.fn().mockResolvedValue({}),
  getRecentEvents: jest.fn().mockResolvedValue([]),
}));

const app = require("../server");

const PATH = "/internal/headmaster/account-deletion/cloud-runtime";

describe("account-deletion mount (server.ts)", () => {
  test("admin cleanup requires the server's login wall", async () => {
    await request(app).post("/admin/account-deletions/r1/steps/cloud_runtime").expect(401);
  });
  test("correct secret without a user session reaches the handler", async () => {
    // An invalid agentId is rejected by the handler itself (400 agent_invalid),
    // which proves the request got past the auth wall and the S2S router.
    const res = await request(app)
      .post(PATH)
      .set("x-headmaster-internal-secret", SECRET)
      .send({ agentId: "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "agent_invalid" });
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  test("wrong secret is rejected by the route's own guard", async () => {
    const res = await request(app)
      .post(PATH)
      .set("x-headmaster-internal-secret", "x".repeat(40))
      .send({ agentId: "not-a-uuid" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
  });

  test("missing secret is rejected", async () => {
    const res = await request(app).post(PATH).send({ agentId: "not-a-uuid" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
  });
});
