// Throwaway PostgreSQL for tests that need the real site migrations (CommonJS twin of the site's
// lib/test-support/pg-fixture.mjs). Fresh cluster in a temp dir owned by `postgres`, psql over a
// unix socket, no Docker, no hosted database. HEADMASTER_TEST_PG_BIN overrides the bin directory.
const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, rmSync, chmodSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const BIN = process.env.HEADMASTER_TEST_PG_BIN || "/usr/lib/postgresql/16/bin";
const pgAvailable = () => existsSync(join(BIN, "initdb")) && existsSync(join(BIN, "psql"));

const SURFACE = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to service_role;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid());
create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade, not_after timestamptz);
`;

const lit = (v) => (v === null || v === undefined ? "null" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

function startPg(migrations) {
  const root = process.getuid && process.getuid() === 0;
  const as = (cmd, args) => (root ? ["runuser", ["-u", "postgres", "--", cmd, ...args]] : [cmd, args]);
  const sh = (cmd, args) => { const [c, a] = as(cmd, args); return execFileSync(c, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); };
  const dir = mkdtempSync(join(process.env.HEADMASTER_TEST_TMP || tmpdir(), "pgfix-"));
  chmodSync(dir, 0o755);
  if (root) execFileSync("chown", ["postgres:postgres", dir]);
  const data = join(dir, "data"), sock = join(dir, "sock");
  sh("mkdir", [sock]);
  sh(join(BIN, "initdb"), ["-D", data, "-A", "trust", "--no-locale", "-E", "UTF8"]);
  sh(join(BIN, "pg_ctl"), ["-D", data, "-w", "-l", join(dir, "log"), "-o", `-c listen_addresses= -c unix_socket_directories=${sock} -c fsync=off`, "start"]);
  const base = ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", sock, "-d", "postgres"];
  const psql = (sql, role) => sh(join(BIN, "psql"), [...base, "-At", "-c", role ? `set role ${role};\n${sql}` : sql]);
  const rows = (sql, role) => JSON.parse(psql(`select coalesce(jsonb_agg(t), '[]'::jsonb) from (${sql}) t`, role).trim().split("\n").pop());
  psql(SURFACE);
  migrations.forEach((path, i) => {
    const copy = join(dir, `migration-${i}.sql`);
    execFileSync("cp", [path, copy]); chmodSync(copy, 0o644);
    sh(join(BIN, "psql"), [...base, "-f", copy]);
  });
  const stop = () => { try { sh(join(BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"]); } catch { /* stopped */ } rmSync(dir, { recursive: true, force: true }); };
  return { psql, rows, stop };
}

module.exports = { pgAvailable, startPg, lit };
