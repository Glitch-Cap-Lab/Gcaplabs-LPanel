const HermesBackend = require("../../workers/provisioner/backends/hermes");
const budget = require("../../workers/provisioner/backends/hostMemoryBudget");

const MB = 1024 ** 2;

function dockerWith(runtimes) {
  return {
    listContainers: jest.fn().mockResolvedValue(
      runtimes.map((r) => ({ Id: `c${r.agent}`, Labels: { "nora.agent.id": r.agent }, State: r.state || "running" })),
    ),
    getContainer: jest.fn((id) => ({
      inspect: jest.fn().mockResolvedValue({
        HostConfig: { Memory: runtimes.find((r) => `c${r.agent}` === id).mb * MB },
      }),
    })),
  };
}

describe("host memory budget", () => {
  afterEach(() => delete process.env.NORA_HOST_MEMORY_BUDGET_MB);

  it("does nothing without a budget", async () => {
    await expect(
      budget.assertHostMemoryBudget(dockerWith([{ agent: "1", mb: 99999 }]), { agentId: "2", requestedMb: 99999 }),
    ).resolves.toBeUndefined();
  });

  it("allows a runtime that fits and refuses one that does not", async () => {
    process.env.NORA_HOST_MEMORY_BUDGET_MB = "6144";
    const docker = dockerWith([{ agent: "1", mb: 3072 }, { agent: "2", mb: 2048 }]);
    await expect(budget.assertHostMemoryBudget(docker, { agentId: "3", requestedMb: 1024 })).resolves.toBeUndefined();
    await expect(budget.assertHostMemoryBudget(docker, { agentId: "3", requestedMb: 1025 })).rejects.toMatchObject({
      code: "HOST_MEMORY_BUDGET_EXCEEDED",
      details: { budgetMb: 6144, reservedMb: 5120, requestedMb: 1025 },
    });
  });

  it("a recreate replaces the runtime's own reservation", async () => {
    process.env.NORA_HOST_MEMORY_BUDGET_MB = "4096";
    const docker = dockerWith([{ agent: "1", mb: 3072 }]);
    await expect(budget.assertHostMemoryBudget(docker, { agentId: "1", requestedMb: 4096 })).resolves.toBeUndefined();
  });

  it("stopped containers, like a release's kept previous container, reserve nothing", async () => {
    process.env.NORA_HOST_MEMORY_BUDGET_MB = "4096";
    const docker = dockerWith([{ agent: "1", mb: 3072, state: "exited" }, { agent: "2", mb: 3072, state: "exited" }, { agent: "3", mb: 3072 }]);
    await expect(budget.assertHostMemoryBudget(docker, { agentId: "4", requestedMb: 1024 })).resolves.toBeUndefined();
    await expect(budget.assertHostMemoryBudget(docker, { agentId: "4", requestedMb: 1025 })).rejects.toMatchObject({ details: { reservedMb: 3072 } });
  });

  it("create() stops before building anything when over budget", async () => {
    process.env.NORA_HOST_MEMORY_BUDGET_MB = "2048";
    process.env.NORA_ALLOW_SHARED_AGENT_NETWORK = "true";
    try {
      const backend = new HermesBackend();
      backend._ensureImage = jest.fn().mockResolvedValue(undefined);
      backend.docker = {
        ...dockerWith([{ agent: "1", mb: 2048 }]),
        createVolume: jest.fn().mockResolvedValue({}),
        createContainer: jest.fn(),
        getContainer: jest.fn((id) => ({
          inspect: jest.fn().mockImplementation(async () =>
            id === "c1" ? { HostConfig: { Memory: 2048 * MB } } : Promise.reject(Object.assign(new Error("none"), { statusCode: 404 })),
          ),
        })),
      };
      await expect(backend.create({ id: "2", env: {}, ram_mb: 1024, disk_gb: 5 })).rejects.toThrow(/Refusing to start a runtime: this host/);
      expect(backend.docker.createContainer).not.toHaveBeenCalled();
    } finally {
      delete process.env.NORA_ALLOW_SHARED_AGENT_NETWORK;
    }
  });
});
