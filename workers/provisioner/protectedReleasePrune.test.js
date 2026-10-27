const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PROGRAM = path.join(__dirname, "protectedReleasePrune.py");
const id = n => String(n).padStart(64, "0");
const stageName = n => `.protected-release-${id(n)}`;

async function volume(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prune-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "installs/live"), { recursive: true });
  await fs.writeFile(path.join(root, "installs/live/keep.bin"), "live install");
  await fs.writeFile(path.join(root, "state.db"), "chats");
  return root;
}

// age orders the stages: a higher number is a newer receipt.
async function stage(root, n, phase, age, entries = ["before"]) {
  const dir = path.join(root, stageName(n));
  await fs.mkdir(dir);
  for (const entry of entries) {
    await fs.mkdir(path.join(dir, entry, "installs/gen"), { recursive: true });
    await fs.writeFile(path.join(dir, entry, "installs/gen/blob"), "x".repeat(1000));
  }
  if (phase) await fs.writeFile(path.join(dir, "receipt.json"), JSON.stringify({ release_id: id(n), phase }));
  const when = new Date(Date.UTC(2026, 9, 1 + age));
  await fs.utimes(path.join(dir, "receipt.json"), when, when).catch(() => {});
  return dir;
}

const exists = p => fs.stat(p).then(() => true, () => false);

function prune(root, { current = "-", keep = 2, apply = false, owner = process.getuid() } = {}) {
  const run = spawnSync("python3", ["-I", "-S", "-", root, current, String(keep), String(owner), apply ? "1" : "0"], {
    input: require("node:fs").readFileSync(PROGRAM), encoding: "utf8" });
  return { status: run.status, stderr: run.stderr, report: run.status === 0 ? JSON.parse(run.stdout) : null };
}

test("a dry run lists what would go and removes nothing", async t => {
  const root = await volume(t);
  for (const n of [1, 2, 3, 4]) await stage(root, n, "external_metadata_pending", n);
  const { status, report } = prune(root);
  assert.equal(status, 0);
  assert.equal(report.applied, false);
  assert.deepEqual(report.stages.filter(s => s.remove.length).map(s => s.name), [stageName(1), stageName(2)]);
  assert.equal(report.freed_bytes, 2000);
  for (const n of [1, 2, 3, 4]) assert.ok(await exists(path.join(root, stageName(n), "before/installs/gen/blob")));
});

test("applying keeps the newest two committed snapshots and the live install", async t => {
  const root = await volume(t);
  for (const n of [1, 2, 3, 4]) await stage(root, n, "external_metadata_pending", n);
  assert.equal(prune(root, { apply: true }).status, 0);
  for (const n of [1, 2]) assert.equal(await exists(path.join(root, stageName(n), "before")), false);
  for (const n of [3, 4]) assert.ok(await exists(path.join(root, stageName(n), "before/installs/gen/blob")));
  for (const n of [1, 2, 3, 4]) assert.ok(await exists(path.join(root, stageName(n), "receipt.json")), "a receipt is never removed");
  assert.equal(await fs.readFile(path.join(root, "installs/live/keep.bin"), "utf8"), "live install");
  assert.equal(await fs.readFile(path.join(root, "state.db"), "utf8"), "chats");
});

test("the release in progress and the last good snapshot survive, whatever their age", async t => {
  const root = await volume(t);
  // The current stage has the OLDEST receipt on purpose: age must not decide it.
  await stage(root, 9, "candidate_healthy", 0);
  for (const n of [1, 2, 3]) await stage(root, n, "external_metadata_pending", n);
  const { report } = prune(root, { current: stageName(9), apply: true });
  assert.ok(await exists(path.join(root, stageName(9), "before/installs/gen/blob")));
  assert.ok(await exists(path.join(root, stageName(3), "before/installs/gen/blob")), "last good kept");
  for (const n of [1, 2]) assert.equal(await exists(path.join(root, stageName(n), "before")), false);
  assert.match(report.stages.find(s => s.name === stageName(9)).action, /in progress/);
  assert.match(report.stages.find(s => s.name === stageName(3)).action, /last good/);
});

test("failed installs go from every judged stage and a rolled-back attempt keeps only its receipt", async t => {
  const root = await volume(t);
  await stage(root, 1, "external_metadata_pending", 1, ["before", "failed-installs"]);
  await stage(root, 2, "rolled_back", 2, ["failed-installs", "failed-config.yaml", "before"]);
  await stage(root, 3, "external_metadata_pending", 3);
  assert.equal(prune(root, { current: stageName(3), apply: true }).status, 0);
  assert.ok(await exists(path.join(root, stageName(1), "before")), "last good kept");
  assert.equal(await exists(path.join(root, stageName(1), "failed-installs")), false);
  assert.deepEqual(await fs.readdir(path.join(root, stageName(2))), ["receipt.json"]);
  assert.ok(await exists(path.join(root, stageName(3), "before")));
});

test("a stage that may still be recovered, or has no readable receipt, is left alone", async t => {
  const root = await volume(t);
  for (const [n, phase] of [[1, "staged"], [2, "recovery_required"], [3, "old_retained"], [4, null]]) await stage(root, n, phase, n, ["before", "failed-installs"]);
  await fs.writeFile(path.join(root, stageName(4), "receipt.json"), "{not json");
  await stage(root, 5, "external_metadata_pending", 5);
  await stage(root, 6, "external_metadata_pending", 6);
  const { report } = prune(root, { apply: true });
  for (const n of [1, 2, 3, 4]) {
    assert.ok(await exists(path.join(root, stageName(n), "before/installs/gen/blob")));
    assert.ok(await exists(path.join(root, stageName(n), "failed-installs")));
    assert.match(report.stages.find(s => s.name === stageName(n)).action, /left alone/);
  }
});

test("a stage owned by someone else, a symlinked stage and other names are not touched", async t => {
  const root = await volume(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "precious"), "outside");
  await fs.symlink(outside, path.join(root, stageName(7)));
  await stage(root, 1, "external_metadata_pending", 1);
  await stage(root, 2, "external_metadata_pending", 2);
  await stage(root, 3, "external_metadata_pending", 3);
  await fs.mkdir(path.join(root, ".protected-release-short/before"), { recursive: true });
  assert.equal(prune(root, { apply: true }).status, 0);
  assert.ok(await exists(path.join(outside, "precious")));
  assert.ok(await exists(path.join(root, ".protected-release-short/before")));
  // Same folders, but the release says root owns them: nothing here is root's.
  const foreign = prune(root, { owner: 0, apply: true });
  if (process.getuid() !== 0) assert.ok(foreign.report.stages.every(s => s.remove.length === 0));
});

test("symlinks inside a removed snapshot are unlinked, never followed", async t => {
  const root = await volume(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "precious"), "outside");
  const old = await stage(root, 1, "external_metadata_pending", 1);
  await fs.symlink(outside, path.join(old, "before/link-to-dir"));
  await fs.symlink(path.join(outside, "precious"), path.join(old, "before/link-to-file"));
  await stage(root, 2, "external_metadata_pending", 2);
  await stage(root, 3, "external_metadata_pending", 3);
  assert.equal(prune(root, { apply: true }).status, 0);
  assert.equal(await exists(path.join(old, "before")), false);
  assert.equal(await fs.readFile(path.join(outside, "precious"), "utf8"), "outside");
});

test("keeping fewer than two, or a malformed current name, is refused before anything is read", async t => {
  const root = await volume(t);
  await stage(root, 1, "external_metadata_pending", 1);
  for (const options of [{ keep: 1 }, { keep: 0 }, { current: ".protected-release-nope" }]) {
    assert.notEqual(prune(root, { ...options, apply: true }).status, 0);
  }
  assert.ok(await exists(path.join(root, stageName(1), "before")));
});
