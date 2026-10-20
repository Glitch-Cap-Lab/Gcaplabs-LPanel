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
    listNetworks: jest.fn().mockResolvedValue([{ Name: "nora-agent-net-7" }]),
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
    process.env.NORA_AGENT_NETWORK_ISOLATION = "per-agent";
    process.env.NORA_AGENT_NETWORK_PEERS = "admission, hermes-bridge,bad name!";
    const { backend, network } = mockBackend();
    await backend.create({ id: "7", env: {}, disk_gb: 5 });
    expect(backend.docker.createNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ Name: "nora-agent-net-7", Driver: "bridge" }),
    );
    expect(network.connect.mock.calls.map(([c]) => c.Container)).toEqual(["admission", "hermes-bridge"]);
    const cfg = backend.docker.createContainer.mock.calls[0][0];
    expect(Object.keys(cfg.NetworkingConfig.EndpointsConfig)).toEqual(["nora-agent-net-7"]);
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
    await expect(isolation.ensureAgentNetwork(docker, "9")).resolves.toBe("nora-agent-net-9");
  });

  it("removes the runtime network when the runtime is destroyed", async () => {
    process.env.NORA_AGENT_NETWORK_ISOLATION = "per-agent";
    process.env.NORA_AGENT_NETWORK_PEERS = "admission";
    const { backend, network } = mockBackend();
    await backend.destroy("nora-hermes-x", { agentId: "7", preserveState: true });
    expect(network.disconnect).toHaveBeenCalledWith({ Container: "admission", Force: true });
    expect(network.remove).toHaveBeenCalled();
  });

  it("reconcile re-attaches peers to every labelled runtime network", async () => {
    const { backend, network } = mockBackend();
    await isolation.reconcileAgentNetworks(backend.docker, ["admission"]);
    expect(backend.docker.listNetworks).toHaveBeenCalledWith({
      filters: JSON.stringify({ label: ["nora.agent.network=true"] }),
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
});
