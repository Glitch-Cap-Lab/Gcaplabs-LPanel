// @ts-nocheck
const crypto = require("crypto");
const HermesBackend = require("../../workers/provisioner/backends/hermes");
const { deriveHeadmasterInferenceKey } = require("../../agent-runtime/lib/headmasterInference");

test("new Hermes containers use distinct runtime credentials without copying the configured fleet relay secret", async () => {
  const previous = process.env.HEADMASTER_RELAY_SECRET;
  const canary = crypto.randomBytes(24).toString("hex");
  process.env.HEADMASTER_RELAY_SECRET = canary;
  const log = jest.spyOn(console, "log").mockImplementation(() => {});
  const keys = [];
  try {
    for (const id of ["runtime-a", "runtime-b"]) {
      const backend = new HermesBackend();
      backend._ensureImage = jest.fn().mockResolvedValue(undefined);
      backend._findComposeNetwork = jest.fn().mockResolvedValue(null);
      backend.updateEnv = jest.fn().mockResolvedValue(undefined);
      backend.docker = {
        getContainer: jest
          .fn()
          .mockReturnValue({ inspect: jest.fn().mockRejectedValue(new Error("absent fixture")) }),
        createVolume: jest.fn().mockResolvedValue({}),
        createContainer: jest.fn().mockResolvedValue({
          id,
          start: jest.fn().mockResolvedValue({}),
          remove: jest.fn(),
          inspect: jest
            .fn()
            .mockResolvedValue({ NetworkSettings: { IPAddress: "127.0.0.1", Networks: {} } }),
        }),
        getNetwork: jest.fn().mockReturnValue({ connect: jest.fn().mockResolvedValue({}) }),
      };
      const result = await backend.create({ id, name: id, env: { HEADMASTER_OWNER_ID: id } });
      const config = backend.docker.createContainer.mock.calls[0][0];
      const env = Object.fromEntries(
        config.Env.map((item) => {
          const index = item.indexOf("=");
          return [item.slice(0, index), item.slice(index + 1)];
        }),
      );
      // Booleans keep every synthetic credential out of failure diagnostics.
      expect(
        JSON.stringify([config, backend.updateEnv.mock.calls, log.mock.calls]).includes(canary),
      ).toBe(false);
      expect(Object.hasOwn(env, "HEADMASTER_RELAY_SECRET")).toBe(false);
      expect(env.API_SERVER_KEY === result.gatewayToken).toBe(true);
      expect(
        env.HEADMASTER_INFERENCE_KEY === deriveHeadmasterInferenceKey(result.gatewayToken),
      ).toBe(true);
      expect(env.HEADMASTER_INFERENCE_KEY === result.gatewayToken).toBe(false);
      expect(env.HEADMASTER_OWNER_ID).toBe(id);
      keys.push(result.gatewayToken);
    }
    expect(keys[0] === keys[1]).toBe(false);
  } finally {
    log.mockRestore();
    if (previous === undefined) delete process.env.HEADMASTER_RELAY_SECRET;
    else process.env.HEADMASTER_RELAY_SECRET = previous;
  }
});
