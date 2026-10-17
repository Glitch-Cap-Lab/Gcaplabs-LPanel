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

describe("HEADMASTER_INBOUND_WEBHOOK_SIGNING switch", () => {
  const ORIGINAL = process.env.HEADMASTER_INBOUND_WEBHOOK_SIGNING;
  let warn;
  let error;

  beforeEach(() => {
    mockDb.query.mockReset();
    mockDb.query.mockImplementation(async (sql) => {
      if (/FROM channels/.test(sql)) return { rows: [channelRow()] };
      return { rows: [] };
    });
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    error = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.HEADMASTER_INBOUND_WEBHOOK_SIGNING;
    else process.env.HEADMASTER_INBOUND_WEBHOOK_SIGNING = ORIGINAL;
    warn.mockRestore();
    error.mockRestore();
  });

  const writes = () => mockDb.query.mock.calls.filter(([sql]) => /INSERT/.test(sql));
  const post = (headers = {}) =>
    request(buildApp()).post("/webhooks/ch-1").set("content-type", "application/json").set(headers).send(BODY);

  it("rejects unsigned requests when unset", async () => {
    delete process.env.HEADMASTER_INBOUND_WEBHOOK_SIGNING;
    const res = await post();
    expect(res.status).toBe(401);
    expect(writes()).toHaveLength(0);
  });

  it("accepts an unsigned request when off and warns once without the secret", async () => {
    process.env.HEADMASTER_INBOUND_WEBHOOK_SIGNING = "off";
    const res = await post();
    expect(res.status).toBe(200);
    expect(writes()).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain(SECRET);
  });

  it("still rejects a bad signature when off", async () => {
    process.env.HEADMASTER_INBOUND_WEBHOOK_SIGNING = "off";
    const res = await post(sign(BODY, "some-other-secret"));
    expect(res.status).toBe(401);
    expect(writes()).toHaveLength(0);
  });

  it("accepts a good signature when off without warning", async () => {
    process.env.HEADMASTER_INBOUND_WEBHOOK_SIGNING = "off";
    // A different timestamp from the earlier accepted request, so it is not a replay.
    const res = await post(sign(BODY, SECRET, Math.floor(Date.now() / 1000) - 7));
    expect(res.status).toBe(200);
    expect(writes()).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats an unknown value as enforce and logs an error", async () => {
    process.env.HEADMASTER_INBOUND_WEBHOOK_SIGNING = "disabled";
    const res = await post();
    expect(res.status).toBe(401);
    expect(writes()).toHaveLength(0);
    expect(error).toHaveBeenCalled();
  });
});

describe("inbound webhook replay protection", () => {
  beforeEach(() => {
    mockDb.query.mockReset();
    mockDb.query.mockImplementation(async (sql) =>
      /FROM channels/.test(sql) ? { rows: [channelRow()] } : { rows: [] },
    );
  });
  const writes = () => mockDb.query.mock.calls.filter(([sql]) => /INSERT/.test(sql));
  const post = (body, headers) =>
    request(buildApp()).post("/webhooks/ch-1").set("content-type", "application/json").set(headers).send(body);

  it("refuses the same signed request a second time inside the window", async () => {
    const body = JSON.stringify({ text: "replay-me" });
    const headers = sign(body, SECRET, Math.floor(Date.now() / 1000) - 30);
    expect((await post(body, headers)).status).toBe(200);
    const replay = await post(body, headers);
    expect(replay.status).toBe(401);
    expect(writes()).toHaveLength(1);
  });

  it("accepts a fresh signed request after one was replayed", async () => {
    const body = JSON.stringify({ text: "fresh" });
    const first = sign(body, SECRET, Math.floor(Date.now() / 1000) - 40);
    expect((await post(body, first)).status).toBe(200);
    expect((await post(body, first)).status).toBe(401);
    const fresh = sign(body, SECRET, Math.floor(Date.now() / 1000) - 41);
    expect((await post(body, fresh)).status).toBe(200);
  });

  it("does not let a forged signature use up a slot", async () => {
    const body = JSON.stringify({ text: "forged-first" });
    const ts = Math.floor(Date.now() / 1000) - 50;
    expect((await post(body, sign(body, "wrong-secret", ts))).status).toBe(401);
    expect((await post(body, sign(body, SECRET, ts))).status).toBe(200);
  });
});

describe("server-side inbound secret rotation", () => {
  let stored;
  beforeEach(() => {
    stored = { ...channelRow() };
    mockDb.query.mockReset();
    mockDb.query.mockImplementation(async (sql, params) => {
      if (/^UPDATE channels/.test(sql)) {
        stored = { ...stored, config: params[0] };
        return { rows: [stored] };
      }
      if (/FROM channels/.test(sql)) return { rows: [stored] };
      return { rows: [] };
    });
  });
  const post = (body, headers) =>
    request(buildApp()).post("/webhooks/ch-1").set("content-type", "application/json").set(headers).send(body);

  it("returns a fresh server-generated secret once and stores it encrypted", async () => {
    const res = await channels.updateChannel("ch-1", "agent-1", { rotate_inbound_secret: true });
    expect(res.inbound_secret).toMatch(/^[0-9a-f]{64}$/);
    expect(res.inbound_secret).not.toBe(SECRET);
    expect(JSON.parse(stored.config).inbound_secret).toBe(`enc(${res.inbound_secret})`);
    expect(JSON.stringify(res.config || {})).not.toContain(res.inbound_secret);
    const again = await channels.updateChannel("ch-1", "agent-1", { rotate_inbound_secret: true });
    expect(again.inbound_secret).not.toBe(res.inbound_secret);
  });

  it("ignores a client-supplied secret, with or without rotation", async () => {
    const chosen = "client-chosen-secret-1234567890";
    const plain = await channels.updateChannel("ch-1", "agent-1", {
      config: { inbound_secret: chosen },
    });
    expect(plain.inbound_secret).toBeUndefined();
    expect(JSON.parse(stored.config).inbound_secret).toBe(`enc(${SECRET})`);

    const rotated = await channels.updateChannel("ch-1", "agent-1", {
      rotate_inbound_secret: true,
      config: { inbound_secret: chosen },
    });
    expect(rotated.inbound_secret).not.toBe(chosen);
    expect(JSON.parse(stored.config).inbound_secret).toBe(`enc(${rotated.inbound_secret})`);
  });

  it("stops the old secret verifying and starts the new one", async () => {
    const { inbound_secret: fresh } = await channels.updateChannel("ch-1", "agent-1", {
      rotate_inbound_secret: true,
    });
    const body = JSON.stringify({ text: "after-rotate" });
    const ts = Math.floor(Date.now() / 1000) - 60;
    expect((await post(body, sign(body, SECRET, ts))).status).toBe(401);
    expect((await post(body, sign(body, fresh, ts))).status).toBe(200);
  });
});
