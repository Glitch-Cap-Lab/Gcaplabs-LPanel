// @ts-nocheck
const { EventEmitter } = require("events");
const mockSockets = [];
const mockQuery = jest.fn();
jest.mock("../db", () => ({ query: (...args) => mockQuery(...args) }));
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
    static CLOSED = 3;
    constructor() {
      super();
      this.readyState = Socket.CONNECTING;
      this.send = jest.fn();
      this.close = jest.fn(() => {
        this.readyState = Socket.CLOSED;
      });
      this.terminate = jest.fn(() => {
        this.readyState = Socket.CLOSED;
      });
      mockSockets.push(this);
    }
  }
  class Server {
    constructor() {
      this.handlers = {};
    }
    on(event, handler) {
      this.handlers[event] = handler;
    }
  }
  return { WebSocket: Socket, WebSocketServer: Server };
});
const { attachGatewayWS } = require("../gatewayProxy");

async function pair() {
  mockQuery.mockResolvedValue({
    rows: [
      {
        id: "agent-1",
        user_id: "owner-1",
        effective_role: "owner",
        status: "running",
        deploy_target: "docker",
        gateway_host: "10.0.0.10",
        gateway_port: 19042,
        gateway_token: "unit-test-runtime-credential",
      },
    ],
  });
  const client = new EventEmitter();
  client.readyState = 1;
  client.send = jest.fn();
  // A real close handshake does not emit close synchronously. Cleanup cannot depend on it.
  client.close = jest.fn(() => {
    client.readyState = 2;
  });
  client.terminate = jest.fn(() => {
    client.readyState = 3;
  });
  const server = attachGatewayWS({ on: jest.fn() });
  await server.handlers.connection(client, {}, "agent-1", { id: "owner-1" });
  return { client, gateway: mockSockets.at(-1) };
}

beforeEach(() => {
  jest.useFakeTimers();
  mockSockets.length = 0;
  mockQuery.mockReset();
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it.each([false, true])(
  "closes both sides when authentication is refused (notice throws: %p)",
  async (sendThrows) => {
    const { client, gateway } = await pair();
    gateway.readyState = 1;
    gateway.emit("open");
    if (sendThrows)
      client.send.mockImplementation(() => {
        throw new Error("viewer transport lost");
      });
    const handler = gateway.listeners("message")[0];
    await handler(
      Buffer.from(
        JSON.stringify({ id: "__relay_connect__", ok: false, error: { message: "refused" } }),
      ),
    );
    expect(client.close).toHaveBeenCalled();
    expect(gateway.readyState).toBe(3);
    expect(jest.getTimerCount()).toBe(0);
  },
);

it.each([0, 1])("closes a failed upstream transport in socket state %p", async (state) => {
  const { client, gateway } = await pair();
  gateway.readyState = state;
  gateway.emit("error", new Error("upgrade failed"));
  expect(client.close).toHaveBeenCalled();
  expect(gateway.readyState).toBe(3);
  expect(jest.getTimerCount()).toBe(0);
});

it("closes a viewer even when the upstream-close notice cannot be sent", async () => {
  const { client, gateway } = await pair();
  gateway.readyState = 3;
  client.send.mockImplementation(() => {
    throw new Error("viewer transport lost");
  });
  expect(() => gateway.emit("close", 1006, Buffer.alloc(0))).not.toThrow();
  expect(client.close).toHaveBeenCalled();
});

it.each(["viewer", "gateway"])(
  "closes both sides when %p throws during the authentication exchange",
  async (side) => {
    const { client, gateway } = await pair();
    gateway.readyState = 1;
    gateway.emit("open");
    const failedSocket = side === "viewer" ? client : gateway;
    failedSocket.send.mockImplementation(() => {
      throw new Error("transport lost");
    });
    await gateway.listeners("message")[0](
      Buffer.from(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "unit-test-nonce" },
        }),
      ),
    );
    expect(client.close).toHaveBeenCalled();
    expect(gateway.readyState).toBe(3);
    expect(jest.getTimerCount()).toBe(0);
  },
);

it("keeps an authenticated relay open beyond the handshake timeout", async () => {
  const { client, gateway } = await pair();
  gateway.readyState = 1;
  gateway.emit("open");
  await gateway.listeners("message")[0](
    Buffer.from(JSON.stringify({ id: "__relay_connect__", ok: true })),
  );
  await jest.advanceTimersByTimeAsync(16000);
  expect(client.close).not.toHaveBeenCalled();
  expect(gateway.readyState).toBe(1);
  await client.listeners("message")[0](
    Buffer.from(JSON.stringify({ method: "status", id: "live" })),
  );
  expect(gateway.send).toHaveBeenCalledWith(expect.stringContaining('"id":"live"'));
  client.emit("close");
  expect(gateway.readyState).toBe(3);
  expect(jest.getTimerCount()).toBe(0);
});

it("bounds the wait for an upstream authentication response and drops queued messages", async () => {
  const { client, gateway } = await pair();
  gateway.readyState = 1;
  gateway.emit("open");
  await gateway.listeners("message")[0](
    Buffer.from(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "unit-test-nonce" },
      }),
    ),
  );
  await client.listeners("message")[0](
    Buffer.from(JSON.stringify({ method: "status", id: "queued" })),
  );
  await jest.advanceTimersByTimeAsync(8000);
  expect(client.close).toHaveBeenCalled();
  expect(gateway.readyState).toBe(3);
  const sent = gateway.send.mock.calls.length;
  await gateway.listeners("message")[0](
    Buffer.from(JSON.stringify({ id: "__relay_connect__", ok: true })),
  );
  expect(gateway.send).toHaveBeenCalledTimes(sent);
  expect(jest.getTimerCount()).toBe(0);
});
