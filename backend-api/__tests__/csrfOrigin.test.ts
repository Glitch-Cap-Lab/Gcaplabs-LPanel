// @ts-nocheck
const express = require("express");
const request = require("supertest");
const { createCsrfOriginGate } = require("../middleware/csrfOrigin");

jest.mock("../db", () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
  connect: jest.fn(),
  on: jest.fn(),
}));
jest.mock("../redisQueue", () => ({ addDeploymentJob: jest.fn() }));
jest.mock("../scheduler", () => ({ start: jest.fn(), stop: jest.fn() }));

const ALLOWED = ["https://app.example.com", "http://localhost:8080/"];
const COOKIE = "nora_auth=session-token";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(createCsrfOriginGate({ allowedOrigins: ALLOWED }));
  const ok = (req, res) => res.json({ ok: true });
  app.all("/agents/:id", ok);
  app.all("/auth/login", ok);
  app.post("/stripe/webhook", ok);
  app.post("/webhooks/:channelId", ok);
  app.post("/internal/headmaster/launch", ok);
  return app;
}

describe("csrf origin gate", () => {
  const app = buildApp();

  it("refuses a cookie mutation from a cross-origin page", async () => {
    const res = await request(app)
      .post("/agents/a1")
      .set("Cookie", COOKIE)
      .set("Origin", "https://evil.example");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("csrf_origin_rejected");
  });

  it("allows a cookie mutation from an allowed origin", async () => {
    const res = await request(app)
      .delete("/agents/a1")
      .set("Cookie", COOKIE)
      .set("Origin", "https://app.example.com");
    expect(res.status).toBe(200);
  });

  it("matches configured origins regardless of a trailing slash", async () => {
    const res = await request(app)
      .post("/agents/a1")
      .set("Cookie", COOKIE)
      .set("Origin", "http://localhost:8080");
    expect(res.status).toBe(200);
  });

  it("refuses a cookie mutation with neither Origin nor Referer", async () => {
    const res = await request(app).put("/agents/a1").set("Cookie", COOKIE);
    expect(res.status).toBe(403);
  });

  it("refuses the opaque null origin", async () => {
    const res = await request(app).post("/agents/a1").set("Cookie", COOKIE).set("Origin", "null");
    expect(res.status).toBe(403);
  });

  it("falls back to Referer when Origin is absent", async () => {
    const good = await request(app)
      .patch("/agents/a1")
      .set("Cookie", COOKIE)
      .set("Referer", "https://app.example.com/app/agents/a1");
    expect(good.status).toBe(200);
    const bad = await request(app)
      .patch("/agents/a1")
      .set("Cookie", COOKIE)
      .set("Referer", "https://evil.example/page");
    expect(bad.status).toBe(403);
  });

  it("does not let a look-alike host pass", async () => {
    const res = await request(app)
      .post("/agents/a1")
      .set("Cookie", COOKIE)
      .set("Origin", "https://app.example.com.evil.example");
    expect(res.status).toBe(403);
  });

  it("leaves safe methods alone", async () => {
    const res = await request(app).get("/agents/a1").set("Cookie", COOKIE);
    expect(res.status).toBe(200);
  });

  it("leaves requests without a session cookie alone (login, signup)", async () => {
    const res = await request(app).post("/auth/login").set("Origin", "https://evil.example");
    expect(res.status).toBe(200);
  });

  it("does not affect bearer or API-key clients, even with a stale cookie", async () => {
    const bearer = await request(app).post("/agents/a1").set("Authorization", "Bearer tok");
    expect(bearer.status).toBe(200);
    const key = await request(app)
      .post("/agents/a1")
      .set("Cookie", COOKIE)
      .set("X-API-Key", "nora_abc");
    expect(key.status).toBe(200);
    const noraKey = await request(app).post("/agents/a1").set("X-Nora-Api-Key", "nora_abc");
    expect(noraKey.status).toBe(200);
  });

  it("does not affect webhook and server-to-server routes", async () => {
    for (const path of ["/stripe/webhook", "/webhooks/ch1", "/internal/headmaster/launch"]) {
      const res = await request(app)
        .post(path)
        .set("Cookie", COOKIE)
        .set("Origin", "https://evil.example");
      expect(res.status).toBe(200);
    }
  });
});

describe("csrf origin gate wiring in server.ts", () => {
  it("is mounted ahead of the routes", async () => {
    process.env.CORS_ORIGINS = "https://app.example.com";
    jest.resetModules();
    const server = require("../server");
    const res = await request(server)
      .post("/auth/logout")
      .set("Cookie", COOKIE)
      .set("Origin", "https://evil.example");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("csrf_origin_rejected");
  });
});
