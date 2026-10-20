// @ts-nocheck
const crypto = require("crypto");
const express = require("express");
const request = require("supertest");
const mockDb = { query: jest.fn().mockResolvedValue({ rows: [] }) };
const mockDeliver = jest.fn().mockResolvedValue(undefined);
jest.mock("../db", () => mockDb);
jest.mock("../redisQueue", () => ({ deployQueue: {} }));
jest.mock("../alertRules", () => ({ evaluateAndDeliver: mockDeliver }));
const { AppError, correlationId, errorHandler } = require("../middleware/errorHandler");
const {
  buildAuditMetadata,
  normalizeAuditValue,
  createMutationFailureAuditMiddleware,
} = require("../auditLog");
const { ensureAuditSourceMetadata } = require("../auditSource");
const { logEvent } = require("../monitoring");
const { redactText, redactValue } = require("../lib/redaction");

// Assert booleans so a failing redaction regression never prints its canary.
function containsNone(value, canaries) {
  const serialized = JSON.stringify(value);
  expect(canaries.every((secret) => !serialized.includes(secret))).toBe(true);
}

describe("safe HTTP and audit boundaries", () => {
  let log;
  let canaries;
  let originalSecret;
  beforeEach(() => {
    log = jest.spyOn(console, "error").mockImplementation(() => {});
    mockDb.query.mockClear();
    mockDeliver.mockClear();
    canaries = Array.from({ length: 6 }, () => crypto.randomBytes(18).toString("hex"));
    originalSecret = process.env.AUDIT_TEST_SECRET;
    process.env.AUDIT_TEST_SECRET = canaries[4];
  });
  afterEach(() => {
    log.mockRestore();
    if (originalSecret === undefined) delete process.env.AUDIT_TEST_SECRET;
    else process.env.AUDIT_TEST_SECRET = originalSecret;
  });

  it("redacts actual exposed errors, stacks, request provenance and the resulting DB/alert event", async () => {
    const app = express();
    app.use(express.json());
    app.use(correlationId);
    app.use(createMutationFailureAuditMiddleware("settings"));
    app.post("/settings/:id", (req, _res, next) => {
      req.user = { id: "actor-a", role: "admin" };
      const error = new AppError(
        `Connection failed ${canaries.join(" ")}`,
        422,
        "SETTINGS_REJECTED",
      );
      error.stack = `Error: ${error.message}\n    at diagnosticFrame (service.ts:42:7)`;
      next(error);
    });
    app.use(errorHandler);
    const cid = crypto.randomUUID();
    const res = await request(app)
      .post("/settings/agent-a")
      .query({ access_token: canaries[0] })
      .set("Authorization", `Bearer ${canaries[1]}`)
      .set("Cookie", `session=${canaries[2]}`)
      .set("Origin", `https://example.test/?token=${canaries[0]}`)
      .set("Referer", `https://example.test/settings?password=${canaries[3]}`)
      .set("X-Api-Key", canaries[5])
      .set("X-Correlation-Id", cid)
      .send({ password: canaries[3] });
    await new Promise(setImmediate);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("SETTINGS_REJECTED");
    expect(res.body.correlationId).toBe(cid);
    expect(res.headers["x-correlation-id"]).toBe(cid);
    containsNone(
      [res.body, log.mock.calls, mockDb.query.mock.calls, mockDeliver.mock.calls],
      canaries,
    );
    const [, message, metadataJson] = mockDb.query.mock.calls[0][1];
    const metadata = JSON.parse(metadataJson);
    expect(metadata.actor.userId).toBe("actor-a");
    expect(metadata.request.path).toBe("/settings/agent-a");
    expect(metadata.request.correlationId).toBe(cid);
    expect(metadata.source.origin).toBe("https://example.test");
    expect(metadata.error.stack.includes("diagnosticFrame")).toBe(true);
    expect(mockDeliver.mock.calls[0][1]).toBe(message);
    expect(mockDeliver.mock.calls[0][2]).toEqual(metadata);
  });

  it("uses the same safe message and tenant metadata for central persistence and notifications", async () => {
    const message = `Failure password=${canaries[0]} Bearer ${canaries[1]} https://user:${canaries[2]}@example.test/a?token=${canaries[3]} ${canaries[4]} ${canaries[5]}`;
    await logEvent("operation_failed", message, {
      workspaceId: "workspace-a",
      agentId: "agent-a",
      scope: "tenant",
      headers: { authorization: canaries[5] },
      nested: { password: canaries[0] },
    });
    containsNone([mockDb.query.mock.calls, mockDeliver.mock.calls], canaries);
    const [, storedMessage, storedJson] = mockDb.query.mock.calls[0][1];
    expect(mockDeliver.mock.calls[0][1]).toBe(storedMessage);
    expect(JSON.parse(storedJson)).toMatchObject({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      scope: "tenant",
    });
  });

  it("does not echo arbitrary correlation header text", async () => {
    const app = express();
    app.use(correlationId);
    app.get("/test", (_req, _res, next) => next(new Error("Expected fixture failure")));
    app.use(errorHandler);
    const res = await request(app).get("/test").set("X-Correlation-Id", canaries[0]);
    containsNone([res.body, res.headers, log.mock.calls], [canaries[0]]);
    expect(res.body.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("bounds cyclic, deep, oversized and hostile diagnostic objects without a raw fallback", () => {
    const cyclic = { status: 503 };
    cyclic.self = cyclic;
    const hostile = {
      get details() {
        throw new Error(canaries[0]);
      },
    };
    const deep = {};
    let node = deep;
    for (let i = 0; i < 20; i++) {
      node.child = {};
      node = node.child;
    }
    node.password = canaries[1];
    const results = [
      normalizeAuditValue(cyclic),
      normalizeAuditValue(hostile),
      normalizeAuditValue(deep),
      redactText("x".repeat(20000)),
      redactValue(Object.fromEntries(Array.from({ length: 129 }, (_, i) => [i, canaries[2]]))),
      ensureAuditSourceMetadata(hostile),
      buildAuditMetadata({
        get headers() {
          throw new Error(canaries[3]);
        },
      }),
    ];
    containsNone(results, canaries);
    expect(JSON.stringify(results).length).toBeLessThan(2000);
    expect(results[0]).toMatchObject({ status: 503, self: "[circular]" });
    expect(log).not.toHaveBeenCalled();
  });

  it("keeps safe status and a generic response when reading an error throws", async () => {
    const app = express();
    app.use(correlationId);
    app.get("/test", (_req, _res, next) =>
      next({
        statusCode: 503,
        get message() {
          throw new Error(canaries[0]);
        },
      }),
    );
    app.use(errorHandler);
    const res = await request(app).get("/test");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("Internal server error");
    containsNone([res.body, log.mock.calls], canaries);
  });

  it("preserves the upgrade redactor export without loading upgrade logic into HTTP boundaries", () => {
    const { redactText: upgradeRedactText } = require("../releaseUpgrade");
    expect(upgradeRedactText).toBe(redactText);
    const output = upgradeRedactText(`token=${canaries[0]} Bearer ${canaries[1]} ${canaries[4]}`, {
      JWT_SECRET: canaries[4],
    });
    containsNone(output, canaries);
    expect(output.includes("[redacted]")).toBe(true);
    containsNone(
      upgradeRedactText(`Failure ${canaries[0]} ${canaries[1]}`, {
        JWT_SECRET: `  ${canaries[0]}  `,
        ENCRYPTION_KEY: `${canaries[1]} # fixture comment`,
      }),
      canaries,
    );
  });

  it("redacts private-key blocks and full payment-card data at HTTP, storage and notification boundaries", async () => {
    const pan = ["4111", "1111", "1111", "1111"].join("");
    const formattedPan = pan.match(/.{4}/g).join(" ");
    const privateBody = crypto.randomBytes(48).toString("base64");
    const pem = `-----BEGIN PRIVATE KEY-----\n${privateBody}\n-----END PRIVATE KEY-----`;
    const cvv = String(crypto.randomInt(100, 1000));
    const message = `Payment fixture ${pem} card ${formattedPan} cvc=${cvv}`;
    const app = express();
    app.use(correlationId);
    app.get("/test", (_req, _res, next) => next(new AppError(message, 422, "PAYMENT_REJECTED")));
    app.use(errorHandler);
    const res = await request(app).get("/test");
    expect(res.status).toBe(422);
    await logEvent("operation_failed", message, {
      workspaceId: "workspace-a",
      payment: {
        card_number: pan,
        pan,
        cvv,
        cvc: cvv,
        card_security_code: cvv,
        last4: pan.slice(-4),
      },
      card: { number: Number(pan), last4: pan.slice(-4) },
      rounded: {
        card: { number: Number("4" + "0".repeat(17) + "6"), last4: "0006", brand: "visa" },
      },
      bigint: { card: { number: BigInt(pan), last4: pan.slice(-4) } },
      error: new Error(message),
    });
    containsNone(
      [res.body, log.mock.calls, mockDb.query.mock.calls, mockDeliver.mock.calls],
      [pan, formattedPan, privateBody],
    );
    const payment = JSON.parse(mockDb.query.mock.calls[0][1][2]).payment;
    expect(JSON.parse(mockDb.query.mock.calls[0][1][2]).card).toEqual({
      number: "[redacted]",
      last4: pan.slice(-4),
    });
    const stored = JSON.parse(mockDb.query.mock.calls[0][1][2]);
    expect(stored.rounded.card.number === "[redacted]").toBe(true);
    expect(stored.rounded.card.last4).toBe("0006");
    expect(stored.rounded.card.brand).toBe("visa");
    expect(stored.bigint.card).toEqual({ number: "[redacted]", last4: pan.slice(-4) });
    expect(mockDeliver.mock.calls[0][2].rounded).toEqual(stored.rounded);
    expect(payment).toEqual({
      card_number: "[redacted]",
      pan: "[redacted]",
      cvv: "[redacted]",
      cvc: "[redacted]",
      card_security_code: "[redacted]",
      last4: pan.slice(-4),
    });
    expect(
      /cvc=\d{3}/.test(
        JSON.stringify([res.body, log.mock.calls, mockDb.query.mock.calls, mockDeliver.mock.calls]),
      ),
    ).toBe(false);
    containsNone(redactText(`incomplete -----BEGIN RSA PRIVATE KEY-----\n${privateBody}`), [
      privateBody,
    ]);
    expect(redactText("Invoice 1234567890123456 and last4 1111", {})).toBe(
      "Invoice 1234567890123456 and last4 1111",
    );
  });

  it("bounds a large sparse array before mapping it into a stored or delivered event", async () => {
    const sparse = new Array(10000000);
    sparse[sparse.length - 1] = canaries[0];
    await logEvent("operation_failed", "Sparse diagnostic retained", {
      workspaceId: "workspace-a",
      details: sparse,
    });
    const json = mockDb.query.mock.calls[0][1][2];
    expect(json.length).toBeLessThan(1000);
    expect(JSON.parse(json)).toMatchObject({
      workspaceId: "workspace-a",
      details: "[redacted: oversized array]",
    });
    containsNone([mockDb.query.mock.calls, mockDeliver.mock.calls], canaries);
  });

  it("exposes only a string message for hostile thrown objects", async () => {
    const app = express();
    app.use(correlationId);
    app.get("/test", (_req, _res, next) =>
      next({ statusCode: 422, message: { password: canaries[0] } }),
    );
    app.use(errorHandler);
    const res = await request(app).get("/test");
    expect(res.status).toBe(422);
    expect(typeof res.body.error).toBe("string");
    containsNone([res.body, log.mock.calls], canaries);
  });
});
