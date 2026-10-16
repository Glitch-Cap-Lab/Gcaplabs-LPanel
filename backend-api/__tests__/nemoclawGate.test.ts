// @ts-nocheck
const express = require("express");
const request = require("supertest");
const { requireSandboxProfileEnabled } = require("../middleware/backendGate");

describe("NemoClaw sandbox profile gate", () => {
  const saved = process.env.ENABLED_SANDBOX_PROFILES;
  afterEach(() => {
    if (saved === undefined) delete process.env.ENABLED_SANDBOX_PROFILES;
    else process.env.ENABLED_SANDBOX_PROFILES = saved;
  });

  function app() {
    const a = express();
    a.get("/config/nemoclaw", requireSandboxProfileEnabled("nemoclaw"), (_req, res) =>
      res.json({ ok: true }),
    );
    return a;
  }

  it("answers 404 when NemoClaw is not enabled", async () => {
    delete process.env.ENABLED_SANDBOX_PROFILES;
    const res = await request(app()).get("/config/nemoclaw");
    expect(res.status).toBe(404);
  });

  it("lets requests through when NemoClaw is enabled", async () => {
    process.env.ENABLED_SANDBOX_PROFILES = "standard,nemoclaw";
    const res = await request(app()).get("/config/nemoclaw");
    expect(res.status).toBe(200);
  });
});
