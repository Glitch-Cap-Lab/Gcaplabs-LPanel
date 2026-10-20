const HermesBackend = require("../../workers/provisioner/backends/hermes");
const isolation = require("../../workers/provisioner/backends/agentIsolation");

const ENV_KEYS = ["NORA_AGENT_NETWORK_ISOLATION", "NORA_AGENT_NETWORK_PEERS", "NORA_AGENT_VOLUME_QUOTA", "NORA_AGENT_NETWORK"];

function mockBackend() {
  const backend = new HermesBackend();
  backend.updateEnv = jest.fn().mockResolvedValue(undefined);
  backend._ensureImage = jest.fn().mockResolvedValue(undefined);
  backend._findComposeNetwork = jest.fn().mockResolvedValue("shared-net");
  const network = {
    connect: jest.fn().mockResolvedValue({}),
    disconnect: jest.fn().mockResolvedValue({}),
    remove: jest.fn().mockResolvedValue({}),
    inspect: jest.fn().mockResolvedValue({ Containers: {} }),
  };
  const container = {
    id: "c1",
    start: jest.fn().mockResolvedValue({}),
    remove: jest.fn().mockResolvedValue({}),
    inspect: jest.fn().mockResolvedValue({ NetworkSettings: { Networks: {} } }),
  };
  backend.docker = {
    getContainer: jest.fn().mockReturnValue({ inspect: jest.fn().mockRejectedValue(Object.assign(new Error("no such container"), { statusCode: 404 })) }),
    createVolume: jest.fn().mockResolvedValue({}),
    createContainer: jest.fn().mockResolvedValue(container),
    createNetwork: jest.fn().mockResolvedValue({}),
    getNetwork: jest.fn().mockReturnValue(network),
    listNetworks: jest.fn().mockResolvedValue([{ Name: "nora-runtime-net-7" }]),
  };
  return { backend, network };
}

describe("Cloud runtime isolation (opt-in)", () => {
  beforeEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));
  afterAll(() => ENV_KEYS.forEach((k) => delete process.env[k]));

  it("changes nothing when the settings are unset", async () => {
    const { backend } = mockBackend();
    await backend.create({ id: "7", env: {}, disk_gb: 5 });
    expect(backend.docker.createNetwork).not.toHaveBeenCalled();
    expect(backend.docker.createVolume).toHaveBeenCalledWith({ Name: "nora_hermes_home_7" });
    expect(backend.docker.getNetwork).toHaveBeenCalledWith("bridge");
    const cfg = backend.docker.createContainer.mock.calls[0][0];
    expect(Object.keys(cfg.NetworkingConfig.EndpointsConfig)).toEqual(["shared-net"]);
  });

  it("puts each runtime alone on its own network, with only the listed peers", async () => {
    process.env.NORA_AGENT_NETWORK_ISOLATION = "per-runtime";
    process.env.NORA_AGENT_NETWORK_PEERS = "admission, hermes-bridge,bad name!";
    const { backend, network } = mockBackend();
    await backend.create({ id: "7", env: {}, disk_gb: 5 });
    expect(backend.docker.createNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ Name: "nora-runtime-net-7", Driver: "bridge" }),
    );
    expect(network.connect.mock.calls.map(([c]) => c.Container)).toEqual(["admission", "hermes-bridge"]);
    const cfg = backend.docker.createContainer.mock.calls[0][0];
    expect(Object.keys(cfg.NetworkingConfig.EndpointsConfig)).toEqual(["nora-runtime-net-7"]);
    expect(backend._findComposeNetwork).not.toHaveBeenCalled();
    // Never joins the shared default bridge.
    expect(backend.docker.getNetwork).not.toHaveBeenCalledWith("bridge");
  });

  it("a missing peer does not fail the deploy, and an existing network is reused", async () => {
    process.env.NORA_AGENT_NETWORK_PEERS = "gone";
    const docker = {
      createNetwork: jest.fn().mockRejectedValue(Object.assign(new Error("exists"), { statusCode: 409 })),
      getNetwork: jest.fn().mockReturnValue({
        connect: jest.fn().mockRejectedValue(Object.assign(new Error("no such container"), { statusCode: 404 })),
      }),
    };
    await expect(isolation.ensureAgentNetwork(docker, "9")).resolves.toBe("nora-runtime-net-9");
  });

  it("removes the runtime network when the runtime is destroyed", async () => {
    process.env.NORA_AGENT_NETWORK_ISOLATION = "per-runtime";
    process.env.NORA_AGENT_NETWORK_PEERS = "admission";
    const { backend, network } = mockBackend();
    await backend.destroy("nora-hermes-x", { agentId: "7", preserveState: true });
    expect(network.disconnect).toHaveBeenCalledWith({ Container: "admission", Force: true });
    expect(network.remove).toHaveBeenCalled();
  });

  it("removes the runtime network on delete even where the isolation settings are not set", async () => {
    const { backend, network } = mockBackend();
    network.inspect.mockResolvedValue({ Containers: { a: { Name: "nora-backend-api-1" }, b: { Name: "admission" } } });
    await backend.destroy("nora-hermes-x", { agentId: "7" });
    expect(network.disconnect.mock.calls.map(([c]) => c.Container).sort()).toEqual(["admission", "nora-backend-api-1"]);
    expect(network.remove).toHaveBeenCalled();
  });

  it("does nothing on delete when the agent never had a runtime network", async () => {
    const { backend, network } = mockBackend();
    network.inspect.mockRejectedValue(Object.assign(new Error("no such network"), { statusCode: 404 }));
    await backend.destroy("nora-hermes-x", { agentId: "7" });
    expect(network.disconnect).not.toHaveBeenCalled();
    expect(network.remove).not.toHaveBeenCalled();
  });

  it("reconcile re-attaches peers to every labelled runtime network", async () => {
    const { backend, network } = mockBackend();
    await isolation.reconcileAgentNetworks(backend.docker, ["admission"]);
    expect(backend.docker.listNetworks).toHaveBeenCalledWith({
      filters: JSON.stringify({ label: ["nora.runtime.network=true"] }),
    });
    expect(network.connect).toHaveBeenCalledWith({ Container: "admission" });
  });

  it("sizes the home volume from disk_gb only when quota is enforced", async () => {
    process.env.NORA_AGENT_VOLUME_QUOTA = "enforce";
    const { backend } = mockBackend();
    await backend.create({ id: "7", env: {}, disk_gb: 5 });
    expect(backend.docker.createVolume).toHaveBeenCalledWith({
      Name: "nora_hermes_home_7",
      DriverOpts: { size: "5g" },
    });
    expect(isolation.volumeQuotaOptions(undefined)).toBeNull();
    expect(isolation.volumeQuotaOptions(0)).toBeNull();
  });

  it("monitor mode reports volumes over their disk_gb and ignores unknown or unmeasured ones", async () => {
    const GB = 1024 ** 3;
    const docker = {
      df: jest.fn().mockResolvedValue({
        Volumes: [
          { Name: "nora_hermes_home_1", UsageData: { Size: 6 * GB } },
          { Name: "nora_hermes_home_2", UsageData: { Size: 1 * GB } },
          { Name: "nora_hermes_home_3", UsageData: { Size: -1 } },
          { Name: "nora_hermes_home_9", UsageData: { Size: 99 * GB } },
          { Name: "other", UsageData: { Size: 99 * GB } },
        ],
      }),
    };
    const over = await isolation.findOverQuotaVolumes(docker, { 1: 5, 2: 5, 3: 5 });
    expect(over).toEqual([{ agentId: "1", usedBytes: 6 * GB, limitBytes: 5 * GB }]);
    process.env.NORA_AGENT_VOLUME_QUOTA = "monitor";
    expect(isolation.volumeQuotaOptions(5)).toBeNull(); // monitor never changes volume creation
  });
});
