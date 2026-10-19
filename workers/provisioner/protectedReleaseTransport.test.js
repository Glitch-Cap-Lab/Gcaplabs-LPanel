// Actual Dockerode/docker-modem HTTP cancellation against a synthetic loopback daemon.
// No Docker socket, daemon, container, credentials, database or external network.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const Docker = require("dockerode");
const { ProtectedReleaseDocker } = require("./protectedReleaseDocker");
const { packArchive } = require("./protectedReleaseArchive");

for (const phase of ["inspect", "create", "exec", "read", "upload"]) test(`actual Docker HTTP ${phase} cancels its stalled socket`, async t => {
  const partial = (await packArchive([
    { name: "installs", type: "directory", mode: 0o755, content: Buffer.alloc(0) },
    { name: "installs/file", type: "file", mode: 0o600, content: Buffer.alloc(4096) },
  ])).subarray(0, 1200);
  const sockets = new Set(), requests = [], incoming = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    incoming.push(req);
    if (phase === "read") { res.writeHead(200, { "Content-Type": "application/x-tar" }); res.write(partial); }
    else req.pause(); // no response/EOF; upload deliberately does not consume its body
  });
  server.on("connection", socket => sockets.add(socket));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const docker = new Docker({ host: "127.0.0.1", port: server.address().port, protocol: "http" });
  const adapter = new ProtectedReleaseDocker({ docker }, { probeTimeoutMs: 80, archiveTimeoutMs: 80 });
  const container = docker.getContainer("synthetic-old");
  const operation = phase === "inspect" ? () => adapter.inspect(container)
    : phase === "create" ? () => adapter.call(signal => docker.createContainer({ Image: `sha256:${"1".repeat(64)}`, abortSignal: signal }))
    : phase === "exec" ? () => adapter.exec(container, ["fixed-probe"])
    : phase === "read" ? () => adapter.read(container, "/opt/data/installs", "installs")
    : () => adapter.upload(container, [{ name: "installs/file", type: "file", mode: 0o600, content: Buffer.alloc(4 * 1024 * 1024) }], {});
  await assert.rejects(operation(), /DOCKER_TIMEOUT/);
  // A paused server cannot observe peer EOF until it reads its already buffered upload.
  // Resume only after cancellation; the source upload has already been destroyed.
  for (const req of incoming) req.resume();
  for (let attempt = 0; attempt < 25 && [...sockets].some(socket => !socket.destroyed); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(requests.length, 1); assert.equal(sockets.size, 1);
  assert.ok([...sockets].every(socket => socket.destroyed), "request/stream must really close, not just lose a Promise race");
});
