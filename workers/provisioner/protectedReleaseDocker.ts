// @ts-nocheck
const { readArchive, packStream, inventory, archiveRoot, MAX_BYTES } = require("./protectedReleaseArchive");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { envFingerprint, expectedCandidateEnv, digest, refuse } = require("./protectedReleaseManifest");
const { demuxDockerExecStream } = require("./backends/dockerExecStream");
const { createHash } = require("crypto");
const ROOT = "/opt/data";
const CONFIG_BYTES = 16 * 1024 * 1024;
const INSTALLS_GC_THRESHOLD_BYTES = 1024 ** 3;
const INSTALLS_GC_TIMEOUT_MS = 10 * 60_000;
// Existing retained-image Python, not a worker dependency. No shell or caller-supplied program text.
const MOVE_AND_SYNC = "import os,sys\nsrc,dst=sys.argv[1:]\nos.rename(src,dst)\nfor parent in sorted({os.path.dirname(src),os.path.dirname(dst)}):\n fd=os.open(parent,os.O_RDONLY|os.O_DIRECTORY)\n try: os.fsync(fd)\n finally: os.close(fd)";
const PUBLISH_RECEIPT = [
  "import hashlib,json,os,re,signal,stat,sys",
  "signal.alarm(60)",
  "stage,expected,release_id,create_allowed=sys.argv[1:]",
  "assert re.fullmatch(r'[0-9a-f]{64}',release_id) and re.fullmatch(r'[0-9a-f]{64}',expected)",
  "name=os.path.basename(stage)",
  "assert name=='.protected-release-'+release_id and create_allowed in ('0','1')",
  "data=sys.stdin.buffer.read(65537)",
  "assert 0<len(data)<=65536 and hashlib.sha256(data).hexdigest()==expected and json.loads(data)['release_id']==release_id",
  "parent=os.open(os.path.dirname(stage),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)",
  "try:",
  " try: directory=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)",
  " except FileNotFoundError:",
  "  assert create_allowed=='1'",
  "  os.mkdir(name,0o700,dir_fd=parent)",
  "  directory=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)",
  "except BaseException:",
  " os.close(parent)",
  " raise",
  "try:",
  " identity=os.fstat(directory)",
  " assert identity.st_uid==0 and identity.st_gid==0 and stat.S_IMODE(identity.st_mode)==0o700",
  " try: previous=os.open('receipt.json',os.O_RDONLY|os.O_NOFOLLOW,dir_fd=directory)",
  " except FileNotFoundError: assert create_allowed=='1'",
  " else:",
  "  try:",
  "   meta=os.fstat(previous)",
  "   assert stat.S_ISREG(meta.st_mode) and meta.st_uid==0 and meta.st_gid==0 and stat.S_IMODE(meta.st_mode)==0o600 and 0<meta.st_size<=65536",
  "   with os.fdopen(os.dup(previous),'rb') as stream: old=stream.read(65537)",
  "   assert len(old)==meta.st_size and json.loads(old)['release_id']==release_id",
  "  finally: os.close(previous)",
  " temporary='.receipt-'+expected+'.json'",
  " try: meta=os.stat(temporary,dir_fd=directory,follow_symlinks=False)",
  " except FileNotFoundError: pass",
  " else:",
  "  assert stat.S_ISREG(meta.st_mode) and meta.st_uid==0 and meta.st_gid==0 and stat.S_IMODE(meta.st_mode)==0o600",
  "  os.unlink(temporary,dir_fd=directory)",
  " fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=directory)",
  " try:",
  "  os.fchmod(fd,0o600)",
  "  remaining=memoryview(data)",
  "  while remaining: remaining=remaining[os.write(fd,remaining):]",
  "  os.fsync(fd)",
  " finally: os.close(fd)",
  " os.replace(temporary,'receipt.json',src_dir_fd=directory,dst_dir_fd=directory)",
  " for pending in os.listdir(directory):",
  "  if re.fullmatch(r'\\.receipt-[0-9a-f]{64}\\.json',pending):",
  "   meta=os.stat(pending,dir_fd=directory,follow_symlinks=False)",
  "   if stat.S_ISREG(meta.st_mode) and meta.st_uid==0 and meta.st_gid==0 and stat.S_IMODE(meta.st_mode)==0o600: os.unlink(pending,dir_fd=directory)",
  " os.fsync(directory)",
  " os.fsync(parent)",
  " named=os.stat(name,dir_fd=parent,follow_symlinks=False)",
  " assert stat.S_ISDIR(named.st_mode) and (named.st_dev,named.st_ino)==(identity.st_dev,identity.st_ino)",
  "finally:",
  " os.close(directory)",
  " os.close(parent)",
].join("\n");
// Docker reports unset HostConfig fields differently by daemon version and by when a container
// was created (a 29.x create says OomKillDisable false where an older one says null), so an unset
// value and its zero value compare equal. Any field actually set still has to match exactly.
const unsetValue = v => v === null || v === undefined || v === false || v === 0 || v === ""
  || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
const hostIdentity = hostConfig => Object.fromEntries(Object.entries(hostConfig || {}).filter(([, v]) => !unsetValue(v)));
const networkIdentity = c => Object.fromEntries(Object.entries(c.NetworkSettings.Networks || {}).map(([name, v]) => [name, {
  ipam: v.IPAMConfig || null, aliases: (v.Aliases || []).filter(x => x !== c.Id && x !== c.Id.slice(0, 12)).sort(),
}]));

async function boundedDockerCall(run, timeoutMs, parentSignal = null) {
  const controller = new AbortController(); let timer;
  parentSignal?.throwIfAborted();
  const abort = () => controller.abort(parentSignal.reason || refuse("PROTECTED_RELEASE_CANCELLED"));
  parentSignal?.addEventListener("abort", abort, { once: true });
  try {
    const result = await Promise.race([Promise.resolve().then(() => { controller.signal.throwIfAborted(); return run(controller.signal); }), new Promise((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      timer = setTimeout(() => controller.abort(refuse("PROTECTED_RELEASE_DOCKER_TIMEOUT")), timeoutMs);
    })]);
    controller.signal.throwIfAborted(); return result;
  } finally { clearTimeout(timer); parentSignal?.removeEventListener("abort", abort); }
}

class ProtectedReleaseDocker {
  constructor(backend, { checkReadiness, stagingRoot = os.tmpdir(), probeTimeoutMs = 60000, archiveTimeoutMs = 900000, signal = null, assertActive = () => {} } = {}) { this.backend = backend; this.docker = backend.docker; this.checkReadiness = checkReadiness; this.stagingRoot = stagingRoot; this.probeTimeoutMs = probeTimeoutMs; this.archiveTimeoutMs = archiveTimeoutMs; this.signal = signal; this.assertActive = assertActive; }
  guard() { this.signal?.throwIfAborted(); this.assertActive(); }
  async call(run, timeoutMs = this.probeTimeoutMs) { this.guard(); const result = await boundedDockerCall(run, timeoutMs, this.signal); this.guard(); return result; }
  async inspect(container) { const c = typeof container === "string" ? this.docker.getContainer(container) : container; return this.call(signal => c.inspect({ abortSignal: signal })); }
  async list(options = {}) { return this.call(signal => this.docker.listContainers({ ...options, abortSignal: signal })); }
  async inspectImage(reference) { return this.call(signal => new Promise((resolve, reject) => this.docker.modem.dial({ path: `/images/${encodeURIComponent(reference)}/json`, method: "GET", abortSignal: signal, statusCodes: { 200: true, 404: "no such image", 500: "server error" } }, (error, value) => error ? reject(error) : resolve(value)))); }
  async read(container, file, root, options = {}) {
    return this.call(async signal => {
      let stream;
      try { stream = await container.getArchive({ path: file, abortSignal: signal }); signal.throwIfAborted(); return await readArchive(stream, root, { ...options, signal }); }
      finally { stream?.destroy(); }
    }, this.archiveTimeoutMs);
  }
  async exists(container, file) { return this.call(async signal => { const stream = await container.getArchive({ path: file, abortSignal: signal }); stream.on("error", () => {}); stream.destroy(); signal.throwIfAborted(); return true; }); }
  async upload(container, entries, options) {
    return this.call(async signal => { const stream = packStream(entries, { ...options, signal }); stream.on("error", () => {});
      try { await container.putArchive(stream, { path: ROOT, abortSignal: signal }); signal.throwIfAborted(); }
      finally { stream.destroy(); }
    }, this.archiveTimeoutMs);
  }
  async ownership(container) { const entries = await this.read(container, "/etc/passwd", "passwd", { maxBytes: 1024 * 1024 }); const fields = entries[0].content.toString().split("\n").find(line => line.startsWith("hermes:"))?.split(":"); const uid = Number(fields?.[2]), gid = Number(fields?.[3]); if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw refuse("PROTECTED_RELEASE_UID_CHANGED"); return { uid, gid }; }
  async optionalInspect(name) { try { return await this.inspect(name); } catch (e) { if (e.statusCode === 404) return null; throw e; } }
  async retained(t, n) { const row = await this.optionalInspect(n.old); if (row && (row.Id !== t.container_id || row.Name !== `/${n.old}` || row.Image !== t.image_id || row.State.Running)) throw refuse("PROTECTED_RELEASE_RETAINED_CHANGED"); return row; }
  async candidate(t, releaseId) {
    const rows = await this.list({ all: true, filters: JSON.stringify({ label: [`headmaster.release.id=${releaseId}`, `nora.agent.id=${t.agent_id}`] }) });
    if (rows.length > 1) throw refuse("PROTECTED_RELEASE_CANDIDATE_AMBIGUOUS");
    return rows.length ? this.inspect(rows[0].Id) : null;
  }
  async observe(t, candidate = null) {
    const old = await this.inspect(t.container_id);
    if (old.Id !== t.container_id || old.Image !== t.image_id || old.Config.Labels?.["nora.agent.id"] !== t.agent_id
        || envFingerprint(old.Config.Env) !== t.env_sha256
        || !old.Mounts.some(x => x.Name === t.volume && x.Destination === ROOT && x.Type === "volume" && x.RW)) throw refuse("PROTECTED_RELEASE_RUNTIME_CHANGED");
    const project = c => ({ container_id: c.Id, container_name: c.Name.replace(/^\//, ""), image_id: c.Image, running: c.State.Running });
    return { retained: project(old), candidate: candidate ? project(candidate) : null };
  }
  // Enough to know a container is this release's own candidate, so recovery can stop and set it
  // aside even when the full check below is exactly what refused it.
  async verifyCandidateIdentity(c, m, id) {
    const t = m.targets[0];
    if (c.Image !== m.image.id || c.Config.Labels?.["headmaster.release.id"] !== id
        || c.Config.Labels?.["nora.agent.id"] !== t.agent_id || c.Config.Labels?.["headmaster.release.owner"] !== t.owner_id) throw refuse("PROTECTED_RELEASE_CANDIDATE_CHANGED");
  }
  async verifyCandidate(c, m, id) {
    await this.verifyImageBinding(m);
    const t = m.targets[0];
    const old = await this.inspect(t.container_id);
    const image = await this.inspectImage(m.image.id);
    const expected = expectedCandidateEnv(old.Config.Env, image.Config.Env, m.env_delta.set);
    if (c.Image !== m.image.id || c.Config.Labels?.["headmaster.release.id"] !== id
        || c.Config.Labels?.["nora.agent.id"] !== t.agent_id || c.Config.Labels?.["headmaster.release.owner"] !== t.owner_id
        || !c.Mounts.some(x => x.Name === t.volume && x.Destination === ROOT && x.RW)
        || envFingerprint(c.Config.Env) !== envFingerprint(expected)
        || digest(hostIdentity(c.HostConfig)) !== digest(hostIdentity(old.HostConfig))
        || digest(c.Mounts) !== digest(old.Mounts)
        || digest(networkIdentity(c)) !== digest(networkIdentity(old))
        || ["Entrypoint", "Cmd", "User", "WorkingDir"].some(key => digest(c.Config[key] ?? null) !== digest(old.Config[key] ?? null))) throw refuse("PROTECTED_RELEASE_CANDIDATE_CHANGED");
  }
  async exec(container, cmd, user = "10000:10000", timeoutMs = this.probeTimeoutMs) {
    return this.call(async signal => {
      let raw, stream; const abort = () => { stream?.destroy(signal.reason); raw?.destroy(); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        const exec = await container.exec({ Cmd: cmd, User: user, AttachStdout: true, AttachStderr: true, abortSignal: signal }); signal.throwIfAborted();
        raw = await exec.start({ hijack: true, stdin: false, abortSignal: signal }); signal.throwIfAborted();
        stream = demuxDockerExecStream(this.docker, raw); const chunks = []; let bytes = 0;
        for await (const chunk of stream) { signal.throwIfAborted(); bytes += chunk.length; if (bytes > 65536) throw refuse("PROTECTED_RELEASE_PROBE_FAILED"); chunks.push(chunk); }
        signal.throwIfAborted(); if ((await exec.inspect({ abortSignal: signal })).ExitCode !== 0) throw refuse("PROTECTED_RELEASE_PROBE_FAILED");
        signal.throwIfAborted(); return Buffer.concat(chunks).toString("utf8").trim();
      } finally { signal.removeEventListener("abort", abort); stream?.destroy(); raw?.destroy(); }
    }, timeoutMs);
  }
  /**
   * Staging copies the whole installs store and refuses past MAX_BYTES, so a bot whose store
   * grew with unreferenced installs would stop a fleet rollout (24 Oct, 2ec3b822). Run the
   * runtime's own collector as the bot user first. It removes only entries nothing references,
   * so it is safe on a running bot and on a dry run. A collector failure is not a release
   * failure: the capacity check that follows still decides.
   */
  async measureInstalls(t) {
    const usage = await this.exec(this.docker.getContainer(t.container_id), ["du", "-sk", "/opt/data/installs"]);
    return Number(usage.split(/\s/)[0]) * 1024;
  }
  async collectInstalls(t, bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < INSTALLS_GC_THRESHOLD_BYTES) return bytes;
    try { await this.exec(this.docker.getContainer(t.container_id), ["/opt/hermes/.venv/bin/hermes", "pm", "gc"], "10000:10000", INSTALLS_GC_TIMEOUT_MS); }
    catch { this.guard(); return bytes; }
    return this.measureInstalls(t);
  }
  async preflight(m, row, { dryRun }) {
    await this.verifyImageBinding(m);
    const t = m.targets[0], old = await this.inspect(t.container_id);
    const image = await this.inspectImage(m.image.id); // locally present exact ID only, never pull
    if (image.Id !== m.image.id || old.Id !== t.container_id || old.Image !== t.image_id || old.Name !== `/${t.container_name}`
        || old.Config.Labels?.["nora.agent.id"] !== t.agent_id || envFingerprint(old.Config.Env) !== t.env_sha256
        || image.Config.Labels?.["org.opencontainers.image.revision"] !== m.sources.core
        || image.Config.Labels?.["com.gcaplabs.webapp.revision"] !== m.sources.webapp
        || !old.Mounts.some(x => x.Name === t.volume && x.Destination === ROOT && x.Type === "volume" && x.RW)) throw refuse("PROTECTED_RELEASE_RUNTIME_CHANGED");
    const env = Object.fromEntries(old.Config.Env.map(x => { const p = x.indexOf("="); return [x.slice(0, p), x.slice(p + 1)]; }));
    if (env.HEADMASTER_OWNER_ID !== t.account_id || env.HEADMASTER_WORKSPACE_ID !== t.workspace_id) throw refuse("PROTECTED_RELEASE_OWNER_CHANGED");
    if (!old.State.Running) throw refuse("PROTECTED_RELEASE_RUNNING_REQUIRED");
    const user = await this.ownership(this.docker.getContainer(t.container_id));
    if (user.uid !== 10000 || user.gid !== 10000) throw refuse("PROTECTED_RELEASE_UID_CHANGED");
    const bytes = await this.collectInstalls(t, await this.measureInstalls(t));
    const disk = await fs.statfs(this.stagingRoot);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_BYTES - 2 * CONFIG_BYTES || disk.bavail * disk.bsize < bytes * 2 + 1024 ** 3) throw refuse("PROTECTED_RELEASE_STAGING_CAPACITY");
    // Application commands run as the bot user; archive work itself uses Node/tar-stream.
    await this.exec(this.docker.getContainer(t.container_id), ["/opt/hermes/.venv/bin/python", "-c", "from gateway.drain_control import write_drain_request; print('ready')"]);
    await this.assertNoWriters(t.volume, t.container_id);
  }
  // Binding strings are metadata references. Docker's Id is a distinct local
  // config/content identity; no pull or published-registry claim is made here.
  // Uses the abort/deadline/lock-loss guarded inspectImage path.
  async verifyImageBinding(m) {
    const image = await this.inspectImage(m.image.binding);
    if (image.Id !== m.image.id || (m.image.binding.includes("@sha256:") && !(image.RepoDigests || []).includes(m.image.binding))) throw refuse("PROTECTED_RELEASE_IMAGE_BINDING_CHANGED");
    return { binding: m.image.binding, local_image_id: image.Id, kind: m.image.binding.includes("@sha256:") ? "local_repo_digest" : "local_reference" };
  }
  async drain(t) {
    await this.exec(this.docker.getContainer(t.container_id), ["/opt/hermes/.venv/bin/python", "-c", "from gateway.drain_control import write_drain_request; write_drain_request(principal='protected-runtime-release', suppress_notification=True)"]);
  }
  async stop(id) { const c = this.docker.getContainer(id); if ((await this.inspect(c)).State.Running) await this.call(signal => c.stop({ t: 60, abortSignal: signal })); }
  async start(id) { const c = this.docker.getContainer(id); if (!(await this.inspect(c)).State.Running) await this.call(signal => c.start({ abortSignal: signal })); }
  async assertNoWriters(volume, permitted = null) {
    for (const row of await this.list()) {
      if (row.Id === permitted) continue;
      const info = await this.inspect(row.Id);
      if (info.State.Running && info.Mounts.some(m => m.Name === volume && m.RW)) throw refuse("PROTECTED_RELEASE_ACTIVE_WRITER");
    }
  }
  async old(t, n) { return this.docker.getContainer((await this.optionalInspect(n.old)) ? n.old : t.container_id); }
  async writeReceipt(t, n, value) {
    const text = Buffer.from(JSON.stringify(value));
    if (!text.length || text.length > 65536) throw refuse("PROTECTED_RELEASE_RECEIPT_INVALID");
    const observed = await this.observe(t);
    await this.assertNoMaintenance(n);
    const releaseId = n.stage.replace(/^\.protected-release-/, ""), hash = createHash("sha256").update(text).digest("hex");
    const createAllowed = !observed.retained.running && !(await this.candidate(t, releaseId));
    if (createAllowed) await this.assertNoWriters(t.volume);
    await this.maintenance(t, n, "receipt", [`${ROOT}/${n.stage}`, hash, releaseId, createAllowed ? "1" : "0"], text);
  }
  async readReceipt(t, n) {
    try {
      await this.checkStageRoot(t, n);
      const rows = await this.read(await this.old(t, n), `${ROOT}/${n.stage}/receipt.json`, "receipt.json", { maxBytes: 65536 });
      if (rows[0].uid !== 0 || rows[0].gid !== 0 || rows[0].mode !== 0o600) throw refuse("PROTECTED_RELEASE_RECEIPT_INVALID");
      const receipt = JSON.parse(rows[0].content.toString());
      if (receipt.release_id !== n.stage.replace(/^\.protected-release-/, "")) throw refuse("PROTECTED_RELEASE_RECEIPT_MISMATCH");
      return receipt;
    }
    catch (e) { if (e.statusCode === 404) return null; throw e; }
  }
  async checkStageRoot(t, n) {
    const container = await this.old(t, n);
    const header = await this.call(async signal => { let stream; const abort = () => stream?.destroy(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      try { stream = await container.getArchive({ path: `${ROOT}/${n.stage}`, abortSignal: signal }); signal.throwIfAborted(); return await archiveRoot(stream); }
      finally { signal.removeEventListener("abort", abort); stream?.destroy(); }
    });
    if (header.name.replace(/\/$/, "") !== n.stage || header.type !== "directory" || header.uid !== 0 || header.gid !== 0 || (header.mode & 0o7777) !== 0o700) throw refuse("PROTECTED_RELEASE_STAGE_OWNER_CHANGED");
  }
  async stage(t, n, image) {
    const c = await this.old(t, n), items = [];
    try { await this.exists(c, `${ROOT}/${n.stage}/before`); throw refuse("PROTECTED_RELEASE_STAGE_EXISTS"); }
    catch (e) { if (e.statusCode !== 404) throw e; }
    const spoolRoot = this.localStage(n);
    await fs.mkdir(spoolRoot, { mode: 0o700 });
    try { for (const root of ["installs", "config.yaml", ".env"]) {
      try {
        const spoolDirectory = path.join(spoolRoot, root); await fs.mkdir(spoolDirectory, { mode: 0o700 });
        items.push(...await this.read(c, `${ROOT}/${root}`, root, { maxBytes: root === "installs" ? MAX_BYTES - 2 * CONFIG_BYTES : CONFIG_BYTES, spoolDirectory }));
      }
      catch (e) { if (root === "installs" || e.statusCode !== 404) throw e; }
    }
    const result = { inventory_sha256: digest(inventory(items)), inventories: Object.fromEntries(["installs", "config.yaml", ".env"].map(root => [root, digest(inventory(items.filter(x => x.name === root || x.name.startsWith(root + "/"))))])), roots: [...new Set(items.map(x => x.name.split("/")[0]))] };
    await this.upload(c, items, { prefix: `${n.stage}/before`, uid: image.uid, gid: image.gid });
    // Verify the actual staged archive before a candidate can start.
    await this.verifyStage(t, n, result);
    return result;
    } finally { await this.cleanupStaging(n); }
  }
  localStage(n) {
    if (!/^\.protected-release-[0-9a-f]{64}$/.test(n.stage)) throw refuse("PROTECTED_RELEASE_STAGE_INVALID");
    const base = path.resolve(this.stagingRoot), result = path.resolve(base, n.stage);
    if (path.dirname(result) !== base) throw refuse("PROTECTED_RELEASE_STAGE_INVALID");
    return result;
  }
  async cleanupStaging(n) {
    const local = this.localStage(n);
    const stat = await fs.lstat(local).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw refuse("PROTECTED_RELEASE_STAGE_INVALID");
    await fs.rm(local, { recursive: true, force: false });
  }
  async verifyStage(t, n, expected) {
    await this.checkStageRoot(t, n);
    const c = await this.old(t, n), items = [];
    for (const root of expected.roots) items.push(...await this.read(c, `${ROOT}/${n.stage}/before/${root}`, root, { maxBytes: MAX_BYTES, hashOnly: true }));
    if (items.some(x => x.uid !== 10000 || x.gid !== 10000) || digest(inventory(items)) !== expected.inventory_sha256) throw refuse("PROTECTED_RELEASE_STAGE_CHANGED");
  }
  async renameOld(t, n) { await this.call(signal => this.docker.getContainer(t.container_id).rename({ name: n.old, abortSignal: signal })); }
  async create(m, n, id) {
    const t = m.targets[0], old = await this.inspect(n.old);
    const cfg = { ...old.Config, Image: m.image.id, name: t.container_name, HostConfig: { ...old.HostConfig },
      Labels: { ...old.Config.Labels, "headmaster.release.id": id, "headmaster.release.owner": t.owner_id } };
    const env = new Map(cfg.Env.map(item => { const p = item.indexOf("="); return [item.slice(0, p), item.slice(p + 1)]; }));
    for (const [key, value] of Object.entries(m.env_delta.set)) env.set(key, value);
    cfg.Env = [...env].map(([key, value]) => `${key}=${value}`);
    cfg.NetworkingConfig = { EndpointsConfig: Object.fromEntries(Object.entries(old.NetworkSettings.Networks || {}).map(([name, v]) => [name, {
      ...(v.IPAMConfig ? { IPAMConfig: v.IPAMConfig } : {}), Aliases: (v.Aliases || []).filter(x => x !== old.Id.slice(0, 12)),
    }])) };
    const result = await this.call(signal => this.docker.createContainer({ ...cfg, abortSignal: signal })); return this.inspect(result);
  }
  async checkImage(m, id) {
    const info = await this.inspect(id); await this.verifyCandidate(info, m, digest(m));
    const user = await this.ownership(this.docker.getContainer(id));
    if (user.uid !== 10000 || user.gid !== 10000) throw refuse("PROTECTED_RELEASE_UID_CHANGED");
    for (const [file, expected] of [["headmaster/contract/desktop-contract.json", m.image.contract_sha256], ["uv.lock", m.image.dependency_sha256]]) {
      const root = file.split("/").at(-1);
      const entries = await this.read(this.docker.getContainer(id), `/opt/hermes/${file}`, root);
      if (createHash("sha256").update(entries[0].content).digest("hex") !== expected) throw refuse("PROTECTED_RELEASE_IMAGE_CONTENT_CHANGED");
    }
  }
  async check(m, id) {
    await this.checkImage(m, id);
    const info = await this.inspect(id);
    const result = await this.call(signal => this.checkReadiness(info, signal));
    if (!result?.ok) throw refuse("PROTECTED_RELEASE_UNHEALTHY");
  }
  async move(t, n, source, destination) {
    await this.assertNoWriters(t.volume);
    try { await this.exists(await this.old(t, n), destination); throw refuse("PROTECTED_RELEASE_RESTORE_DESTINATION_EXISTS"); }
    catch (e) { if (e.statusCode !== 404) throw e; }
    const roots = ["installs", "config.yaml", ".env"];
    if (!roots.some(root => (source === `${ROOT}/${root}` && destination === `${ROOT}/${n.stage}/failed-${root}`)
        || (source === `${ROOT}/${n.stage}/before/${root}` && destination === `${ROOT}/${root}`))) throw refuse("PROTECTED_RELEASE_MOVE_INVALID");
    await this.maintenance(t, n, "move", [source, destination]);
  }
  async assertNoMaintenance(n) {
    for (const c of await this.list()) {
      const info = await this.inspect(c.Id);
      if (info.State.Running && info.Config.Labels?.["headmaster.release.maintenance"] === n.stage) throw refuse("PROTECTED_RELEASE_ACTIVE_MAINTENANCE");
    }
  }
  async maintenance(t, n, kind, args, input = null) {
    if (!["move", "receipt"].includes(kind)) throw refuse("PROTECTED_RELEASE_MAINTENANCE_INVALID");
    await this.assertNoMaintenance(n);
    // dockerode 5 Image.inspect omits abortSignal; use its same modem/endpoint with cancellation.
    const image = await this.inspectImage(t.image_id);
    if (image.Id !== t.image_id) throw refuse("PROTECTED_RELEASE_RETAINED_CHANGED");
    // Docker merges image ENV defaults. Override every inherited key, including loader hooks.
    const environment = new Map();
    for (const item of image.Config.Env || []) {
      const key = item.slice(0, item.indexOf("="));
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw refuse("PROTECTED_RELEASE_IMAGE_ENV_INVALID");
      environment.set(key, "");
    }
    for (const key of ["LD_PRELOAD", "LD_LIBRARY_PATH", "PYTHONPATH", "PYTHONHOME"]) environment.set(key, "");
    for (const [key, value] of Object.entries({ HOME: "/", PATH: "/usr/bin:/bin", LANG: "C.UTF-8", PYTHONNOUSERSITE: "1" })) environment.set(key, value);
    const env = [...environment].map(([key, value]) => `${key}=${value}`);
    const argv = ["-I", "-S", "-c", kind === "move" ? MOVE_AND_SYNC : PUBLISH_RECEIPT, ...args];
    // A stopped container cannot exec. Image/bot startup hooks and writable Python search paths are ignored.
    const helper = await this.call(signal => this.docker.createContainer({ abortSignal: signal, Image: t.image_id, User: "0:0", Entrypoint: ["/opt/hermes/.venv/bin/python"],
      Cmd: argv, Env: env, WorkingDir: "/", Healthcheck: { Test: ["NONE"] }, Tty: false,
      OpenStdin: kind === "receipt", AttachStdin: kind === "receipt", StdinOnce: kind === "receipt",
      NetworkDisabled: true, Labels: { "headmaster.release.maintenance": n.stage, "headmaster.release.maintenance.kind": kind },
      HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"], CapAdd: ["DAC_OVERRIDE", "FOWNER"], SecurityOpt: ["no-new-privileges:true"],
        Binds: [`${t.volume}:${ROOT}`], RestartPolicy: { Name: "no" } } }));
    const inspected = await this.inspect(helper);
    if (inspected.Image !== t.image_id || inspected.Config.User !== "0:0" || inspected.Config.WorkingDir !== "/"
        || envFingerprint(inspected.Config.Env) !== envFingerprint(env) || digest(inspected.Config.Cmd) !== digest(argv)
        || digest(inspected.Config.Entrypoint) !== digest(["/opt/hermes/.venv/bin/python"])
        || digest(inspected.Config.Healthcheck?.Test) !== digest(["NONE"])
        || inspected.Mounts.length !== 1 || !inspected.Mounts.some(x => x.Name === t.volume && x.Destination === ROOT && x.Type === "volume" && x.RW)) throw refuse("PROTECTED_RELEASE_MAINTENANCE_CHANGED");
    const attached = kind === "receipt" ? await this.call(signal => helper.attach({ stream: true, stdin: true, stdout: false, stderr: false, hijack: true, abortSignal: signal })) : null;
    if (attached) attached.on("error", () => {}); // wait/inspect determines success; no raw output or credentials
    let result;
    try {
      await this.call(signal => helper.start({ abortSignal: signal }));
      if (attached) attached.end(input);
      result = await this.call(signal => helper.wait({ abortSignal: signal }));
    } catch (error) {
      await boundedDockerCall(signal => helper.stop({ t: 5, abortSignal: signal }), Math.min(5000, this.probeTimeoutMs)).catch(() => {});
      throw error;
    } finally { attached?.destroy(); }
    if (result.StatusCode !== 0) throw refuse("PROTECTED_RELEASE_RESTORE_FAILED");
    // Retain maintenance containers too; cleanup is an independent owner action.
  }
  async restore(t, n, staged) {
    await this.checkStageRoot(t, n);
    const c = await this.old(t, n);
    for (const root of ["installs", "config.yaml", ".env"]) {
      let source;
      if (staged.roots.includes(root)) {
        try { source = await this.read(c, `${ROOT}/${n.stage}/before/${root}`, root, { maxBytes: MAX_BYTES, hashOnly: true }); }
        catch (e) {
          if (e.statusCode !== 404) throw e;
          const current = await this.read(c, `${ROOT}/${root}`, root, { maxBytes: MAX_BYTES, hashOnly: true });
          if (digest(inventory(current)) !== staged.inventories[root] || current.some(x => x.uid !== 10000 || x.gid !== 10000)) throw refuse("PROTECTED_RELEASE_RESTORE_FAILED");
          continue; // Prior restore moved this exact verified root before losing its ACK.
        }
        if (digest(inventory(source)) !== staged.inventories[root] || source.some(x => x.uid !== 10000 || x.gid !== 10000)) throw refuse("PROTECTED_RELEASE_STAGE_CHANGED");
      }
      try { await this.exists(c, `${ROOT}/${root}`); await this.move(t, n, `${ROOT}/${root}`, `${ROOT}/${n.stage}/failed-${root}`); }
      catch (e) { if (e.statusCode !== 404) throw e; }
      if (staged.roots.includes(root)) await this.move(t, n, `${ROOT}/${n.stage}/before/${root}`, `${ROOT}/${root}`);
    }
    const restored = [];
    for (const root of staged.roots) restored.push(...await this.read(c, `${ROOT}/${root}`, root, { maxBytes: MAX_BYTES, hashOnly: true }));
    if (digest(inventory(restored)) !== staged.inventory_sha256) throw refuse("PROTECTED_RELEASE_RESTORE_FAILED");
  }
  async retainFailed(id, n) { const c = this.docker.getContainer(id); if ((await this.inspect(c)).Name !== `/${n.old}-failed`) await this.call(signal => c.rename({ name: `${n.old}-failed`, abortSignal: signal })); }
  async restoreName(t, n) { const old = await this.optionalInspect(n.old); if (old) await this.call(signal => this.docker.getContainer(n.old).rename({ name: t.container_name, abortSignal: signal })); }
}
module.exports = { ProtectedReleaseDocker, maintenancePrograms: Object.freeze({ move: MOVE_AND_SYNC, receipt: PUBLISH_RECEIPT }) };
