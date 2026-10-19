// @ts-nocheck
const express = require("express");
const request = require("supertest");
const { buildRouter } = require("../routes/adminAccountDeletions");
const makeApp = ({ user = { id: "ops", role: "admin" }, apiKey = null, client }) => {
  const app = express();
  app.use((req, _res, next) => { req.user = user; req.apiKey = apiKey; next(); });
  app.use("/deletions", buildRouter({ clientFactory: () => client }));
  return app;
};
describe("admin account deletion route authority", () => {
  const client = { completeStep: jest.fn(async () => ({ steps: { memory_bank: "done" } })), deleteAccount: jest.fn(async () => ({ status: "completed" })), list: jest.fn(async () => []) };
  beforeEach(() => jest.clearAllMocks());
  test.each([{ user: { id: "user", role: "user" } }, { apiKey: { id: "key" } }])("refuses cleanup without an admin login session", async (auth) => {
    const app = makeApp({ client, ...auth });
    const res = await request(app).post("/deletions/r1/steps/memory_bank");
    expect([401, 403]).toContain(res.status);
    expect(client.completeStep).not.toHaveBeenCalled();
  });
  test("POST invokes real cleanup; GET/PUT do not", async () => {
    const app = makeApp({ client });
    await request(app).get("/deletions/r1/steps/memory_bank").expect(404);
    await request(app).put("/deletions/r1/steps/memory_bank").expect(404);
    await request(app).post("/deletions/r1/steps/memory_bank").expect(200);
    expect(client.completeStep).toHaveBeenCalledTimes(1);
    expect(client.completeStep).toHaveBeenCalledWith("r1", "memory_bank", "ops");
  });
  test("creation still requires DELETE confirmation", async () => {
    await request(makeApp({ client })).post("/deletions").send({ ownerId: "owner" }).expect(400);
    expect(client.deleteAccount).not.toHaveBeenCalled();
  });
  test("a busy provisioning fence returns a clear wait and retry response", async () => {
    const c = { ...client, deleteAccount: async () => { throw Object.assign(Error("deletion_busy"), { statusCode: 409 }); } };
    const res = await request(makeApp({ client: c })).post("/deletions").send({ ownerId: "owner", confirm: "DELETE" }).expect(409);
    expect(res.body.error).toMatch(/Wait for it to finish/);
  });
  test("an unresolved runtime identity requires operator recovery before deletion", async () => {
    const c = { ...client, deleteAccount: async () => { throw Object.assign(Error("deletion_targets_unresolved"), { statusCode: 409 }); } };
    const res = await request(makeApp({ client: c })).post("/deletions").send({ ownerId: "owner", confirm: "DELETE" }).expect(409);
    expect(res.body.error).toMatch(/runtime identity needs operator recovery/);
  });
  test.each(["cleanup_targets_missing", "deletion_conflict"])("returns actionable conflict for %s", async (message) => {
    const c = { ...client, completeStep: async () => { throw Object.assign(Error(message), { statusCode: 409 }); } };
    const res = await request(makeApp({ client: c })).post("/deletions/r1/steps/cloud_runtime").expect(409);
    expect(res.body.error).toMatch(message === "deletion_conflict" ? /Refresh/ : /Operator recovery/);
  });
});
