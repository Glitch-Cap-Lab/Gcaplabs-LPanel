// Explicit opt-in local PostgreSQL fixture. No configured/existing database is used.
// Reuses the qualification harness; requires already-installed PostgreSQL 17 and Node 24.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const options = Object.fromEntries(process.argv.slice(2).map(arg => {
  const index = arg.indexOf("="); assert.ok(index > 0, "use --name=value arguments");
  return [arg.slice(0, index), arg.slice(index + 1)];
}));
assert.ok(Object.keys(options).every(key => ["--cluster", "--port", "--mode", "--bin"].includes(key)));
const cluster = path.resolve(options["--cluster"] || "");
assert.ok(options["--cluster"] && path.isAbsolute(options["--cluster"]) && !existsSync(cluster), "new explicit absolute cluster required");
const port = Number(options["--port"]);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536, "explicit unprivileged localhost port required");
assert.ok(["transaction", "autocommit"].includes(options["--mode"]), "explicit mode required");
const bin = options["--bin"] || "C:/Program Files/PostgreSQL/17/bin";
assert.ok(path.isAbsolute(bin) && existsSync(bin), "already-installed absolute PostgreSQL binary directory required");
const suffix = process.platform === "win32" ? ".exe" : "";
const run = (name, args) => new Promise((resolve, reject) => {
  const child = spawn(path.join(bin, name + suffix), args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { output += value; });
  child.on("error", reject); child.on("exit", code => code === 0 ? resolve(output) : reject(new Error(`${name}: ${output}`)));
});
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(source, "backend-api/package.json"));
const { Client } = require("pg");
const file = path.join(source, "workers/provisioner/deploymentLifecycle.ts");
const { acquireDedicatedSessionLock } = require(file);
console.log(`source_sha256=${createHash("sha256").update(readFileSync(file)).digest("hex")}`);
const config = { host: "127.0.0.1", port, user: "postgres", database: "postgres", password: "synthetic-unused", ssl: false };
const key = "94319001", pause = ms => new Promise(resolve => setTimeout(resolve, ms));
mkdirSync(path.dirname(cluster), { recursive: true });
await run("initdb", ["-D", cluster, "--auth=trust", "--username=postgres", "--encoding=UTF8", "--locale=C"]);
const owner = JSON.stringify({ format: "protected-release-postgres-fixture/v1", operation: randomUUID(), cluster: realpathSync(cluster), port });
const marker = path.join(cluster, ".protected-release-fixture-owner.json");
writeFileSync(marker, owner, { flag: "wx", mode: 0o600 });
let started = false, observer, lock;
try {
  await run("pg_ctl", ["-D", cluster, "-l", path.join(cluster, "server.log"), "-o", `-p ${port} -h 127.0.0.1`, "-w", "start"]); started = true;
  observer = new Client({ ...config, application_name: "protected-release-lock-observer" }); await observer.connect();
  assert.equal(realpathSync((await observer.query("show data_directory")).rows[0].data_directory), realpathSync(cluster));
  await observer.query("create table synthetic_lock_cancel(id integer primary key)");
  const controller = new AbortController();
  lock = await acquireDedicatedSessionLock({ createClient: () => new Client({ ...config, application_name: "protected-release-lock-holder" }), signal: controller.signal, maxHoldMs: 10000,
    acquire: client => client.query("select pg_advisory_lock($1)", [key]), release: client => client.query("select pg_advisory_unlock($1)", [key]) });
  const autocommit = options["--mode"] === "autocommit";
  if (!autocommit) { await lock.query("begin"); await lock.query("insert into synthetic_lock_cancel values(1)"); }
  const pending = lock.query(autocommit ? "insert into synthetic_lock_cancel select 1 from pg_sleep(2)" : "select pg_sleep(60)")
    .then(() => ({ ok: true }), error => ({ ok: false, error }));
  let active = false;
  for (let index = 0; index < 100; index++) {
    if ((await observer.query("select 1 from pg_stat_activity where application_name='protected-release-lock-holder' and wait_event='PgSleep'")).rowCount) { active = true; break; }
    await pause(20);
  }
  assert.ok(active, "actual held-session query is executing");
  const began = Date.now(); lock.cancelPending(new Error("synthetic operation deadline"));
  const result = await Promise.race([pending, pause(2000).then(() => ({ timeout: true }))]);
  assert.equal(result.ok, false); assert.ok(!result.timeout, "query settles within 2 seconds"); assert.ok(lock.signal.aborted);
  await lock.release();
  let acquired = false;
  for (let index = 0; index < 100; index++) {
    if ((await observer.query("select pg_try_advisory_lock($1) as locked", [key])).rows[0].locked) { acquired = true; break; }
    await pause(20);
  }
  assert.ok(acquired, "different real PG session reacquires released advisory lock within 2 seconds");
  assert.equal((await observer.query("select count(*)::int as n from synthetic_lock_cancel")).rows[0].n, 0, "no delayed write survives cancellation");
  await assert.rejects(lock.query("insert into synthetic_lock_cancel values(2)"), /synthetic operation deadline|lost/i);
  assert.equal((await observer.query("select count(*)::int as n from synthetic_lock_cancel")).rows[0].n, 0, "post-abort write refused");
  await observer.query("select pg_advisory_unlock($1)", [key]);
  console.log(`PASS ${options["--mode"]}: zero rows, advisory reacquired, future write refused; ${Date.now() - began}ms`);
} finally {
  if (lock) await lock.release().catch(() => {});
  if (observer) await observer.end().catch(() => {});
  if (started) {
    assert.equal(readFileSync(marker, "utf8"), owner, "task ownership marker must match before stop");
    const actual = (await run("psql", ["-X", "-q", "-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres", "-At", "-c", "show data_directory"])).trim();
    assert.equal(realpathSync(actual), realpathSync(cluster), "only stop the exact newly created cluster");
    await run("pg_ctl", ["-D", cluster, "-m", "fast", "-w", "stop"]);
    console.log(`Stopped verified task-only server; retained ${cluster}`);
  }
}
