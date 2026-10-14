// @ts-nocheck
const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "session-revocation-secret";

// In-memory users table that understands the two statements sessionVersion uses.
const users = new Map();
const mockDb = {
  failNext: false,
  query: jest.fn(async (sql, params) => {
    if (mockDb.failNext) {
      mockDb.failNext = false;
      throw new Error("db down");
    }
    const row = users.get(params[0]);
    if (/^UPDATE users SET session_version/.test(sql)) {
      if (!row) return { rows: [] };
      row.session_version = (row.session_version || 0) + 1;
      return { rows: [{ session_version: row.session_version }] };
    }
    if (/^SELECT role, session_version FROM users/.test(sql)) {
      return { rows: row ? [{ role: row.role, session_version: row.session_version }] : [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  }),
};
jest.mock("../db", () => mockDb);
jest.unmock("../sessionVersion");

const { authenticateToken } = require("../middleware/auth");
const { buildSessionPayload, revokeUserSessions } = require("../sessionVersion");
const authRoutes = require("../routes/auth");

function app() {
  const a = express();
  a.get("/me", authenticateToken, (req, res) => res.json({ id: req.user.id, role: req.user.role }));
  return a;
}

function login(userId) {
  return jwt.sign(buildSessionPayload(users.get(userId)), process.env.JWT_SECRET, {
    expiresIn: "7d",
    algorithm: "HS256",
  });
}

beforeEach(() => {
  users.clear();
  users.set("u1", { id: "u1", email: "a@x.test", role: "admin", session_version: 0 });
  mockDb.failNext = false;
});

describe("server-side session revocation", () => {
  it("accepts a fresh session", async () => {
    const res = await request(app()).get("/me").set("Authorization", `Bearer ${login("u1")}`);
    expect(res.status).toBe(200);
  });

  it("rejects a session issued before a revocation (logout / password change / admin sign-out)", async () => {
    const before = login("u1");
    await revokeUserSessions(mockDb, "u1");
    const old = await request(app()).get("/me").set("Authorization", `Bearer ${before}`);
    expect(old.status).toBe(401);
    expect(old.body.code).toBe("session_revoked");

    const fresh = await request(app()).get("/me").set("Authorization", `Bearer ${login("u1")}`);
    expect(fresh.status).toBe(200);
  });

  it("rejects a session whose role no longer matches (demotion)", async () => {
    const adminToken = login("u1");
    users.get("u1").role = "user";
    const res = await request(app()).get("/me").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(401);
  });

  it("rejects a session for a deleted user", async () => {
    const token = login("u1");
    users.delete("u1");
    const res = await request(app()).get("/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it("fails closed when the session store cannot be read", async () => {
    const token = login("u1");
    mockDb.failNext = true;
    const res = await request(app()).get("/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(503);
  });

  it("concurrent revocations each invalidate prior tokens", async () => {
    const token = login("u1");
    await Promise.all([revokeUserSessions(mockDb, "u1"), revokeUserSessions(mockDb, "u1")]);
    expect(users.get("u1").session_version).toBe(2);
    const res = await request(app()).get("/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it("refuses to mint a session from a row read without session_version", () => {
    expect(() => buildSessionPayload({ id: "u1", email: "a@x.test", role: "admin" })).toThrow(
      /session_version/,
    );
  });

  it("ends a legacy token without a version claim once the user is revoked", async () => {
    const legacy = jwt.sign({ id: "u1", email: "a@x.test", role: "admin" }, process.env.JWT_SECRET, {
      expiresIn: "7d",
      algorithm: "HS256",
    });
    const ok = await request(app()).get("/me").set("Authorization", `Bearer ${legacy}`);
    expect(ok.status).toBe(200);

    await revokeUserSessions(mockDb, "u1");
    const res = await request(app()).get("/me").set("Authorization", `Bearer ${legacy}`);
    expect(res.status).toBe(401);
  });

  it("ends a legacy admin token after demotion", async () => {
    const legacy = jwt.sign({ id: "u1", email: "a@x.test", role: "admin" }, process.env.JWT_SECRET, {
      expiresIn: "7d",
      algorithm: "HS256",
    });
    users.get("u1").role = "user";
    const res = await request(app()).get("/me").set("Authorization", `Bearer ${legacy}`);
    expect(res.status).toBe(401);
  });
});

describe("POST /auth/logout", () => {
  function logoutApp() {
    const a = express();
    a.use(express.json());
    a.use("/auth", authRoutes);
    return a;
  }

  it("revokes the session so a copied token stops working", async () => {
    const token = login("u1");
    const res = await request(logoutApp()).post("/auth/logout").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const after = await request(app()).get("/me").set("Authorization", `Bearer ${token}`);
    expect(after.status).toBe(401);
  });

  it("does not report success when the revocation cannot be written", async () => {
    const token = login("u1");
    mockDb.failNext = true;
    const res = await request(logoutApp()).post("/auth/logout").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(503);
    const after = await request(app()).get("/me").set("Authorization", `Bearer ${token}`);
    expect(after.status).toBe(200);
  });

  it("still succeeds for an invalid token", async () => {
    const res = await request(logoutApp()).post("/auth/logout").set("Authorization", "Bearer nope");
    expect(res.status).toBe(200);
  });
});
