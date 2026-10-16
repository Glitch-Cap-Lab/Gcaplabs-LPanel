// @ts-nocheck
const { EventEmitter } = require("events");
const jwt = require("jsonwebtoken");
process.env.JWT_SECRET = "gateway-socket-session-test-secret";
const mockUsers = new Map();
const mockSockets = [];
const mockClients = [];
const mockHmSession = jest.fn();
const mockDb = {
  fail: false,
  gate: null,
  query: jest.fn(async (sql, params) => {
    if (mockDb.gate) await mockDb.gate;
    if (mockDb.fail) throw new Error("database unavailable");
    if (sql.startsWith("SELECT role, session_version FROM users")) {
      return { rows: mockUsers.has(params[0]) ? [mockUsers.get(params[0])] : [] };
    }
    if (sql.includes("FROM agents")) return { rows: [{
      id: "agent-1", user_id: "owner-1", effective_role: "owner", status: "running",
      deploy_target: "docker", gateway_host: "10.0.0.10", gateway_port: 19042,
      gateway_token: "unit-test-runtime-credential",
    }] };
    throw new Error(`Unexpected query: ${sql}`);
  }),
};
jest.mock("../db", () => mockDb);
jest.unmock("../sessionVersion");
jest.mock("../headmasterLaunch", () => ({ assertPrivilegedSocketSession: mockHmSession }));
jest.mock("../crypto", () => ({ decrypt: (value) => value }));
jest.mock("../integrations", () => ({}));
jest.mock("../metrics", () => ({}));
jest.mock("../agentBudgets", () => ({}));
jest.mock("../remoteHosts", () => ({ isRemoteDockerAgent: () => false }));
jest.mock("ws", () => {
  const { EventEmitter: Emitter } = jest.requireActual("events");
  class Socket extends Emitter {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() {
      super();
      this.readyState = 0;
      this.send = jest.fn();
      this.terminate = jest.fn(() => { this.readyState = 3; });
      mockSockets.push(this);
    }
  }
  class Server extends Emitter {
    handleUpgrade(_request, _socket, _head, callback) {
      const client = new Emitter();
      client.readyState = 1;
      client.send = jest.fn();
      client.close = jest.fn(() => { client.readyState = 2; });
      mockClients.push(client);
      callback(client);
    }
  }
  return { WebSocket: Socket, WebSocketServer: Server };
});
let server;
const originalRecheck = process.env.REMOTE_HOST_AUTH_RECHECK_MS;
const flush = () => new Promise((resolve) => setImmediate(resolve));

function embedToken(session = { id: "owner-1", role: "user", sv: 0 }, overrides = {}) {
  return jwt.sign({
    id: "owner-1", agentId: "agent-1", scope: "gateway-embed", session, ...overrides,
  }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "15m" });
}

async function upgrade(token = embedToken()) {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.write = jest.fn();
  socket.destroy = jest.fn(() => { socket.destroyed = true; });
  server.emit("upgrade", {
    url: "/ws/gateway/agent-1", headers: {
      host: "lpanel.test", cookie: `__nora_gateway_embed_agent-1=${token}`,
    },
  }, socket, Buffer.alloc(0));
  await flush();
  return socket;
}

beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers({ doNotFake: ["setImmediate"] });
  process.env.REMOTE_HOST_AUTH_RECHECK_MS = "250";
  mockUsers.clear();
  mockUsers.set("owner-1", { role: "user", session_version: 0 });
  mockSockets.length = 0;
  mockClients.length = 0;
  mockDb.fail = false;
  mockDb.gate = null;
  mockDb.query.mockClear();
  mockHmSession.mockReset().mockResolvedValue(undefined);
  server = new EventEmitter();
  require("../gatewayProxy").attachGatewayWS(server);
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});
afterAll(() => {
  if (originalRecheck === undefined) delete process.env.REMOTE_HOST_AUTH_RECHECK_MS;
  else process.env.REMOTE_HOST_AUTH_RECHECK_MS = originalRecheck;
});

it("refuses a pre-logout embed cookie before upgrading", async () => {
  const token = embedToken();
  mockUsers.get("owner-1").session_version++;
  const socket = await upgrade(token);
  expect(socket.write).toHaveBeenCalledWith("HTTP/1.1 401 Unauthorized\r\n\r\n");
  expect(socket.destroy).toHaveBeenCalled();
  expect(mockSockets).toHaveLength(0);
});

it("closes both peers on the next recheck after logout", async () => {
  await upgrade();
  expect(mockClients[0].close).not.toHaveBeenCalled();
  mockUsers.get("owner-1").session_version++;
  await jest.advanceTimersByTimeAsync(250);
  expect(mockClients[0].close).toHaveBeenCalled();
  expect(mockSockets[0].terminate).toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

it("refuses an admin embed whose stored role was demoted", async () => {
  const socket = await upgrade(embedToken({ id: "owner-1", role: "admin", sv: 0 }));
  expect(socket.write).toHaveBeenCalledWith("HTTP/1.1 401 Unauthorized\r\n\r\n");
  expect(mockClients).toHaveLength(0);
});

it("returns 503 when the session database is unavailable", async () => {
  mockDb.fail = true;
  const socket = await upgrade();
  expect(socket.write).toHaveBeenCalledWith("HTTP/1.1 503 Service Unavailable\r\n\r\n");
  expect(socket.destroy).toHaveBeenCalled();
  expect(mockClients).toHaveLength(0);
});

it("closes an open relay when session storage fails", async () => {
  await upgrade();
  mockDb.fail = true;
  await jest.advanceTimersByTimeAsync(250);
  expect(mockClients[0].send).toHaveBeenCalledWith(expect.stringContaining("session_check_unavailable"));
  expect(mockClients[0].close).toHaveBeenCalled();
  expect(mockSockets[0].terminate).toHaveBeenCalled();
});

it("checks hm session revocation at upgrade and on recheck", async () => {
  const session = { id: "owner-1", role: "admin", hm: 1, jti: "test-session-id" };
  await upgrade(embedToken(session));
  expect(mockHmSession).toHaveBeenCalledWith(session);
  mockHmSession.mockRejectedValue(Object.assign(new Error("revoked"), { statusCode: 401 }));
  await jest.advanceTimersByTimeAsync(250);
  expect(mockClients[0].close).toHaveBeenCalled();
  expect(mockSockets[0].terminate).toHaveBeenCalled();
});

it.each([
  { session: undefined },
  { session: { id: "other-user", role: "user", sv: 0 } },
  { session: { id: "owner-1", role: "user", scope: "gateway-embed" } },
  { agentId: "agent-2" },
  { scope: "other-scope" },
])("refuses unbound or mismatched embed credentials: %p", async (overrides) => {
  const socket = await upgrade(embedToken(undefined, overrides));
  expect(socket.write).toHaveBeenCalledWith("HTTP/1.1 401 Unauthorized\r\n\r\n");
  expect(mockClients).toHaveLength(0);
});

it("keeps a current session open and releases the upgrade error guard", async () => {
  const socket = await upgrade();
  expect(socket.listenerCount("error")).toBe(0);
  await jest.advanceTimersByTimeAsync(750);
  expect(mockClients[0].close).not.toHaveBeenCalled();
});

it("guards client resets during an asynchronous session check", async () => {
  let release;
  mockDb.gate = new Promise((resolve) => { release = resolve; });
  const socket = await upgrade();
  expect(() => socket.emit("error", new Error("ECONNRESET"))).not.toThrow();
  expect(socket.destroy).toHaveBeenCalled();
  release();
  await flush();
  expect(mockClients).toHaveLength(0);
});

it("expires a relay when its originating login expires", async () => {
  await upgrade(embedToken({ id: "owner-1", role: "user", sv: 0, exp: Math.floor(Date.now() / 1000) + 1 }));
  await jest.advanceTimersByTimeAsync(1250);
  expect(mockClients[0].close).toHaveBeenCalled();
});
