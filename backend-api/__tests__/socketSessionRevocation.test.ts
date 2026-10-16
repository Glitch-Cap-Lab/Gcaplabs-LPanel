// @ts-nocheck
// WebSocket endpoints (/ws/logs, /ws/exec, /ws/metrics) apply the same
// server-side session checks as HTTP: a revoked or demoted session cannot open
// a socket, and an open socket is closed on its next periodic re-check.
const { EventEmitter } = require("events");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "socket-session-secret";

// In-memory users and agents tables that understand the statements the
// session check and agent access check use.
const users = new Map();
const agents = new Map();
const mockDb = {
  failNext: false,
  query: jest.fn(async (sql, params) => {
    if (mockDb.failNext) {
      mockDb.failNext = false;
      throw new Error("db down");
    }
    if (/^UPDATE users SET session_version/.test(sql)) {
      const row = users.get(params[0]);
      if (!row) return { rows: [] };
      row.session_version = (row.session_version || 0) + 1;
      return { rows: [{ session_version: row.session_version }] };
    }
    if (/^SELECT role, session_version FROM users/.test(sql)) {
      const row = users.get(params[0]);
      return { rows: row ? [{ role: row.role, session_version: row.session_version }] : [] };
    }
    if (/^SELECT \* FROM agents WHERE id = \$1/.test(sql)) {
      const row = agents.get(params[0]);
      return { rows: row ? [{ ...row }] : [] };
    }
    // Workspace membership lookups: nobody here shares agents.
    if (/workspace_members/.test(sql)) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  }),
};

const wsConnections = [];

class mockFakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.closed = false;
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    this.emit("close");
  }
}

class mockFakeWebSocketServer extends EventEmitter {
  handleUpgrade(_request, _socket, _head, callback) {
    const ws = new mockFakeWebSocket();
    wsConnections.push(ws);
    callback(ws);
  }
}

jest.mock("../db", () => mockDb);
jest.unmock("../sessionVersion");
jest.mock("../containerManager", () => ({ status: jest.fn(), logs: jest.fn(), exec: jest.fn() }));
jest.mock("dockerode", () => jest.fn());
jest.mock("../agentTelemetry", () => ({ buildAgentStatsResponse: jest.fn(async () => ({})) }));
jest.mock("ws", () => ({ WebSocketServer: mockFakeWebSocketServer }));
jest.mock("../remoteHosts", () => ({
  assertRemoteHostAgentUse: jest.fn(async () => null),
  isRemoteDockerAgent: () => false,
  isRemoteHostAccessRevokedError: (error) => error?.code === "REMOTE_HOST_ACCESS_REVOKED",
}));

const originalRecheckMs = process.env.REMOTE_HOST_AUTH_RECHECK_MS;
const RECHECK_MS = 250;

function flushAsyncWork() {
  return new Promise((resolve) => setImmediate(resolve));
}

function login(userId) {
  const { buildSessionPayload } = require("../sessionVersion");
  return jwt.sign(buildSessionPayload(users.get(userId)), process.env.JWT_SECRET, {
    expiresIn: "1h",
    algorithm: "HS256",
  });
}

let server;

beforeEach(() => {
  jest.resetModules();
  process.env.REMOTE_HOST_AUTH_RECHECK_MS = String(RECHECK_MS);
  users.clear();
  agents.clear();
  users.set("admin-1", { id: "admin-1", email: "admin@x.test", role: "admin", session_version: 0 });
  users.set("owner-1", { id: "owner-1", email: "owner@x.test", role: "user", session_version: 0 });
  // Owned by someone else and never started, so a log socket stays open idle.
  agents.set("agent-1", {
    id: "agent-1",
    name: "Owner Agent",
    status: "stopped",
    container_id: null,
    backend_type: "docker",
    user_id: "owner-1",
  });
  mockDb.failNext = false;
  mockDb.query.mockClear();
  wsConnections.length = 0;

  server = new EventEmitter();
  require("../logStream").attachLogStream(server);
  require("../execStream").attachExecStream(server);
  require("../metricsStream").attachMetricsStream(server);
});

afterEach(() => {
  jest.useRealTimers();
});

afterAll(() => {
  if (originalRecheckMs === undefined) delete process.env.REMOTE_HOST_AUTH_RECHECK_MS;
  else process.env.REMOTE_HOST_AUTH_RECHECK_MS = originalRecheckMs;
});

async function upgrade(path, token) {
  const socket = { write: jest.fn(), destroy: jest.fn() };
  server.emit(
    "upgrade",
    { url: `${path}?token=${encodeURIComponent(token)}`, headers: { host: "nora.test" } },
    socket,
    Buffer.alloc(0),
  );
  await flushAsyncWork();
  return { socket, ws: wsConnections[0] };
}

describe("socket upgrades check the session like HTTP", () => {
  it("refuses /ws/exec for a token issued before logout", async () => {
    const { revokeUserSessions } = require("../sessionVersion");
    const token = login("admin-1");
    await revokeUserSessions(mockDb, "admin-1");

    const { socket, ws } = await upgrade("/ws/exec/agent-1", token);

    expect(ws).toBeUndefined();
    expect(socket.write).toHaveBeenCalledWith("HTTP/1.1 401 Unauthorized\r\n\r\n");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("still opens /ws/exec for a fresh session", async () => {
    const { socket, ws } = await upgrade("/ws/exec/agent-1", login("admin-1"));

    expect(socket.write).not.toHaveBeenCalled();
    expect(ws).toBeDefined();
  });

  it("refuses /ws/logs and /ws/metrics for a token whose role was demoted", async () => {
    const token = login("admin-1");
    users.get("admin-1").role = "user";

    for (const path of ["/ws/logs/agent-1", "/ws/metrics/agent-1"]) {
      const { socket, ws } = await upgrade(path, token);
      expect(ws).toBeUndefined();
      expect(socket.write).toHaveBeenCalledWith("HTTP/1.1 401 Unauthorized\r\n\r\n");
    }
  });

  it("fails closed with 503 when the session check cannot read the database", async () => {
    const token = login("admin-1");
    mockDb.failNext = true;

    const { socket, ws } = await upgrade("/ws/exec/agent-1", token);

    expect(ws).toBeUndefined();
    expect(socket.write).toHaveBeenCalledWith("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    expect(socket.destroy).toHaveBeenCalled();
  });
});

describe("periodic socket re-check uses the stored session and role", () => {
  it("closes an admin's log socket on an agent it does not own after demotion", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const { ws } = await upgrade("/ws/logs/agent-1", login("admin-1"));
    await flushAsyncWork();

    expect(ws.closed).toBe(false);
    expect(ws.sent).toContainEqual(
      expect.objectContaining({ type: "system", message: "Connected to log stream for Owner Agent" }),
    );

    // Demote in the database only; the token still says admin.
    users.get("admin-1").role = "user";
    await jest.advanceTimersByTimeAsync(RECHECK_MS);
    await flushAsyncWork();

    expect(ws.closed).toBe(true);
    expect(ws.sent).toContainEqual(
      expect.objectContaining({ type: "error", code: "session_revoked" }),
    );
  });

  it("keeps the socket open across re-checks while the session is unchanged", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const { ws } = await upgrade("/ws/logs/agent-1", login("admin-1"));
    await flushAsyncWork();

    await jest.advanceTimersByTimeAsync(RECHECK_MS * 3);
    await flushAsyncWork();

    expect(ws.closed).toBe(false);
  });

  it("closes an open socket once the session is revoked (logout)", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const { revokeUserSessions } = require("../sessionVersion");
    const { ws } = await upgrade("/ws/logs/agent-1", login("owner-1"));
    await flushAsyncWork();
    expect(ws.closed).toBe(false);

    await revokeUserSessions(mockDb, "owner-1");
    await jest.advanceTimersByTimeAsync(RECHECK_MS);
    await flushAsyncWork();

    expect(ws.closed).toBe(true);
  });
});
