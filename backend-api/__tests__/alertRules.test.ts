// @ts-nocheck
/**
 * __tests__/alertRules.test.ts — alert rule pattern matching, CRUD, and
 * webhook delivery. Mocks db, mailer, and the BullMQ enqueue helper so we
 * can assert delivery semantics without Redis or an HTTP listener.
 */

const request = require("supertest");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "secret";
process.env.JWT_SECRET = JWT_SECRET;

const mockDb = { query: jest.fn() };
jest.mock("../db", () => mockDb);

// Stub the async (DNS-resolving) SSRF check so delivery tests can use
// non-resolving stub hostnames like `https://hooks/a` without touching the
// network. The lexical `assertSafeUrl` stays real — the new validation tests
// below exercise it via the rule-creation path.
jest.mock("../networkSafety", () => {
  const actual = jest.requireActual("../networkSafety");
  return {
    ...actual,
    assertSafeUrlAsync: jest.fn(async (rawUrl) => new URL(rawUrl).origin),
  };
});

const mockMailerSendMail = jest.fn();
jest.mock("../mailer", () => ({
  sendMail: mockMailerSendMail,
  isConfigured: jest.fn().mockResolvedValue(true),
  bustCache: jest.fn(),
}));
const mockAddAlertDeliveryJob = jest.fn();
jest.mock("../redisQueue", () => ({
  addDeploymentJob: jest.fn(),
  addAlertDeliveryJob: mockAddAlertDeliveryJob,
  getDLQJobs: jest.fn(),
  retryDLQJob: jest.fn(),
  ALERT_DELIVERY_ATTEMPTS: 5,
}));
jest.mock("../scheduler", () => ({ selectNode: jest.fn() }));
jest.mock("../containerManager", () => ({
  start: jest.fn(),
  stop: jest.fn(),
  restart: jest.fn(),
  destroy: jest.fn(),
  status: jest.fn().mockResolvedValue({ running: true }),
}));

const alertRules = require("../alertRules");

describe("patternMatches", () => {
  const cases = [
    ["agent.error", "agent.error", true],
    ["agent.error", "agent.warning", false],
    ["agent.*", "agent.error", true],
    ["agent.*", "agent.warning", true],
    ["agent.*", "workspace.created", false],
    ["agent.*", "agent", true], // exact-prefix match
    ["*", "anything", true],
    ["", "agent.error", false],
    ["agent.error", "", false],
  ];
  for (const [pattern, eventType, expected] of cases) {
    it(`pattern ${JSON.stringify(pattern)} vs ${JSON.stringify(eventType)} → ${expected}`, () => {
      expect(alertRules.patternMatches(pattern, eventType)).toBe(expected);
    });
  }
});

describe("validation", () => {
  beforeEach(() => mockDb.query.mockReset());

  it("rejects empty channels", async () => {
    await expect(
      alertRules.createRule("ws-1", "u-1", { name: "x", eventPattern: "agent.*", channels: [] }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects unsupported channel type", async () => {
    await expect(
      alertRules.createRule("ws-1", "u-1", {
        name: "x",
        eventPattern: "agent.*",
        channels: [{ type: "carrier-pigeon", url: "http://x" }],
      }),
    ).rejects.toThrow(/unsupported type/);
  });

  it("rejects webhook without https?:// url", async () => {
    await expect(
      alertRules.createRule("ws-1", "u-1", {
        name: "x",
        eventPattern: "agent.*",
        channels: [{ type: "webhook", url: "ftp://x" }],
      }),
    ).rejects.toThrow(/http\(s\)/);
  });

  it("rejects webhook pointing at loopback (SSRF guard)", async () => {
    await expect(
      alertRules.createRule("ws-1", "u-1", {
        name: "x",
        eventPattern: "agent.*",
        channels: [{ type: "webhook", url: "http://127.0.0.1:6379/" }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects webhook pointing at RFC1918 IP (SSRF guard)", async () => {
    await expect(
      alertRules.createRule("ws-1", "u-1", {
        name: "x",
        eventPattern: "agent.*",
        channels: [{ type: "webhook", url: "https://10.0.0.5/hook" }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects webhook pointing at AWS metadata IP (SSRF guard)", async () => {
    await expect(
      alertRules.createRule("ws-1", "u-1", {
        name: "x",
        eventPattern: "agent.*",
        channels: [{ type: "webhook", url: "http://169.254.169.254/latest/meta-data/" }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects email channel with empty 'to'", async () => {
    await expect(
      alertRules.createRule("ws-1", "u-1", {
        name: "x",
        eventPattern: "agent.*",
        channels: [{ type: "email", to: [] }],
      }),
    ).rejects.toThrow(/at least one recipient/);
  });

  it("rejects email channel with non-email entry", async () => {
    await expect(
      alertRules.createRule("ws-1", "u-1", {
        name: "x",
        eventPattern: "agent.*",
        channels: [{ type: "email", to: ["not-an-email"] }],
      }),
    ).rejects.toThrow(/not a valid email/);
  });

  it("rejects email channel with too many recipients", async () => {
    const tooMany = Array.from({ length: 11 }, (_, i) => `u${i}@x.com`);
    await expect(
      alertRules.createRule("ws-1", "u-1", {
        name: "x",
        eventPattern: "agent.*",
        channels: [{ type: "email", to: tooMany }],
      }),
    ).rejects.toThrow(/at most 10 recipients/);
  });

  it("accepts an email channel with valid recipients + subject prefix", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "r-em",
          workspace_id: "ws-1",
          created_by: "u-1",
          name: "Errors",
          event_pattern: "agent.error",
          channels: [{ type: "email", to: ["ops@x.com"], subjectPrefix: "PROD" }],
          enabled: true,
          created_at: new Date().toISOString(),
        },
      ],
    });
    const rule = await alertRules.createRule("ws-1", "u-1", {
      name: "Errors",
      eventPattern: "agent.error",
      channels: [{ type: "email", to: ["ops@x.com"], subjectPrefix: "PROD" }],
    });
    expect(rule.channels[0]).toMatchObject({
      type: "email",
      to: ["ops@x.com"],
      subjectPrefix: "PROD",
    });
  });

  it("inserts a rule with normalized channels", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "r-1",
          workspace_id: "ws-1",
          created_by: "u-1",
          name: "Errors",
          event_pattern: "agent.error",
          channels: [{ type: "webhook", url: "https://hooks.example.com/x" }],
          enabled: true,
          created_at: new Date().toISOString(),
        },
      ],
    });
    const rule = await alertRules.createRule("ws-1", "u-1", {
      name: "Errors",
      eventPattern: "agent.error",
      channels: [{ type: "webhook", url: "https://hooks.example.com/x" }],
    });
    expect(rule.id).toBe("r-1");
    expect(rule.channels[0].url).toBe("https://hooks.example.com/x");
  });
});

describe("evaluateAndDeliver", () => {
  beforeEach(() => {
    mockDb.query.mockReset();
    mockAddAlertDeliveryJob.mockReset().mockResolvedValue({ id: "job-1" });
    mockMailerSendMail.mockReset();
  });

  it("does nothing when no rules match", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    await alertRules.evaluateAndDeliver("agent.error", "msg", {});
    expect(mockAddAlertDeliveryJob).not.toHaveBeenCalled();
  });

  it("enqueues a webhook delivery for a matching rule instead of POSTing inline", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ workspace_id: "ws-1" }] }) // agent assignment
      .mockResolvedValueOnce({
        rows: [
          {
            id: "r-1",
            workspace_id: "ws-1",
            name: "Errors",
            event_pattern: "agent.*",
            channels: [{ type: "webhook", url: "https://hooks/a" }],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // recordFiring update

    await alertRules.evaluateAndDeliver("agent.error", "Boom", {
      workspace: { id: "ws-1" },
      agent: { id: "a-1" },
    });
    expect(mockAddAlertDeliveryJob).toHaveBeenCalledTimes(1);
    const [job] = mockAddAlertDeliveryJob.mock.calls[0];
    expect(job.ruleId).toBe("r-1");
    expect(job.workspaceId).toBe("ws-1");
    expect(job.channel).toMatchObject({ type: "webhook", url: "https://hooks/a" });
    expect(job.eventType).toBe("agent.error");
    // recordFiring records last_fired_at with no inline error (webhook is async)
    const recordCall = mockDb.query.mock.calls[2];
    expect(recordCall[0]).toContain("UPDATE alert_rules");
    expect(recordCall[1][1]).toBeNull();
  });

  it("clamps oversized metadata before queueing", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "r-big",
            workspace_id: "ws-1",
            name: "Errors",
            event_pattern: "agent.*",
            channels: [{ type: "webhook", url: "https://hooks/a" }],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const huge = "x".repeat(20 * 1024);
    await alertRules.evaluateAndDeliver("agent.error", "Boom", {
      workspace: { id: "ws-1" },
      blob: huge,
    });
    const [job] = mockAddAlertDeliveryJob.mock.calls[0];
    expect(job.metadata.truncated).toBe(true);
    expect(job.metadata.workspace).toEqual({ id: "ws-1" });
    expect(job.metadata.blob).toBeUndefined();
  });

  it("records inline error when enqueue itself fails", async () => {
    mockAddAlertDeliveryJob.mockRejectedValueOnce(new Error("redis down"));
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "r-1",
            workspace_id: "ws-1",
            name: "Errors",
            event_pattern: "agent.*",
            channels: [{ type: "webhook", url: "https://hooks/a" }],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await alertRules.evaluateAndDeliver("agent.error", "Boom", { workspace: { id: "ws-1" } });
    const recordCall = mockDb.query.mock.calls[1];
    expect(recordCall[1][1]).toMatch(/webhook:enqueue_failed:redis down/);
  });

  it("dispatches an email channel through the platform mailer", async () => {
    mockMailerSendMail.mockResolvedValueOnce({ delivered: true, messageId: "m-1" });
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "r-em",
            workspace_id: "ws-1",
            name: "Errors",
            event_pattern: "agent.*",
            channels: [{ type: "email", to: ["ops@x.com", "sec@x.com"], subjectPrefix: "PROD" }],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // recordFiring update

    await alertRules.evaluateAndDeliver("agent.error", "Boom", { workspace: { id: "ws-1" } });
    expect(mockMailerSendMail).toHaveBeenCalledTimes(1);
    const args = mockMailerSendMail.mock.calls[0][0];
    expect(args.to).toEqual(["ops@x.com", "sec@x.com"]);
    expect(args.subject).toMatch(/^\[PROD\] LPanel alert: agent\.error$/);
    expect(args.text).toContain("Event: agent.error");
  });

  it("captures last_error when email delivery fails", async () => {
    mockMailerSendMail.mockResolvedValueOnce({
      delivered: false,
      error: "not_configured",
    });
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "r-em",
            workspace_id: "ws-1",
            name: "Errors",
            event_pattern: "agent.*",
            channels: [{ type: "email", to: ["ops@x.com"] }],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // recordFiring

    await alertRules.evaluateAndDeliver("agent.error", "msg", { workspace: { id: "ws-1" } });
    const recordCall = mockDb.query.mock.calls[1];
    expect(recordCall[0]).toContain("UPDATE alert_rules");
    expect(recordCall[1][1]).toMatch(/email:not_configured/);
  });

  it("does not fire rules from other workspaces", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "r-1",
          workspace_id: "ws-other",
          name: "Errors",
          event_pattern: "agent.*",
          channels: [{ type: "webhook", url: "https://hooks/x" }],
        },
      ],
    });

    await alertRules.evaluateAndDeliver("agent.error", "msg", {
      workspace: { id: "ws-1" },
    });
    expect(mockAddAlertDeliveryJob).not.toHaveBeenCalled();
  });
});

describe("runAlertDeliveryJob", () => {
  let originalFetch;
  let fetchMock;

  beforeEach(() => {
    mockDb.query.mockReset().mockResolvedValue({ rows: [{ id: "r-1" }] });
    originalFetch = global.fetch;
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("POSTs the channel URL with the job payload", async () => {
    await alertRules.runAlertDeliveryJob({
      ruleId: "r-1",
      workspaceId: "ws-1",
      ruleName: "Errors",
      channel: { type: "webhook", url: "https://hooks/a" },
      eventType: "agent.error",
      message: "Boom",
      metadata: { workspace: { id: "ws-1" } },
      firedAt: "2026-05-07T00:00:00Z",
      deliveryId: "delivery-123",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hooks/a");
    const body = JSON.parse(opts.body);
    expect(body.eventType).toBe("agent.error");
    expect(body.ruleId).toBe("r-1");
    expect(body.deliveryId).toBe("delivery-123");
  });

  it("throws on non-2xx so BullMQ retries", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(
      alertRules.runAlertDeliveryJob({
        ruleId: "r-1",
        workspaceId: "ws-1",
        channel: { type: "webhook", url: "https://hooks/x" },
        eventType: "agent.error",
        message: "Boom",
        metadata: { workspaceId: "ws-1" },
        firedAt: "2026-05-07T00:00:00Z",
      }),
    ).rejects.toThrow(/503/);
  });

  it("rejects unsupported channel types", async () => {
    await expect(
      alertRules.runAlertDeliveryJob({
        ruleId: "r-1",
        channel: { type: "email", to: ["a@b.com"] },
        eventType: "agent.error",
      }),
    ).rejects.toThrow(/unsupported channel type/);
  });
});

describe("recordDeliveryFailure", () => {
  beforeEach(() => mockDb.query.mockReset());

  it("updates last_error without touching last_fired_at", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    await alertRules.recordDeliveryFailure("r-1", "webhook:Webhook returned 503");
    const call = mockDb.query.mock.calls[0];
    expect(call[0]).toContain("UPDATE alert_rules");
    expect(call[0]).toContain("last_error");
    expect(call[0]).not.toContain("last_fired_at");
    expect(call[1]).toEqual(["r-1", "webhook:Webhook returned 503"]);
  });

  it("noops when ruleId is missing", async () => {
    await alertRules.recordDeliveryFailure(null, "x");
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});

describe("HTTP routes", () => {
  jest.mock("../monitoring", () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
    getMetrics: jest.fn().mockResolvedValue({}),
    getRecentEvents: jest.fn().mockResolvedValue([]),
  }));
  jest.mock("../workspaces", () => ({
    listWorkspaces: jest.fn().mockResolvedValue([]),
    createWorkspace: jest.fn(),
    addAgent: jest.fn(),
    getWorkspaceAgents: jest.fn().mockResolvedValue([]),
    listAgentCandidates: jest.fn().mockResolvedValue([]),
    removeAgent: jest.fn(),
    listAccessibleAgents: jest.fn().mockResolvedValue([]),
  }));
  jest.mock("../workspaceMembers", () => ({
    listMembers: jest.fn().mockResolvedValue([]),
    listInvitations: jest.fn().mockResolvedValue([]),
  }));
  jest.mock("../integrations", () => ({}));
  jest.mock("../channels", () => ({}));
  jest.mock("../llmProviders", () => ({
    getAvailableProviders: jest.fn().mockReturnValue([]),
    listProviders: jest.fn().mockResolvedValue([]),
    PROVIDERS: [],
  }));
  jest.mock("../metrics", () => ({
    parseCostQuery: jest.fn((query = {}) => ({ periodDays: Number(query.period_days) || 30 })),
    recordApiMetric: jest.fn(),
    getAgentSummary: jest.fn().mockResolvedValue({}),
    getAgentMetrics: jest.fn().mockResolvedValue([]),
    getAgentCost: jest.fn().mockResolvedValue(null),
    getWorkspaceCost: jest.fn().mockResolvedValue({ totalUsd: 0, perAgent: [] }),
    getAccessibleWorkspaceCosts: jest
      .fn()
      .mockResolvedValue({ workspaces: [], uniqueFleetTotalUsd: 0 }),
  }));
  jest.mock("../billing", () => ({
    BILLING_ENABLED: false,
    PLATFORM_MODE: "selfhosted",
    enforceLimits: jest.fn().mockResolvedValue({ allowed: true }),
    getSubscription: jest.fn().mockResolvedValue({ plan: "selfhosted" }),
  }));

  const app = require("../server");
  const userToken = jwt.sign({ id: "user-1", role: "user" }, JWT_SECRET, { expiresIn: "1h" });
  const auth = (req) => req.set("Authorization", `Bearer ${userToken}`);

  beforeEach(() => mockDb.query.mockReset());

  it("GET /:id/alert-rules requires viewer", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: "ws-1", user_id: "user-1", role: "viewer" }] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await auth(request(app).get("/workspaces/ws-1/alert-rules"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("POST /:id/alert-rules requires admin", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: "ws-1", user_id: "creator", role: "editor" }],
    });
    const res = await auth(
      request(app)
        .post("/workspaces/ws-1/alert-rules")
        .send({
          name: "x",
          eventPattern: "agent.*",
          channels: [{ type: "webhook", url: "https://x" }],
        }),
    );
    expect(res.status).toBe(403);
  });

  it("POST /:id/alert-rules creates a rule for admin", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: "ws-1", user_id: "creator", role: "admin" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "r-1",
            workspace_id: "ws-1",
            created_by: "user-1",
            name: "Errors",
            event_pattern: "agent.error",
            channels: [{ type: "webhook", url: "https://hooks/x" }],
            enabled: true,
            created_at: new Date().toISOString(),
          },
        ],
      });
    const res = await auth(
      request(app)
        .post("/workspaces/ws-1/alert-rules")
        .send({
          name: "Errors",
          eventPattern: "agent.error",
          channels: [{ type: "webhook", url: "https://hooks/x" }],
        }),
    );
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("r-1");
  });

  it("DELETE /:id/alert-rules/:ruleId revokes when admin", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: "ws-1", user_id: "creator", role: "admin" }] })
      .mockResolvedValueOnce({ rows: [{ id: "r-1" }] });
    const res = await auth(request(app).delete("/workspaces/ws-1/alert-rules/r-1"));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
