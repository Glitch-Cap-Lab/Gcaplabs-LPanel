// @ts-nocheck
// Optional admin surfaces are off by default; these suites exercise them.
process.env.ADMIN_OPTIONAL_SURFACES = "agent-hub,user-groups,members,queue,backups";
/**
 * __tests__/adminMembers.test.ts — platform-admin god view of workspaces +
 * memberships. Mocks db so we can pin the SQL shape (filters, ordering, the
 * top-role rollup) without standing up Postgres.
 */

const request = require("supertest");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "secret";
process.env.JWT_SECRET = JWT_SECRET;

const mockDb = { query: jest.fn(), connect: jest.fn() };
jest.mock("../db", () => mockDb);
jest.mock("../redisQueue", () => ({
  addDeploymentJob: jest.fn(),
  getDLQJobs: jest.fn(),
  retryDLQJob: jest.fn(),
}));
jest.mock("../scheduler", () => ({ selectNode: jest.fn() }));
jest.mock("../containerManager", () => ({
  start: jest.fn(),
  stop: jest.fn(),
  restart: jest.fn(),
  destroy: jest.fn(),
  status: jest.fn().mockResolvedValue({ running: true }),
}));
jest.mock("../monitoring", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
  getMetrics: jest.fn().mockResolvedValue({}),
  getRecentEvents: jest.fn().mockResolvedValue([]),
}));
jest.mock("../billing", () => ({
  BILLING_ENABLED: false,
  PLATFORM_MODE: "selfhosted",
  enforceLimits: jest.fn().mockResolvedValue({ allowed: true }),
  getSubscription: jest.fn().mockResolvedValue({ plan: "selfhosted" }),
}));

const app = require("../server");
const adminToken = jwt.sign({ id: "admin-1", role: "admin" }, JWT_SECRET, { expiresIn: "1h" });
const userToken = jwt.sign({ id: "user-1", role: "user" }, JWT_SECRET, { expiresIn: "1h" });
const asAdmin = (req) => req.set("Authorization", `Bearer ${adminToken}`);
const asUser = (req) => req.set("Authorization", `Bearer ${userToken}`);

beforeEach(() => mockDb.query.mockReset());

describe("GET /admin/workspaces (god view)", () => {
  it("rejects non-admin", async () => {
    const res = await asUser(request(app).get("/admin/workspaces"));
    expect(res.status).toBe(403);
  });

  it("returns workspaces with member counts", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "ws-1",
          name: "Prod",
          user_id: "creator",
          created_at: new Date().toISOString(),
          creator_email: "creator@x.com",
          creator_name: "Creator",
          owner_count: 1,
          admin_count: 2,
          editor_count: 3,
          viewer_count: 4,
          total_members: 10,
          agent_count: 5,
        },
      ],
    });
    const res = await asAdmin(request(app).get("/admin/workspaces"));
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      id: "ws-1",
      name: "Prod",
      memberCounts: { owner: 1, admin: 2, editor: 3, viewer: 4, total: 10 },
      agentCount: 5,
    });
  });
});

describe("GET /admin/members (god view)", () => {
  it("filters by workspaceId and role", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    const res = await asAdmin(request(app).get("/admin/members?workspaceId=ws-1&role=admin"));
    expect(res.status).toBe(200);
    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toMatch(/m\.workspace_id = \$1/);
    expect(sql).toMatch(/m\.role = \$2/);
    expect(params).toEqual(["ws-1", "admin"]);
  });

  it("rejects unknown role values silently (filter dropped)", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    const res = await asAdmin(request(app).get("/admin/members?role=god"));
    expect(res.status).toBe(200);
    const [sql] = mockDb.query.mock.calls[0];
    expect(sql).not.toMatch(/m\.role = \$/);
  });

  it("supports ILIKE search on q", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    await asAdmin(request(app).get("/admin/members?q=alice"));
    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toMatch(/ILIKE/);
    expect(params).toEqual(["%alice%"]);
  });

  it("returns shaped member rows", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          workspace_id: "ws-1",
          workspace_name: "Prod",
          user_id: "u-1",
          user_email: "alice@x.com",
          user_name: "Alice",
          platform_role: "user",
          role: "admin",
          invited_by: null,
          invited_by_email: null,
          joined_at: new Date().toISOString(),
        },
      ],
    });
    const res = await asAdmin(request(app).get("/admin/members"));
    expect(res.body[0]).toMatchObject({
      workspaceId: "ws-1",
      userEmail: "alice@x.com",
      role: "admin",
    });
  });
});

describe("GET /admin/members/summary", () => {
  it("rolls up to one row per user with their top role", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "u-1",
          email: "alice@x.com",
          name: "Alice",
          platform_role: "user",
          workspace_count: 3,
          top_role_rank: 1, // admin
        },
        {
          id: "u-2",
          email: "bob@x.com",
          name: "Bob",
          platform_role: "user",
          workspace_count: 0,
          top_role_rank: null,
        },
      ],
    });
    const res = await asAdmin(request(app).get("/admin/members/summary"));
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      email: "alice@x.com",
      topRole: "admin",
      workspaceCount: 3,
    });
    expect(res.body[1]).toMatchObject({ email: "bob@x.com", topRole: null, workspaceCount: 0 });
  });
});
