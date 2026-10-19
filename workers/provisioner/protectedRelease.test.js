const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const crypto = require("node:crypto");
const { readArchive, packArchive } = require("./protectedReleaseArchive");
const { validateManifest, envFingerprint, digest } = require("./protectedReleaseManifest");
const { ProtectedReleaseDocker } = require("./protectedReleaseDocker");
const { runProtectedRuntimeRelease } = require("./protectedRuntimeRelease");
const { runProtectedReleaseJob } = require("./protectedReleaseJob");
const { createProtectedReleaseState } = require("./protectedReleaseState");
const { readProtectedReleaseStatus } = require("./protectedReleaseStatus");
const { run: command } = require("../../scripts/headmaster/runtime-release");

const uuid = n => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const image = n => `sha256:${String(n).repeat(64)}`;
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
const missing = () => Object.assign(new Error("not found"), { statusCode: 404 });

async function fixture(t, options = {}) {
  const root = options.root || await fs.mkdtemp(path.join(os.tmpdir(), "protected-release-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".worker-tmp"), { recursive: true });
  if (!options.resume) {
    await fs.mkdir(path.join(root, "installs/gen/.leases"), { recursive: true });
    for (const [file, value] of [["installs/gen/facts.json", "good"], ["config.yaml", "old-config"], [".env", "private-config"], ["state.db", "new chat must survive"]]) await fs.writeFile(path.join(root, file), value);
  }
  const saved = options.resume ? JSON.parse(await fs.readFile(path.join(root, ".fake-docker.json"), "utf8")) : null;
  const events = saved?.events || [], containers = new Map(saved?.containers || []), metadata = new Map(saved?.metadata || []);
  const faults = {};
  let lastReceipt = saved?.lastReceipt || null;
  const contract = Buffer.from("canonical contract"), lock = Buffer.from("locked dependencies");
  const runtime = { container_id: "old", container_name: "hm-owned", host: "hm-owned", backend_type: "docker", runtime_family: "hermes", deploy_target: "docker", execution_target_id: "docker", sandbox_profile: "standard" };
  const env = [`HEADMASTER_OWNER_ID=${uuid(3)}`, `HEADMASTER_WORKSPACE_ID=${uuid(4)}`, "API_SERVER_KEY=synthetic-private-value"];
  const manifest = { format: "headmaster-protected-runtime-release/v1", sources: { core: "a".repeat(40), webapp: "b".repeat(40), lpanel: "c".repeat(40) },
    image: { id: image(2), uid: 10000, gid: 10000, contract_sha256: sha(contract), dependency_sha256: sha(lock) },
    targets: [{ agent_id: uuid(1), owner_id: uuid(2), account_id: uuid(3), workspace_id: uuid(4), container_id: "old", container_name: "hm-owned", image_id: image(1), image_binding: "old-tag", env_sha256: envFingerprint(env), volume: "owned-volume", runtime, status: "running" }], env_delta: { set: {} } };
  let row = saved?.row || { id: uuid(1), user_id: uuid(2), external_namespace: "headmaster", external_owner_uuid: uuid(3), external_id: uuid(4), headmaster_owner_id: uuid(3), headmaster_workspace_id: uuid(4), ...runtime, status: "queued", image: "old-tag" };
  const persist = () => require("node:fs").writeFileSync(path.join(root, ".fake-docker.json"), JSON.stringify({ row, events, lastReceipt, containers: [...containers], metadata: [...metadata] }));
  const old = { Id: "old", Name: "/hm-owned", Image: image(1), State: { Running: true }, Config: { Env: env, Image: "old-tag", Labels: { "nora.agent.id": uuid(1) } },
    HostConfig: { PortBindings: { "8642/tcp": [{ HostIp: "127.0.0.1", HostPort: "1234" }] }, RestartPolicy: { Name: "unless-stopped" } },
    Mounts: [{ Name: "owned-volume", Destination: "/opt/data", Type: "volume", RW: true }], NetworkSettings: { Networks: { private: { Aliases: ["hm-owned"], IPAMConfig: {} } } } };
  if (!options.resume) containers.set("old", old);
  const resolve = name => [...containers.values()].find(c => c.Id === name || c.Name === `/${name}`);
  const local = raw => { assert.ok(raw.startsWith("/opt/data/")); const p = path.resolve(root, raw.slice(10)); assert.ok(p.startsWith(root + path.sep)); return p; };
  async function archive(raw) {
    if (raw.startsWith("/opt/hermes/")) return packArchive([{ name: raw.split("/").at(-1), type: "file", mode: 0o600, content: raw.endsWith("uv.lock") ? lock : contract }]);
    const start = local(raw); let stat;
    try { stat = await fs.stat(start); } catch { throw missing(); }
    const rows = [];
    async function visit(p, name) {
      const st = await fs.stat(p), meta = metadata.get(p) || {};
      rows.push({ name, type: st.isDirectory() ? "directory" : "file", uid: meta.uid ?? 10000, gid: meta.gid ?? 10000, mode: meta.mode ?? (st.isDirectory() ? 0o755 : 0o600), content: st.isDirectory() ? Buffer.alloc(0) : await fs.readFile(p) });
      if (st.isDirectory()) for (const child of await fs.readdir(p)) await visit(path.join(p, child), `${name}/${child}`);
    }
    await visit(start, path.basename(start)); return packArchive(rows, { preserveOwnership: true });
  }
  const docker = {
    modem: { demuxStream(raw, stdout) { raw.on("data", x => stdout.write(x)); } },
    getImage() { return { async inspect() { return { Id: image(2), Config: { Labels: { "org.opencontainers.image.revision": manifest.sources.core, "com.gcaplabs.webapp.revision": manifest.sources.webapp } } }; } }; },
    async listContainers(options = {}) { return [...containers.values()].filter(c => options.all || c.State.Running).filter(c => !options.filters || (c.Config.Labels?.["headmaster.release.id"] === digest(manifest))).map(c => ({ Id: c.Id })); },
    getContainer(name) {
      const get = () => { const c = resolve(name); if (!c) throw missing(); return c; };
      return {
        async inspect() { return clone(get()); },
        async stop() { events.push(`stop:${get().Id}`); get().State.Running = false; persist(); if (options.killAfterStop && get().Id === "old") process.exit(25); },
        async start() {
          const c = get(); events.push(`start:${c.Id}`); c.State.Running = true;
          if (c.Config.Labels?.["headmaster.release.maintenance"]) {
            const [flag, program, source, destination] = c.Config.Cmd;
            assert.equal(flag, "-c"); assert.match(program, /os\.rename\(src,dst\)/); assert.match(program, /os\.fsync\(fd\)/);
            assert.deepEqual(c.Config.Entrypoint, ["/opt/hermes/.venv/bin/python"]); assert.equal(c.Image, image(1));
            assert.equal(c.HostConfig.NetworkMode, "none"); assert.equal(c.Config.NetworkDisabled, true);
            assert.deepEqual(c.HostConfig.CapDrop, ["ALL"]); assert.deepEqual(c.HostConfig.CapAdd, ["DAC_OVERRIDE", "FOWNER"]);
            assert.equal(c.Config.User, "0:0");
            if (faults.restore) { c.exit = 1; return; }
            await fs.rename(local(source), local(destination));
            for (const [p, meta] of [...metadata]) if (p === local(source) || p.startsWith(local(source) + path.sep)) { metadata.delete(p); metadata.set(local(destination) + p.slice(local(source).length), meta); }
            c.exit = 0; c.State.Running = false;
            persist();
            if (options.killAfterRestore && destination === "/opt/data/installs") process.exit(24);
          } else if (c.Id !== "old") {
            await fs.writeFile(path.join(root, "installs/gen/facts.json"), "failed-attempt");
            await fs.writeFile(path.join(root, "config.yaml"), "candidate-config");
          }
          persist();
          if (options.killAfterOldStart && c.Id === "old") process.exit(28);
        },
        async wait() { return { StatusCode: get().exit || 0 }; },
        async rename({ name }) { const c = get(); events.push(`rename:${c.Id}`); c.Name = `/${name}`; persist(); if (options.killAfterRestoreName && c.Id === "old" && name === "hm-owned") process.exit(27); },
        async getArchive({ path: p }) { if (faults.stage && p === "/opt/data/installs") throw new Error("archive failure"); return require("node:stream").Readable.from(await archive(p)); },
        async putArchive(buffer) {
          const tar = require("tar-stream"), extract = tar.extract();
          const done = new Promise((resolve, reject) => {
            extract.on("error", reject); extract.on("finish", resolve);
            extract.on("entry", (header, stream, next) => {
              const chunks = []; stream.on("data", x => chunks.push(x)); stream.on("end", async () => {
                try { const p = local(`/opt/data/${header.name}`); await fs.mkdir(path.dirname(p), { recursive: true });
                  if (header.type === "directory") await fs.mkdir(p, { recursive: true }); else await fs.writeFile(p, Buffer.concat(chunks));
                  metadata.set(p, { mode: header.mode, uid: header.uid, gid: header.gid }); next();
                } catch (e) { reject(e); }
              });
            });
          }); if (buffer.pipe) buffer.pipe(extract); else extract.end(buffer); await done; persist();
          if (options.killAfterStage && await fs.stat(path.join(root, `.protected-release-${digest(manifest)}`, "before/installs")).then(() => true, () => false)) process.exit(26);
        },
        async exec(options) {
          events.push(`exec:${options.User}`);
          return { async start() { const stream = new PassThrough(); setImmediate(() => { stream.end(options.Cmd[0] === "du" ? "1 /opt/data/installs" : "ready"); }); return stream; }, async inspect() { return { ExitCode: 0 }; } };
        },
      };
    },
    async createContainer(cfg) {
      const id = cfg.Labels?.["headmaster.release.maintenance"] ? `helper-${containers.size}` : "candidate";
      const c = { ...clone(old), Id: id, Name: `/${cfg.name || id}`, Image: cfg.Image, Config: clone(cfg), HostConfig: clone(cfg.HostConfig), State: { Running: false } };
      containers.set(id, c); events.push(`create:${id}`); persist();
      if (id === "candidate" && options.killAfterCreate) process.exit(23);
      return docker.getContainer(id);
    },
  };
  const state = { async read() { return clone(row); }, async assertRecoverable() { if (faults.binding) throw new Error("changed"); },
    async commit(m, id) { events.push("commit"); row.container_id = id; row.image = m.image.id; row.status = "running"; persist(); if (faults.commit) throw new Error("database outage after CAS"); },
    async rollback() { events.push("rollback-row"); row = { ...row, ...runtime, image: "old-tag", status: "running" }; persist(); } };
  const backend = { docker, _containerUserOwnership: async container => ({ uid: faults.uid || (faults.candidateUid && (await container.inspect()).Id === "candidate") ? 10001 : 10000, gid: 10000 }) };
  const adapter = new ProtectedReleaseDocker(backend, { stagingRoot: path.join(root, ".worker-tmp"), checkReadiness: async () => { if (faults.health) throw new Error("health failed"); return { ok: true }; } });
  const receipts = [];
  const run = options => runProtectedRuntimeRelease({ manifest, adapter, state, receipt: saved?.lastReceipt,
    saveReceipt: async r => { lastReceipt = clone(r); persist(); receipts.push(clone(r)); if (faults.queue && r.phase === "candidate_created") throw new Error("Redis outage"); }, ...options });
  return { manifest, root, adapter, state, docker, backend, events, faults, run, receipts, row: () => row, setRow: value => { row = value; persist(); } };
}

// A query adapter exercises the actual maintained SQL/CAS implementation without a live database.
function database(f, deploymentId = uuid(10)) {
  const deployments = new Map([[deploymentId, "queued"], [uuid(11), "completed"]]);
  const queries = []; let snapshot;
  return { deployments, queries, async query(sql, params = []) {
    sql = sql.replace(/\s+/g, " ").trim(); queries.push({ sql, params });
    if (sql === "BEGIN") { snapshot = { row: clone(f.row()), deployments: [...deployments] }; return { rows: [] }; }
    if (sql === "COMMIT") { snapshot = null; return { rows: [] }; }
    if (sql === "ROLLBACK") { if (snapshot) { f.setRow(snapshot.row); deployments.clear(); for (const x of snapshot.deployments) deployments.set(...x); snapshot = null; } return { rows: [] }; }
    if (sql.startsWith("SELECT * FROM agents")) return { rows: [clone(f.row())] };
    if (sql.startsWith("UPDATE agents SET container_id")) {
      const [id, container_id, image, status, owner, account, workspace, oldId, oldImage, oldStatus] = params, row = f.row();
      if (row.id !== id || row.user_id !== owner || row.external_owner_uuid !== account || row.external_id !== workspace || row.container_id !== oldId || row.image !== oldImage || row.status !== oldStatus) return { rows: [] };
      f.setRow({ ...row, container_id, image, status }); return { rows: [{ id }] };
    }
    if (sql.startsWith("UPDATE agents SET status = 'running'")) {
      if (f.row().status !== "deploying" || f.row().container_id !== params[1]) return { rows: [] };
      f.setRow({ ...f.row(), status: "running" }); return { rows: [{ id: params[0] }] };
    }
    if (sql.startsWith("UPDATE deployments SET status")) {
      assert.match(sql, /\bid = (?:\$2|ANY\(\$2::uuid\[\]\))/);
      const status = sql.match(/SET status = '([^']+)'/)[1], ids = Array.isArray(params[1]) ? params[1] : [params[1]];
      const rows = [];
      for (const id of ids) if (deployments.has(id)) { deployments.set(id, status); rows.push({ id, agent_id: params[0] }); }
      return { rows };
    }
    if (sql.startsWith("INSERT INTO events")) return { rows: [] };
    throw new Error(`Unexpected test query: ${sql}`);
  } };
}

module.exports = { fixture };
if (!process.env.PROTECTED_RELEASE_FIXTURE_ONLY) {
test("immutable manifest rejects secret env inputs and unsupported owner/UID/targets", async t => {
  const f = await fixture(t);
  for (const mutate of [m => { m.env_delta.set.API_SERVER_KEY = "synthetic-secret"; }, m => { m.image.uid = 0; },
    m => { m.targets[0].owner_id = "unknown"; }, m => { m.targets.push(clone(m.targets[0])); }, m => { m.targets[0].runtime.backend_type = "remote-docker"; }]) {
    const input = clone(f.manifest); mutate(input); assert.throws(() => validateManifest(input));
  }
  const captured = validateManifest(f.manifest); f.manifest.targets[0].volume = "changed-later";
  assert.equal(captured.target.volume, "owned-volume");
});

test("actual worker/controller/state path keeps exact deployment identity and server-owned status", async t => {
  const f = await fixture(t), db = database(f), deploymentId = uuid(10);
  const job = { id: `protected-release-${digest(f.manifest)}`, data: { id: uuid(1), replace_existing_runtime: true,
    protected_release: { manifest: f.manifest, release_id: digest(f.manifest), action: "apply", deployment_id: deploymentId } },
    async updateData(value) { this.data = value; }, async getState() { return "completed"; } };
  const result = await runProtectedReleaseJob(job, { db, agentRow: f.row(), loadBackend: async () => f.backend,
    withProviderMutationLock: async (owner, fn) => { assert.equal(owner, uuid(2)); return fn(); }, checkReadiness: async () => ({ ok: true }) });
  assert.equal(result.phase, "external_metadata_pending"); assert.equal(result.deployment_id, deploymentId);
  assert.equal(result.external_binding_unchanged, null); assert.equal(db.deployments.get(deploymentId), "completed");
  const status = await readProtectedReleaseStatus({ manifest: f.manifest, adapter: f.adapter, state: createProtectedReleaseState(db, uuid(1), deploymentId), job });
  assert.equal(status.observed.container_id, "candidate"); assert.equal(status.observed.runtime.candidate.image_id, image(2));
  assert.equal(status.publication_blocked, true); assert.equal(status.external_metadata_confirmed, false);
  assert.ok(!JSON.stringify(status).includes("synthetic-private-value"));
  assert.equal(db.deployments.get(uuid(11)), "completed");
});

test("queue ACK failure after real state commit compensates only this completed deployment", async t => {
  const f = await fixture(t), db = database(f), deploymentId = uuid(10); let failed = false;
  await assert.rejects(f.run({ state: createProtectedReleaseState(db, uuid(1), deploymentId), deploymentId,
    saveReceipt: async receipt => { if (!failed && receipt.phase === "external_metadata_pending") { failed = true; throw new Error("lost queue ACK"); } } }), /PROTECTED_RELEASE_FAILED/);
  assert.equal(f.row().container_id, "old"); assert.equal(f.row().status, "running");
  assert.equal(db.deployments.get(deploymentId), "failed"); assert.equal(db.deployments.get(uuid(11)), "completed");
  const receipt = await f.adapter.readReceipt(f.manifest.targets[0], { old: `hm-owned-release-${digest(f.manifest).slice(0, 16)}`, stage: `.protected-release-${digest(f.manifest)}` });
  assert.equal(receipt.phase, "rolled_back"); assert.equal(receipt.lp_committed, false);
});

test("recovery owner mismatch refuses before stopping the current candidate", async t => {
  const f = await fixture(t); await f.run(); const before = f.events.length; f.faults.binding = true;
  await assert.rejects(f.run({ action: "recover" }), /changed/);
  assert.equal(f.events.slice(before).filter(x => x.startsWith("stop:")).length, 0);
});

test("real worker preflight rejection compensates exact queued state without runtime mutation", async t => {
  const f = await fixture(t), db = database(f); f.faults.uid = true;
  const job = { id: "protected-job", data: { id: uuid(1), replace_existing_runtime: true,
    protected_release: { manifest: f.manifest, release_id: digest(f.manifest), action: "apply", deployment_id: uuid(10) } }, async updateData() {} };
  await assert.rejects(runProtectedReleaseJob(job, { db, agentRow: f.row(), loadBackend: async () => f.backend,
    withProviderMutationLock: async (_, fn) => fn(), checkReadiness: async () => ({ ok: true }) }), /UID_CHANGED/);
  assert.equal(f.row().status, "running"); assert.equal(db.deployments.get(uuid(10)), "failed");
  assert.equal(db.deployments.get(uuid(11)), "completed"); assert.ok(!f.events.includes("stop:old"));
});

test("maintained recovery command rejects wrong external owner before enqueue or DB mutation", async t => {
  const f = await fixture(t); f.manifest.targets[0].account_id = uuid(9); let enqueued = 0;
  const db = database(f), deps = { db, readFile: async () => JSON.stringify(f.manifest), acquireLock: async () => ({ release: async () => {} }),
    loadBackend: async () => f.backend, enqueue: async () => { enqueued++; }, getJob: async () => null };
  await assert.rejects(command(["--manifest", "local.json", "--recover"], deps), /OWNER_CHANGED/);
  assert.equal(enqueued, 0); assert.ok(db.queries.every(x => x.sql.startsWith("SELECT")));
  assert.equal(f.events.length, 0);
});

test("real archive validation preserves PM links and rejects traversal, escaping/hard links and symlink parents", async () => {
  const dir = { name: "installs", type: "directory", mode: 0o755, content: Buffer.alloc(0) };
  const link = target => ({ name: "installs/python", type: "symlink", linkname: target, mode: 0o777, content: Buffer.alloc(0) });
  assert.equal((await readArchive(await packArchive([dir, link("/usr/local/bin/python3")]), "installs"))[1].linkname, "/usr/local/bin/python3");
  for (const rows of [[dir, link("/etc/passwd")], [dir, link("../../outside")], [dir, { ...dir, name: "../escape" }], [dir, link("/usr/bin/python3"), { ...dir, name: "installs/python/child" }], [dir, { ...link("state.db"), type: "link" }]]) {
    await assert.rejects(readArchive(await packArchive(rows), "installs"));
  }
});

test("repeated dry runs make no write, stop, create or queue mutation", async t => {
  const f = await fixture(t);
  assert.equal((await f.run({ dryRun: true })).phase, "dry_run");
  assert.equal((await f.run({ dryRun: true })).phase, "dry_run");
  assert.ok(f.events.every(x => x.startsWith("exec:"))); assert.equal(f.receipts.length, 0);
});

test("large real tar spools to private disk and repacks with bounded streaming memory", async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "protected-release-stream-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const tar = require("tar-stream"), { once } = require("node:events"), { Writable } = require("node:stream");
  const { pipeline } = require("node:stream/promises"), { packStream } = require("./protectedReleaseArchive");
  const input = tar.pack(), bytes = 64 * 1024 * 1024, block = Buffer.alloc(65536, 7);
  const baseline = process.memoryUsage().arrayBuffers; let peak = baseline;
  const producer = (async () => {
    await new Promise((resolve, reject) => input.entry({ name: "installs", type: "directory", mode: 0o755 }, e => e ? reject(e) : resolve()));
    const file = input.entry({ name: "installs/payload", size: bytes, type: "file", mode: 0o644 });
    for (let written = 0; written < bytes; written += block.length) { if (!file.write(block)) await once(file, "drain"); peak = Math.max(peak, process.memoryUsage().arrayBuffers); }
    file.end(); input.finalize();
  })();
  const rows = await readArchive(input, "installs", { spoolDirectory: folder, maxBytes: bytes + 1024 }); await producer;
  const file = rows.find(x => x.type === "file");
  assert.equal(file.bytes, bytes); assert.equal(file.content, undefined); assert.equal((await fs.stat(file.contentPath)).size, bytes);
  assert.ok(peak - baseline < 32 * 1024 * 1024, `stream buffered ${peak - baseline} bytes`);
  let consumed = 0;
  await pipeline(packStream(rows), new Writable({ write(chunk, encoding, done) { consumed += chunk.length; setImmediate(done); } }));
  assert.ok(consumed >= bytes);
});

test("another writable runtime blocks staging and leaves the neighbor unchanged", async t => {
  const f = await fixture(t), neighbor = await f.docker.createContainer({ name: "neighbor", Image: image(1), Labels: { "headmaster.release.maintenance": "synthetic-neighbor" }, HostConfig: {} });
  // An arbitrary active writer is refused before a stop or snapshot.
  const original = f.docker.listContainers;
  f.docker.listContainers = async options => options?.all ? original(options) : [{ Id: "old" }, { Id: "helper-1" }];
  const get = f.docker.getContainer;
  f.docker.getContainer = name => name === "helper-1" ? { inspect: async () => ({ Id: name, State: { Running: true }, Mounts: [{ Name: "owned-volume", RW: true }] }) } : get(name);
  await assert.rejects(f.run(), /ACTIVE_WRITER/); assert.ok(!f.events.includes("stop:old"));
});

test("real staged archives commit only LP state and retain explicit external metadata pending receipt", async t => {
  const f = await fixture(t); const result = await f.run();
  assert.equal(result.phase, "external_metadata_pending"); assert.equal(result.publication_blocked, true);
  assert.equal(result.lp_committed, true); assert.equal(result.external_metadata_confirmed, false);
  assert.equal(await fs.readFile(path.join(f.root, "state.db"), "utf8"), "new chat must survive");
  assert.ok(f.events.indexOf("stop:old") < f.events.indexOf("create:candidate"));
  await assert.rejects(f.run(), /RECOVERY_REQUIRED/);
});

for (const fault of ["health", "commit", "queue"]) test(`${fault} failure restores verified installs before old start and retains failed bytes`, async t => {
  const f = await fixture(t); f.faults[fault] = true; await assert.rejects(f.run(), /PROTECTED_RELEASE_FAILED/);
  assert.equal(await fs.readFile(path.join(f.root, "installs/gen/facts.json"), "utf8"), "good");
  assert.equal(await fs.readFile(path.join(f.root, "state.db"), "utf8"), "new chat must survive");
  const stage = `.protected-release-${digest(f.manifest)}`;
  assert.equal(await fs.readFile(path.join(f.root, stage, "failed-installs/gen/facts.json"), "utf8"), fault === "queue" ? "good" : "failed-attempt");
  if (fault === "queue") assert.ok(!f.events.includes("start:candidate"), "queue ACK loss is before candidate start");
  const restored = f.receipts.findIndex(r => r.phase === "restored"), rolled = f.receipts.findIndex(r => r.phase === "rolled_back");
  assert.ok(restored >= 0 && rolled > restored); assert.equal(f.events.at(-1), "start:old");
  assert.equal(f.row().image, "old-tag");
});

test("extraction failure never renames the old runtime and resumes it without touching chats", async t => {
  const f = await fixture(t); f.faults.stage = true; await assert.rejects(f.run());
  assert.ok(!f.events.includes("rename:old")); assert.equal(f.events.at(-1), "start:old");
  assert.deepEqual(await fs.readdir(path.join(f.root, ".worker-tmp")), []);
});

test("wrong owner, uid, env or binding fails before stop", async t => {
  for (const change of [f => { f.manifest.targets[0].account_id = uuid(9); }, f => { f.faults.uid = true; }, f => { f.manifest.targets[0].env_sha256 = "f".repeat(64); }, f => { f.manifest.targets[0].image_binding = "drifted"; }]) {
    const f = await fixture(t); change(f); await assert.rejects(f.run()); assert.ok(!f.events.includes("stop:old"));
  }
});

test("candidate UID and contract bytes are verified before its first start", async t => {
  for (const change of [f => { f.faults.candidateUid = true; }, f => { f.manifest.image.contract_sha256 = "0".repeat(64); }]) {
    const f = await fixture(t); change(f); await assert.rejects(f.run(), /PROTECTED_RELEASE_FAILED/);
    assert.ok(!f.events.includes("start:candidate")); assert.equal(f.events.at(-1), "start:old");
  }
});

test("failed restore leaves the old runtime stopped and a durable recovery-required receipt", async t => {
  const f = await fixture(t); f.faults.health = true; f.faults.restore = true;
  await assert.rejects(f.run(), /RECOVERY_REQUIRED/); assert.ok(!f.events.includes("start:old"));
  assert.equal(f.receipts.at(-1).phase, "recovery_required");
});

test("maintained command validates dry run and enqueues one explicit protected job through existing producer", async t => {
  const f = await fixture(t); const row = f.row(); row.status = "running";
  const { buildReplacementDeploymentJob } = require("../../backend-api/agentProvisionLock");
  let queued;
  const deps = { readFile: async () => JSON.stringify(f.manifest), db: { query: async () => ({ rows: [row] }) }, acquireLock: async () => ({ release: async () => {} }),
    loadBackend: async () => f.backend, buildReplacementDeploymentJob,
    enqueue: async (agent, data, options) => { queued = data; return options.addDeploymentJob(data); }, addJob: async () => ({ id: "existing-queue-job" }), cancelJobs: async () => ({ active: 0 }) };
  assert.equal((await command(["--manifest", "local.json", "--dry-run"], deps)).phase, "dry_run");
  assert.equal((await command(["--manifest", "local.json", "--enqueue"], deps)).phase, "queued");
  assert.equal(queued.replace_existing_runtime, true); assert.equal(queued.protected_release.release_id, digest(f.manifest));
  assert.equal(queued.previous_container_id, "old");
});

for (const boundary of ["stop", "stage", "create", "restore", "restoreName", "oldStart"]) test(`actual worker process death after ${boundary} resumes from durable archives without another runtime`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "protected-release-death-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, ["--import", require("node:url").pathToFileURL(require.resolve("tsx")).href, path.join(__dirname, "protectedReleaseDeath.fixture.js"), root, boundary], {
    windowsHide: true, env: { ...process.env, PROTECTED_RELEASE_FIXTURE_ONLY: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; child.stderr.on("data", x => { output += x; });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  assert.equal(code, ({ create: 23, restore: 24, stop: 25, stage: 26, restoreName: 27, oldStart: 28 })[boundary], output);
  const f = await fixture(t, { root, resume: true });
  assert.equal((await f.run({ action: "recover" })).phase, "rolled_back");
  assert.equal(f.events.filter(x => x === "create:candidate").length, ["stop", "stage"].includes(boundary) ? 0 : 1);
  assert.equal(await fs.readFile(path.join(root, "installs/gen/facts.json"), "utf8"), "good");
  assert.equal(await fs.readFile(path.join(root, "state.db"), "utf8"), "new chat must survive");
  assert.equal((await f.run({ action: "recover" })).phase, "rolled_back");
  assert.deepEqual(await fs.readdir(path.join(root, ".worker-tmp")), []);
});
}
