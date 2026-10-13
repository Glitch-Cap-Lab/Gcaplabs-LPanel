// @ts-nocheck
const express = require("express");
const request = require("supertest");
const { buildRouter } = require("../routes/adminHeadmasterAccounts");
const { createAccountAdminClient } = require("../headmasterAccountAdmins");

const ENV = { HEADMASTER_SUPABASE_URL: "https://project.example", HEADMASTER_SUPABASE_SERVICE_ROLE_KEY: "test-service-key" };
const OWNER = "11111111-2222-3333-4444-555555555555";
const ok = (body = {}) => ({ ok: true, status: 200, json: async () => body });

function appWith({ user = { id: "u1", role: "admin", email: "ops@example.com" }, apiKey = null, client, audit = jest.fn() } = {}) {
  const app = express();
  app.use((req, _res, next) => { req.user = user; if (apiKey) req.apiKey = apiKey; next(); });
  app.use("/admin/headmaster-accounts", buildRouter({ clientFactory: () => client, audit }));
  return app;
}

describe("admin Headmaster accounts route", () => {
  const client = {
    list: jest.fn(async () => [{ owner_id: OWNER, email: "a@example.com", entitlement: "approved", is_admin: false, updated_at: null }]),
    setAdmin: jest.fn(async (ownerId, isAdmin) => ({ owner_id: ownerId, entitlement: "approved", is_admin: isAdmin, updated_at: null })),
  };
  beforeEach(() => { client.list.mockClear(); client.setAdmin.mockClear(); });

  test("non-admin users are refused", async () => {
    const app = appWith({ user: { id: "u2", role: "user" }, client });
    expect((await request(app).get("/admin/headmaster-accounts")).status).toBe(403);
    expect((await request(app).put(`/admin/headmaster-accounts/${OWNER}/admin`).send({ isAdmin: true })).status).toBe(403);
    expect(client.setAdmin).not.toHaveBeenCalled();
  });

  test("API keys are refused even for an admin", async () => {
    const app = appWith({ apiKey: { id: "k1" }, client });
    expect((await request(app).get("/admin/headmaster-accounts")).status).toBe(403);
  });

  test("lists accounts with entitlement and admin flag", async () => {
    const res = await request(appWith({ client })).get("/admin/headmaster-accounts");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ owner_id: OWNER, email: "a@example.com", entitlement: "approved", is_admin: false, updated_at: null }]);
  });

  test("sets the admin flag and audits it", async () => {
    const audit = jest.fn();
    const res = await request(appWith({ client, audit })).put(`/admin/headmaster-accounts/${OWNER}/admin`).send({ isAdmin: true });
    expect(res.status).toBe(200);
    expect(res.body.is_admin).toBe(true);
    expect(client.setAdmin).toHaveBeenCalledWith(OWNER, true);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  test("rejects a non-boolean flag", async () => {
    const res = await request(appWith({ client })).put(`/admin/headmaster-accounts/${OWNER}/admin`).send({ isAdmin: "yes" });
    expect(res.status).toBe(400);
    expect(client.setAdmin).not.toHaveBeenCalled();
  });

  test("503 when the Headmaster store is not configured", async () => {
    expect((await request(appWith({ client: null })).get("/admin/headmaster-accounts")).status).toBe(503);
  });

  test("404 when no entitlement row exists", async () => {
    const missing = { list: jest.fn(), setAdmin: jest.fn(async () => { throw new Error("not_found"); }) };
    expect((await request(appWith({ client: missing })).put(`/admin/headmaster-accounts/${OWNER}/admin`).send({ isAdmin: false })).status).toBe(404);
  });
});

describe("Headmaster account admin client", () => {
  test("not configured without env", () => {
    expect(createAccountAdminClient({ env: {} })).toBeNull();
  });

  test("list joins entitlements with auth emails", async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("/rest/v1/headmaster_account_entitlements")) return ok([{ owner_id: OWNER, entitlement: "approved", is_admin: true, updated_at: "2026-10-13T00:00:00Z" }]);
      if (url.includes("/auth/v1/admin/users")) return ok({ users: [{ id: OWNER, email: "a@example.com" }] });
      return ok();
    });
    const rows = await createAccountAdminClient({ env: ENV, fetchImpl }).list();
    expect(rows).toEqual([{ owner_id: OWNER, email: "a@example.com", entitlement: "approved", is_admin: true, updated_at: "2026-10-13T00:00:00Z" }]);
    expect(fetchImpl.mock.calls[0][0]).toContain("select=owner_id,entitlement,is_admin,updated_at");
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe("Bearer test-service-key");
  });

  test("setAdmin calls the RPC with only owner and flag", async () => {
    const fetchImpl = jest.fn(async () => ok([{ owner_id: OWNER, entitlement: "approved", is_admin: true, updated_at: null }]));
    const row = await createAccountAdminClient({ env: ENV, fetchImpl }).setAdmin(OWNER, true);
    expect(row.is_admin).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://project.example/rest/v1/rpc/headmaster_set_account_admin");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ p_owner_id: OWNER, p_is_admin: true });
  });

  test("setAdmin validates input and reports a missing row", async () => {
    const client = createAccountAdminClient({ env: ENV, fetchImpl: jest.fn(async () => ok([])) });
    await expect(client.setAdmin("x", true)).rejects.toThrow("owner_invalid");
    await expect(client.setAdmin(OWNER, "true")).rejects.toThrow("flag_invalid");
    await expect(client.setAdmin(OWNER, true)).rejects.toThrow("not_found");
  });
});
