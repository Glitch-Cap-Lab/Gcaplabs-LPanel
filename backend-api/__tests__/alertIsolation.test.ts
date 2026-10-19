// @ts-nocheck
// Exercise the real monitoring -> rules -> channel path with synthetic tenant
// state. No database, Redis, SMTP, runtime, or webhook listener is contacted.
jest.mock("../db", () => ({ query: jest.fn() }));
jest.mock("../redisQueue", () => ({ addAlertDeliveryJob: jest.fn() }));
jest.mock("../mailer", () => ({ sendMail: jest.fn() }));
jest.mock("../containerManager", () => ({ stop: jest.fn() }));
jest.mock("../metrics", () => ({}));
jest.mock("../networkSafety", () => ({ assertSafeUrlAsync: jest.fn() }));

const db = require("../db");
const { addAlertDeliveryJob } = require("../redisQueue");
const { sendMail } = require("../mailer");
const monitoring = require("../monitoring");
const alertRules = require("../alertRules");
const agentBudgets = require("../agentBudgets");

const rule = (workspace) => ({
  id: `rule-${workspace}`,
  workspace_id: workspace,
  name: workspace,
  event_pattern: "*",
  channels: [
    { type: "webhook", url: `https://hooks.example.com/${workspace}` },
    { type: "email", to: [`${workspace}@example.com`] },
  ],
});

describe("workspace alert isolation", () => {
  let assignedWorkspaces;
  let ownershipUnavailable;
  let ruleExists;
  let currentChannels;
  let fetchMock;
  let originalFetch;
  const flushAlerts = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    assignedWorkspaces = ["a"];
    ownershipUnavailable = false;
    ruleExists = true;
    currentChannels = rule("a").channels;
    db.query.mockReset().mockImplementation(async (sql) => {
      if (sql.includes("FROM agent_budgets")) {
        return {
          rows: [
            {
              id: "budget-a",
              agent_id: "agent-a",
              period: "monthly",
              limit_usd: 10,
              soft_threshold_pct: 80,
              last_alerted_pct: 120,
            },
          ],
        };
      }
      if (sql.includes("FROM workspace_agents")) {
        if (ownershipUnavailable) throw new Error("synthetic store outage");
        return { rows: assignedWorkspaces.map((workspace_id) => ({ workspace_id })) };
      }
      if (sql.startsWith("SELECT id, channels FROM alert_rules")) {
        return { rows: ruleExists ? [{ id: "rule-a", channels: currentChannels }] : [] };
      }
      // Deliberately return both tenants even for a scoped SQL request, so the
      // delivery assertions also catch a missing in-process scope check.
      if (sql.includes("FROM alert_rules")) return { rows: [rule("a"), rule("b")] };
      return { rows: [] };
    });
    addAlertDeliveryJob.mockReset().mockResolvedValue({ id: "job" });
    sendMail.mockReset().mockResolvedValue({ delivered: true });
    originalFetch = global.fetch;
    fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock;
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function expectRecipients(workspaces) {
    expect(addAlertDeliveryJob.mock.calls.map(([job]) => job.workspaceId)).toEqual(workspaces);
    expect(sendMail.mock.calls.map(([mail]) => mail.to)).toEqual(
      workspaces.map((workspace) => [`${workspace}@example.com`]),
    );
  }

  it("routes the real budget pause event without workspace metadata only to its assignment", async () => {
    await agentBudgets.checkAndEnforce(
      { id: "agent-a", name: "Synthetic A", status: "running" },
      {
        stopRuntime: jest.fn().mockResolvedValue(undefined),
        costResolver: jest.fn().mockResolvedValue({ total_cost: 12 }),
      },
    );
    await flushAlerts();
    expectRecipients(["a"]);
    expect(addAlertDeliveryJob.mock.calls[0][0]).toMatchObject({
      eventType: "agent.budget_paused",
      metadata: { agentId: "agent-a", currentUsd: 12 },
    });
    const assignmentCall = db.query.mock.calls.find(([sql]) =>
      sql.includes("FROM workspace_agents"),
    );
    expect(assignmentCall[1]).toEqual([["agent-a"], 1]);
    expect(assignmentCall[0]).toContain("JOIN agents a ON a.id = wa.agent_id");
    expect(db.query.mock.calls.find(([sql]) => sql.includes("FROM alert_rules"))[1]).toEqual([
      ["a"],
    ]);
  });

  it.each(["agent", "sourceAgent"])(
    "resolves sibling %s metadata without workspace hints",
    async (key) => {
      await monitoring.logEvent("agent.schedule.run", "Synthetic schedule", {
        [key]: { id: "agent-a" },
      });
      await flushAlerts();
      expectRecipients(["a"]);
    },
  );

  it("allows intentional shared-agent delivery and narrows an explicit workspace", async () => {
    assignedWorkspaces = ["a", "b"];
    await alertRules.evaluateAndDeliver("agent.error", "Synthetic shared event", {
      agentId: "agent-a",
    });
    expectRecipients(["a", "b"]);
    addAlertDeliveryJob.mockClear();
    sendMail.mockClear();
    await alertRules.evaluateAndDeliver("agent.error", "Synthetic scoped event", {
      agentId: "agent-a",
      workspaceId: "b",
    });
    expectRecipients(["b"]);
  });

  it("requires assignments for every referenced agent", async () => {
    assignedWorkspaces = [];
    await alertRules.evaluateAndDeliver("backup.restored", "Synthetic copy", {
      agent: { id: "agent-a" },
      sourceAgent: { id: "agent-b" },
    });
    expectRecipients([]);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain("HAVING count(DISTINCT a.id) = $2");
    expect(params).toEqual([["agent-a", "agent-b"], 2]);
  });

  it.each([
    {},
    { source: { kind: "system" } },
    { source: { kind: "account", account: { role: "admin" } } },
    { workspaceId: "b", agentId: "agent-a" },
    { workspace: { id: "a" }, workspaceId: "b" },
    { workspaceId: "a", agentId: {} },
    { agentId: "agent-a", agent: { id: "agent-b" } },
  ])("does not broadcast absent, foreign or conflicting scope: %j", async (metadata) => {
    await monitoring.logEvent("synthetic.event", "Synthetic private content", metadata);
    await flushAlerts();
    expectRecipients([]);
    expect(db.query.mock.calls.some(([sql]) => sql.startsWith("INSERT INTO events"))).toBe(true);
  });

  it("preserves explicitly scoped system alerts", async () => {
    await monitoring.logEvent("system.workspace_check", "Synthetic check", {
      workspaceId: "a",
      source: { kind: "system" },
    });
    await flushAlerts();
    expectRecipients(["a"]);
  });

  it.each(["deleted", "unavailable"])("retains audit but skips %s ownership", async (condition) => {
    assignedWorkspaces = [];
    ownershipUnavailable = condition === "unavailable";
    await monitoring.logEvent("agent.error", "Synthetic failure", { agentId: "agent-a" });
    await flushAlerts();
    expectRecipients([]);
    expect(db.query.mock.calls.some(([sql]) => sql.startsWith("INSERT INTO events"))).toBe(true);
  });

  const queuedJob = () => ({
    ruleId: "rule-a",
    workspaceId: "a",
    channel: rule("a").channels[0],
    eventType: "agent.error",
    message: "Synthetic queued event",
    metadata: { agentId: "agent-a" },
  });

  it("retains all agent scope when oversized metadata is clamped for queued delivery", async () => {
    await alertRules.evaluateAndDeliver("agent.error", "Synthetic oversized event", {
      agentId: "agent-a",
      sourceAgent: { id: "agent-source" },
      blob: "x".repeat(20 * 1024),
    });
    const job = addAlertDeliveryJob.mock.calls[0][0];
    expect(job.metadata).toMatchObject({
      truncated: true,
      agentId: "agent-a",
      sourceAgent: { id: "agent-source" },
    });
    expect(job.metadata.blob).toBeUndefined();
    await alertRules.runAlertDeliveryJob(job);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      db.query.mock.calls.filter(([sql]) => sql.includes("FROM workspace_agents"))[1][1],
    ).toEqual([["agent-a", "agent-source"], 2]);
  });

  it("sends a queued webhook only while the rule and assignment still authorize it", async () => {
    await alertRules.runAlertDeliveryJob(queuedJob());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();
    assignedWorkspaces = ["b"];
    await alertRules.runAlertDeliveryJob(queuedJob());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips removed/disabled rules and old unscoped or foreign queued jobs", async () => {
    ruleExists = false;
    await alertRules.runAlertDeliveryJob(queuedJob());
    ruleExists = true;
    await alertRules.runAlertDeliveryJob({ ...queuedJob(), metadata: {} });
    await alertRules.runAlertDeliveryJob({ ...queuedJob(), workspaceId: "b" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revokes queued webhook snapshots when the channel is removed or replaced", async () => {
    currentChannels = [];
    await alertRules.runAlertDeliveryJob(queuedJob());
    currentChannels = [
      { ...rule("a").channels[0], headers: { Authorization: "synthetic-new-value" } },
    ];
    await alertRules.runAlertDeliveryJob(queuedJob());
    currentChannels = [{ type: "webhook", url: "https://hooks.example.com/replacement" }];
    await alertRules.runAlertDeliveryJob(queuedJob());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a queued job after ownership lookup failure without sending", async () => {
    ownershipUnavailable = true;
    await expect(alertRules.runAlertDeliveryJob(queuedJob())).rejects.toThrow(
      "synthetic store outage",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
