// @ts-nocheck
// Real local HTTP/WebSocket peers exercise the upgrade and relay close path.
const http = require("node:http");
const { once } = require("node:events");
const jwt = require("jsonwebtoken");
const mockState = { version: 0, fail: false, port: 0 };
jest.mock("../db", () => ({
  query: jest.fn(async (sql) => {
    if (mockState.fail) throw new Error("session storage unavailable");
    if (sql.startsWith("SELECT role, session_version FROM users")) {
      return { rows: [{ role: "user", session_version: mockState.version }] };
    }
    if (sql.includes("FROM agents")) return { rows: [{
      id: "agent-1", user_id: "owner-1", effective_role: "owner", status: "running",
      deploy_target: "docker", gateway_host: "127.0.0.1", gateway_port: mockState.port,
      gateway_token: "local-test-runtime-password",
    }] };
    throw new Error(`Unexpected query: ${sql}`);
  }),
}));
jest.unmock("../sessionVersion");
jest.mock("../crypto", () => ({ decrypt: (value) => value }));
jest.mock("../integrations", () => ({}));
jest.mock("../metrics", () => ({}));
jest.mock("../agentBudgets", () => ({}));
jest.mock("../remoteHosts", () => ({ isRemoteDockerAgent: () => false }));

let relayHttp, relayWss, runtimeHttp, runtimeWss, WebSocket;
let clients;
const originalEnv = {};
const envNames = ["JWT_SECRET", "REMOTE_HOST_AUTH_RECHECK_MS", "NORA_GATEWAY_PROXY_ALLOWED_PORTS"];
beforeAll(() => {
  for (const name of envNames) originalEnv[name] = process.env[name];
});
beforeEach(async () => {
  jest.resetModules();
  process.env.JWT_SECRET = "local-gateway-transport-test-secret";
  process.env.REMOTE_HOST_AUTH_RECHECK_MS = "250";
  mockState.version = 0;
  mockState.fail = false;
  clients = [];
  const ws = require("ws");
  WebSocket = ws.WebSocket;
  runtimeHttp = http.createServer();
  runtimeWss = new ws.WebSocketServer({ server: runtimeHttp });
  runtimeWss.on("connection", (peer) => {
    peer.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "local-nonce" } }));
    peer.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.method === "connect") peer.send(JSON.stringify({ id: message.id, ok: true }));
    });
  });
  runtimeHttp.listen(0, "127.0.0.1");
  await once(runtimeHttp, "listening");
  mockState.port = runtimeHttp.address().port;
  process.env.NORA_GATEWAY_PROXY_ALLOWED_PORTS = String(mockState.port);
  relayHttp = http.createServer();
  relayWss = require("../gatewayProxy").attachGatewayWS(relayHttp);
  relayHttp.listen(0, "127.0.0.1");
  await once(relayHttp, "listening");
});
afterEach(async () => {
  for (const peer of [...clients, ...relayWss.clients, ...runtimeWss.clients]) peer.terminate();
  await Promise.all([relayWss, runtimeWss, relayHttp, runtimeHttp].map((server) =>
    new Promise((resolve) => server.close(resolve)),
  ));
});
afterAll(() => {
  for (const name of envNames) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
});

function connect() {
  const token = jwt.sign({
    id: "owner-1", agentId: "agent-1", scope: "gateway-embed",
    session: { id: "owner-1", role: "user", sv: 0 },
  }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "15m" });
  const client = new WebSocket(`ws://127.0.0.1:${relayHttp.address().port}/ws/gateway/agent-1`, {
    headers: { Cookie: `__nora_gateway_embed_agent-1=${token}` },
  });
  client.on("error", () => {});
  clients.push(client);
  return client;
}

function nextMessage(client, predicate) {
  return new Promise((resolve) => {
    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (!predicate(message)) return;
      client.removeListener("message", onMessage);
      resolve(message);
    };
    client.on("message", onMessage);
  });
}

it.each([[false, 401], [true, 503]])("rejects a real upgrade (storage failure: %p)", async (fail, status) => {
  mockState.version = 1;
  mockState.fail = fail;
  const client = connect();
  const response = await new Promise((resolve, reject) => {
    client.once("unexpected-response", (_request, response) => { response.resume(); resolve(response); });
    client.once("open", () => reject(new Error("revoked session upgraded")));
  });
  expect(response.statusCode).toBe(status);
  expect(relayWss.clients.size).toBe(0);
  expect(runtimeWss.clients.size).toBe(0);
});

it("closes a real relay and its runtime peer after logout", async () => {
  const runtimeConnected = once(runtimeWss, "connection");
  const client = connect();
  await once(client, "open");
  const [runtime] = await runtimeConnected;
  const ready = nextMessage(client, (message) => message.id === "client-ready");
  client.send(JSON.stringify({ method: "connect", id: "client-ready" }));
  expect(await ready).toMatchObject({ type: "res", ok: true });
  const clientClosed = once(client, "close");
  const runtimeClosed = once(runtime, "close");
  const notice = nextMessage(client, (message) => message.type === "error");
  mockState.version++;
  expect(await notice).toMatchObject({ type: "error", code: "session_revoked" });
  await Promise.all([clientClosed, runtimeClosed]);
  expect(client.readyState).toBe(WebSocket.CLOSED);
  expect(runtime.readyState).toBe(WebSocket.CLOSED);
});
