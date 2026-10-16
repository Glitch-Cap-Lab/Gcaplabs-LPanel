// @ts-nocheck
const crypto = require("crypto");
const express = require("express");
const request = require("supertest");

const mockDb = { query: jest.fn() };

jest.mock("../db", () => mockDb);
jest.mock("../crypto", () => ({
  encrypt: (value) => `enc(${value})`,
  decrypt: (value) => (String(value).startsWith("enc(") ? value.slice(4, -1) : value),
  ensureEncryptionConfigured: jest.fn(),
}));
jest.mock("../../agent-runtime/lib/agentEndpoints", () => ({ runtimeUrlForAgent: () => null }));
jest.mock("../runtimeAuth", () => ({ runtimeAuthHeaders: async () => ({}) }));
jest.mock("../channels/adapters", () => ({
  getAdapter: () => ({
    configFields: [],
    formatInbound: (payload) => ({ content: payload.text || "", sender: "tester", metadata: {} }),
  }),
  listAdapterTypes: () => [],
}));

const channels = require("../channels");

const SECRET = "channel-secret";
const BODY = JSON.stringify({ text: "hello" });

function sign(body, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return {
    "x-webhook-signature-v2": signature,
    "x-webhook-timestamp": String(timestamp),
  };
}

function buildApp() {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  // Same handler shape as the server's public receiver.
  app.post("/webhooks/:channelId", async (req, res) => {
    try {
      await channels.handleInboundWebhook(req.params.channelId, req.body, req.headers, req.rawBody);
      res.json({ received: true });
    } catch (e) {
      res.status(e.statusCode || 400).json({ error: e.message });
    }
  });
  return app;
}

function channelRow() {
  return {
    id: "ch-1",
    agent_id: "agent-1",
    type: "webhook",
    enabled: true,
    config: JSON.stringify({ inbound_secret: `enc(${SECRET})` }),
  };
}

describe("inbound channel webhook authentication", () => {
  beforeEach(() => {
    mockDb.query.mockReset();
    mockDb.query.mockImplementation(async (sql) => {
      if (/FROM channels/.test(sql)) return { rows: [channelRow()] };
      return { rows: [] };
    });
  });

  const writes = () => mockDb.query.mock.calls.filter(([sql]) => /INSERT/.test(sql));

  it("rejects an unsigned request with 401 and writes nothing", async () => {
    const res = await request(buildApp())
      .post("/webhooks/ch-1")
      .set("content-type", "application/json")
      .send(BODY);
    expect(res.status).toBe(401);
    expect(writes()).toHaveLength(0);
  });

  it("rejects a wrong signature with 401 and writes nothing", async () => {
    const res = await request(buildApp())
      .post("/webhooks/ch-1")
      .set("content-type", "application/json")
      .set(sign(BODY, "some-other-secret"))
      .send(BODY);
    expect(res.status).toBe(401);
    expect(writes()).toHaveLength(0);
  });

  it("rejects a stale timestamp even when the signature matches", async () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    const res = await request(buildApp())
      .post("/webhooks/ch-1")
      .set("content-type", "application/json")
      .set(sign(BODY, SECRET, old))
      .send(BODY);
    expect(res.status).toBe(401);
    expect(writes()).toHaveLength(0);
  });

  it("rejects a channel that has no inbound secret", async () => {
    mockDb.query.mockImplementation(async (sql) =>
      /FROM channels/.test(sql) ? { rows: [{ ...channelRow(), config: "{}" }] } : { rows: [] },
    );
    const res = await request(buildApp())
      .post("/webhooks/ch-1")
      .set("content-type", "application/json")
      .set(sign(BODY))
      .send(BODY);
    expect(res.status).toBe(401);
    expect(writes()).toHaveLength(0);
  });

  it("accepts a correctly signed request and records it", async () => {
    const res = await request(buildApp())
      .post("/webhooks/ch-1")
      .set("content-type", "application/json")
      .set(sign(BODY))
      .send(BODY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(writes()).toHaveLength(1);
  });
});
