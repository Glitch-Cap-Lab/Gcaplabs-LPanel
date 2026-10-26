// The container settings a new Hermes runtime is created with: CPU and memory limits,
// capabilities, PID limit, DNS, the home volume, published ports, network and labels.
// AR0 (retire LPanel): these are the settings the replacement provisioner must keep, so
// they are pinned field by field here before any of the create code is ported.
const HermesBackend = require("../../workers/provisioner/backends/hermes");

const ENV_KEYS = [
  "NORA_AGENT_NETWORK_ISOLATION",
  "NORA_AGENT_NETWORK_PEERS",
  "NORA_ALLOW_SHARED_AGENT_NETWORK",
  "NORA_AGENT_VOLUME_QUOTA",
  "NORA_HOST_MEMORY_BUDGET_MB",
  "DOCKER_AGENT_BIND_IP",
  "HEADMASTER_ORG_FILES_HOST_ROOT",
];

function fakeBackend() {
  const backend = new HermesBackend();
  backend.updateEnv = jest.fn().mockResolvedValue(undefined);
  const bridgeConnect = jest.fn().mockResolvedValue({});
  const created = {
    id: "hermes-container-1",
    start: jest.fn().mockResolvedValue({}),
    inspect: jest.fn().mockResolvedValue({ NetworkSettings: { Networks: {} } }),
    remove: jest.fn().mockResolvedValue({}),
  };
  backend.docker = {
    getImage: jest.fn().mockReturnValue({ inspect: jest.fn().mockResolvedValue({}) }),
    getContainer: jest.fn().mockReturnValue({ inspect: jest.fn().mockRejectedValue(new Error("not found")) }),
    createContainer: jest.fn().mockResolvedValue(created),
    createVolume: jest.fn().mockResolvedValue({}),
    createNetwork: jest.fn().mockResolvedValue({}),
    getNetwork: jest.fn().mockReturnValue({ connect: bridgeConnect }),
  };
  return { backend, bridgeConnect };
}

async function createdSpec(config: Record<string, unknown>) {
  const { backend, bridgeConnect } = fakeBackend();
  await backend.create({ env: {}, image: "ghcr.io/example/runtime@sha256:" + "0".repeat(64), ...config });
  return { spec: backend.docker.createContainer.mock.calls[0][0], backend, bridgeConnect };
}

describe("Hermes runtime container settings", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.NORA_AGENT_NETWORK_ISOLATION = "per-runtime";
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("creates a default runtime with the hardened host settings", async () => {
    process.env.DOCKER_AGENT_BIND_IP = "100.64.0.7";
    const { spec } = await createdSpec({
      id: "abc123",
      name: "Owner Mail",
      gatewayHostPort: 19001,
      dashboardHostPort: 19002,
    });

    expect(spec.HostConfig).toEqual({
      NanoCpus: 2 * 1e9,
      Memory: 2048 * 1024 * 1024,
      RestartPolicy: { Name: "unless-stopped" },
      CapDrop: ["ALL"],
      CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL", "SETGID", "SETUID"],
      SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: 512,
      Dns: ["8.8.8.8", "8.8.4.4", "1.1.1.1"],
      Binds: ["nora_hermes_home_abc123:/opt/data"],
      PortBindings: {
        "8642/tcp": [{ HostIp: "100.64.0.7", HostPort: "19001" }],
        "9119/tcp": [{ HostIp: "100.64.0.7", HostPort: "19002" }],
      },
    });
    expect(spec.ExposedPorts).toEqual({ "8642/tcp": {}, "9119/tcp": {} });
    expect(spec.WorkingDir).toBe("/opt/data");
    expect(spec.Hostname).toBe("owner-mail");
    expect(spec.NetworkingConfig).toEqual({ EndpointsConfig: { "nora-runtime-net-abc123": {} } });
    expect(spec.Labels).toEqual({
      "nora.agent.id": "abc123",
      "nora.agent.name": "Owner Mail",
      "nora.runtime.family": "hermes",
      "nora.runtime.port": "8642",
      "nora.dashboard.port": "9119",
    });
  });

  it("applies the record's CPU and memory size", async () => {
    const { spec } = await createdSpec({ id: "big", name: "Big", vcpu: 1, ram_mb: 3072 });
    expect(spec.HostConfig.NanoCpus).toBe(1e9);
    expect(spec.HostConfig.Memory).toBe(3072 * 1024 * 1024);
  });

  it("publishes ports on loopback when no bind address is set, and only the ports it was given", async () => {
    const { spec } = await createdSpec({ id: "p1", name: "P", gatewayHostPort: 19010 });
    expect(spec.HostConfig.PortBindings).toEqual({
      "8642/tcp": [{ HostIp: "127.0.0.1", HostPort: "19010" }],
    });
    const none = await createdSpec({ id: "p2", name: "P" });
    expect(none.spec.HostConfig.PortBindings).toBeUndefined();
  });

  it("keeps an isolated runtime off the shared default bridge", async () => {
    const { backend, bridgeConnect } = await createdSpec({ id: "iso", name: "Iso" });
    expect(backend.docker.createNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ Name: "nora-runtime-net-iso", Driver: "bridge" }),
    );
    expect(bridgeConnect).not.toHaveBeenCalled();
  });

  it("refuses to create a runtime without network isolation", async () => {
    delete process.env.NORA_AGENT_NETWORK_ISOLATION;
    const { backend } = fakeBackend();
    await expect(backend.create({ id: "x", name: "X", env: {} })).rejects.toThrow(/per-runtime network isolation/);
    expect(backend.docker.createContainer).not.toHaveBeenCalled();
  });
});
