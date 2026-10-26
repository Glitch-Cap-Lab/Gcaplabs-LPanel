const DockerBackend = require("../../workers/provisioner/backends/docker");

describe("DockerBackend.containerExists", () => {
  function make(inspect) {
    const backend = new DockerBackend();
    backend.docker = { getContainer: jest.fn().mockReturnValue({ inspect }) };
    return backend;
  }

  it("is true when Docker inspects the container", async () => {
    const backend = make(jest.fn().mockResolvedValue({ Id: "abc" }));
    await expect(backend.containerExists("nora-hermes-x")).resolves.toBe(true);
    expect(backend.docker.getContainer).toHaveBeenCalledWith("nora-hermes-x");
  });

  it("is false only on a Docker 404", async () => {
    const backend = make(
      jest.fn().mockRejectedValue(Object.assign(new Error("no such container"), { statusCode: 404 })),
    );
    await expect(backend.containerExists("nora-hermes-x")).resolves.toBe(false);
  });

  it("throws on any other Docker error instead of reporting absent", async () => {
    const backend = make(jest.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));
    await expect(backend.containerExists("nora-hermes-x")).rejects.toThrow(/ECONNREFUSED/);
  });
});
