// @ts-nocheck
// Account deletion's push cleanup step against a real migrated PostgreSQL. The deletion client runs
// unchanged; its Supabase REST calls for the push table are answered by the real database as the
// service role. Needs PostgreSQL binaries and the site migrations:
//   HEADMASTER_SITE_MIGRATIONS=/path/to/site/supabase/migrations   (HEADMASTER_REQUIRE_PG=1 fails instead of skipping)
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { createDeletionClient } = require("../headmasterAccountDeletions");
const { pgAvailable, startPg, lit } = require("./support/pgFixture");

const DIR = process.env.HEADMASTER_SITE_MIGRATIONS;
const OLD = ["20261006120000_headmaster_push_registrations.sql", "20261006121000_headmaster_account_deletion_requests.sql", "20261013130000_push_registration_muted_kinds.sql", "20261013170000_push_muted_kinds_question.sql", "20261016120000_headmaster_auth_session_active.sql"];
const NEW = [...OLD, "20261019170000_push_registration_binding_cas.sql"];
const runnable = pgAvailable() && DIR && existsSync(join(DIR || "", NEW[NEW.length - 1]));
if (!runnable && process.env.HEADMASTER_REQUIRE_PG === "1") throw new Error("PostgreSQL or HEADMASTER_SITE_MIGRATIONS missing");
const maybe = runnable ? describe : describe.skip;

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SA = "11111111-1111-4111-8111-111111111111", SB = "22222222-2222-4222-8222-222222222222";
const T1 = "ab".repeat(32), T2 = "cd".repeat(32), T3 = "ef".repeat(32);
const ENV = { HEADMASTER_SUPABASE_URL: "https://project.example", HEADMASTER_SUPABASE_SERVICE_ROLE_KEY: "k" };
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });

function clientFor(pg) {
  let receipt = { id: "r1", owner_id: A, status: "running", steps: { revoke_sessions: "done" }, cleanup_targets: { version: 1, owner_id: A, bindings: [] }, cleanup_results: {} };
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url), method = init.method || "GET";
    if (u.pathname.endsWith("/headmaster_account_deletion_requests")) {
      if (method === "GET") return reply(200, [receipt]);
      if (method === "PATCH") { receipt = { ...receipt, ...JSON.parse(init.body) }; return reply(200, [receipt]); }
    }
    calls.push([method, u.pathname.split("/rest/v1/")[1]]);
    if (u.pathname.endsWith("/rpc/headmaster_push_registration_purge_owner")) {
      try { return reply(200, Number(pg.rows(`select public.headmaster_push_registration_purge_owner(${lit(JSON.parse(init.body).p_owner_id)}::uuid) as n`, "service_role")[0].n)); }
      catch (e) { return /does not exist/.test(String(e.stderr)) ? reply(404, { code: "PGRST202" }) : reply(500, {}); }
    }
    if (method === "DELETE" && u.pathname.endsWith("/headmaster_push_registrations")) {
      const owner = u.searchParams.get("owner_id").replace(/^eq\./, "");
      try { pg.psql(`delete from public.headmaster_push_registrations where owner_id = ${lit(owner)}`, "service_role"); return reply(204, {}); }
      catch (e) { return reply(/permission denied/.test(String(e.stderr)) ? 403 : 500, {}); }
    }
    return reply(200, {});
  };
  return { client: createDeletionClient({ env: ENV, fetchImpl, cleanupOps: {} }), calls, receipt: () => receipt };
}

maybe("account deletion push cleanup on real PostgreSQL", () => {
  jest.setTimeout(120000);
  const seed = (pg) => pg.psql(`insert into auth.users(id) values (${lit(A)}), (${lit(B)});
    insert into auth.sessions(id, user_id) values (${lit(SA)}, ${lit(A)}), (${lit(SB)}, ${lit(B)});`);
  const owners = (pg) => pg.rows("select device_token, owner_id from public.headmaster_push_registrations order by device_token");
  let pg;
  afterEach(() => { pg?.stop(); pg = null; });

  test("after the binding migration: removes only this account's rows (bound), leaves pending and other accounts", () => {
    pg = startPg(NEW.map((n) => join(DIR, n)));
    seed(pg);
    const step = (intent, owner, session, token, rev) => pg.psql(`select outcome from public.headmaster_push_registration_apply(${lit(intent)}, ${lit(owner)}::uuid, ${lit(session)}::uuid, ${lit(token)}, 'production', null::text[], ${rev === null ? "null::bigint" : rev})`, "service_role");
    step("prepare", A, SA, T1, null); step("bind", A, SA, T1, 1);
    step("prepare", B, SB, T2, null); step("bind", B, SB, T2, 1);
    step("prepare", A, SA, T3, null);                       // pending, owner null
    return (async () => {
      const f = clientFor(pg);
      const row = await f.client.completeStep("r1", "push_registrations", "ops");
      expect(row.steps.push_registrations).toBe("done");
      expect(f.calls).toEqual([["POST", "rpc/headmaster_push_registration_purge_owner"]]);
      expect(owners(pg)).toEqual([{ device_token: T2, owner_id: B }, { device_token: T3, owner_id: null }]);
    })();
  });

  test("the legacy direct delete cannot run after the binding migration, so the RPC is the only path", () => {
    pg = startPg(NEW.map((n) => join(DIR, n)));
    seed(pg);
    expect(() => pg.psql(`delete from public.headmaster_push_registrations where owner_id = ${lit(A)}`, "service_role")).toThrow(/permission denied/);
  });

  test("before the binding migration: the missing RPC falls back to the owner-scoped delete on the real table", async () => {
    pg = startPg(OLD.map((n) => join(DIR, n)));
    seed(pg);
    pg.psql(`insert into public.headmaster_push_registrations(device_token, owner_id, environment) values (${lit(T1)}, ${lit(A)}, 'production'), (${lit(T2)}, ${lit(B)}, 'production')`);
    const f = clientFor(pg);
    const row = await f.client.completeStep("r1", "push_registrations", "ops");
    expect(row.steps.push_registrations).toBe("done");
    expect(f.calls.map((c) => c[0])).toEqual(["POST", "DELETE"]);
    expect(owners(pg)).toEqual([{ device_token: T2, owner_id: B }]);
  });
});
