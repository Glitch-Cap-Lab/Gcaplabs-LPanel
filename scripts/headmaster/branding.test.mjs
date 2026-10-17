// Headmaster embedding tests. Dependency-free Node test file (Node 22.18+ runs
// the TypeScript modules directly) — run with:
//   node --test scripts/headmaster/branding.test.mjs
//
// Covers behaviour only: exact-origin parsing, handshake payload validation,
// and the frame-ancestors header each dashboard really emits. The launch
// exchange is covered by backend-api/__tests__/headmasterLaunchExchange.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const importRepo = async (relative) => import(pathToFileURL(path.join(repoRoot, relative)).href);

test("parent origin parsing accepts only exact https origins", async () => {
  const { parseHeadmasterParentOrigin } = await importRepo("frontend-dashboard/lib/headmaster.ts");
  assert.equal(
    parseHeadmasterParentOrigin("https://headmaster.gcaplabs.com"),
    "https://headmaster.gcaplabs.com",
  );
  assert.equal(
    parseHeadmasterParentOrigin("https://headmaster.gcaplabs.com:8443"),
    "https://headmaster.gcaplabs.com:8443",
  );
  assert.equal(
    parseHeadmasterParentOrigin("http://headmaster.gcaplabs.com"),
    null,
    "http rejected",
  );
  assert.equal(parseHeadmasterParentOrigin("https://*.gcaplabs.com"), null, "wildcard rejected");
  assert.equal(
    parseHeadmasterParentOrigin("https://headmaster.gcaplabs.com/admin"),
    null,
    "path rejected",
  );
  assert.equal(
    parseHeadmasterParentOrigin("https://headmaster.gcaplabs.com/?x=1"),
    null,
    "query rejected",
  );
  assert.equal(
    parseHeadmasterParentOrigin("https://user:pass@headmaster.gcaplabs.com"),
    null,
    "credentials rejected",
  );
  assert.equal(
    parseHeadmasterParentOrigin("https://headmaster.gcaplabs.com/#f"),
    null,
    "fragment rejected",
  );
  assert.equal(parseHeadmasterParentOrigin(""), null, "empty rejected");
  assert.equal(parseHeadmasterParentOrigin(undefined), null, "undefined rejected");
  assert.equal(parseHeadmasterParentOrigin("nonsense"), null, "garbage rejected");
});

test("handshake accepts only nonce-bound presentation messages", async () => {
  const { __headmasterTestHooks: hooks } = await importRepo("frontend-dashboard/lib/headmaster.ts");
  const hello = hooks.parseInbound({ type: "headmaster:nora:hello", nonce: "a".repeat(32) });
  assert.equal(hello?.type, "headmaster:nora:hello");

  const init = hooks.parseInbound({ type: "headmaster:nora:launch-init", nonce: "b".repeat(40) });
  assert.equal(init?.type, "headmaster:nora:launch-init");

  const code = hooks.parseInbound({
    type: "headmaster:nora:launch-code",
    nonce: "c".repeat(32),
    code: "d".repeat(64),
  });
  assert.equal(code?.type, "headmaster:nora:launch-code");
  assert.equal(code.code, "d".repeat(64));

  assert.equal(
    hooks.parseInbound({ type: "headmaster:nora:token", token: "jwt" }),
    null,
    "token messages rejected",
  );
  assert.equal(
    hooks.parseInbound({ type: "headmaster:nora:navigate", url: "https://evil.example" }),
    null,
    "navigation rejected",
  );
  assert.equal(
    hooks.parseInbound({ type: "headmaster:nora:hello", nonce: "short" }),
    null,
    "short nonce rejected",
  );
  assert.equal(
    hooks.parseInbound({ type: "headmaster:nora:hello" }),
    null,
    "missing nonce rejected",
  );
  assert.equal(hooks.parseInbound({ hello: true }), null, "non-message objects rejected");
  assert.equal(
    hooks.parseInbound({ type: "headmaster:nora:launch-code", nonce: "c".repeat(32), code: "zz" }),
    null,
    "malformed launch code rejected",
  );
  assert.ok(hooks.CODE_PATTERN.test("a".repeat(64)));
  assert.ok(!hooks.CODE_PATTERN.test("a".repeat(63)));
});

// The admin dashboard ships its own copy of the bridge library; both copies
// must answer identically.
test("both dashboards parse origins and handshake messages the same way", async () => {
  const operator = await importRepo("frontend-dashboard/lib/headmaster.ts");
  const admin = await importRepo("admin-dashboard/lib/headmaster.ts");
  for (const origin of [
    "https://headmaster.gcaplabs.com",
    "https://headmaster.gcaplabs.com:8443",
    "http://headmaster.gcaplabs.com",
    "https://*.gcaplabs.com",
    "https://headmaster.gcaplabs.com/admin",
    "",
    undefined,
  ]) {
    assert.equal(
      admin.parseHeadmasterParentOrigin(origin),
      operator.parseHeadmasterParentOrigin(origin),
      `origin ${origin}`,
    );
  }
  for (const message of [
    { type: "headmaster:nora:hello", nonce: "a".repeat(32) },
    { type: "headmaster:nora:hello", nonce: "short" },
    { type: "headmaster:nora:launch-code", nonce: "c".repeat(32), code: "d".repeat(64) },
    { type: "headmaster:nora:token", token: "jwt" },
    { hello: true },
  ]) {
    assert.deepEqual(
      admin.__headmasterTestHooks.parseInbound(message),
      operator.__headmasterTestHooks.parseInbound(message),
    );
  }
});

// Load a dashboard's Next config with a given build-time origin and return the
// headers it would send for a page.
let configLoads = 0;
async function frameHeaders(app, origin) {
  const previous = process.env.NEXT_PUBLIC_HEADMASTER_PARENT_ORIGIN;
  if (origin === undefined) delete process.env.NEXT_PUBLIC_HEADMASTER_PARENT_ORIGIN;
  else process.env.NEXT_PUBLIC_HEADMASTER_PARENT_ORIGIN = origin;
  try {
    const href = pathToFileURL(path.join(repoRoot, app, "next.config.ts")).href;
    const { default: config } = await import(`${href}?load=${configLoads++}`);
    const rules = await config.headers();
    return rules.flatMap((rule) => rule.headers);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_HEADMASTER_PARENT_ORIGIN;
    else process.env.NEXT_PUBLIC_HEADMASTER_PARENT_ORIGIN = previous;
  }
}

test("dashboards allow framing by exactly one configured parent origin", async () => {
  for (const app of ["frontend-dashboard", "admin-dashboard"]) {
    const headers = await frameHeaders(app, "https://headmaster.gcaplabs.com");
    assert.deepEqual(headers, [
      {
        key: "Content-Security-Policy",
        value: "frame-ancestors 'self' https://headmaster.gcaplabs.com",
      },
    ]);
  }
});

test("dashboards stay same-origin-only without a valid parent origin", async () => {
  for (const app of ["frontend-dashboard", "admin-dashboard"]) {
    for (const origin of [
      undefined,
      "",
      "http://headmaster.gcaplabs.com",
      "https://*.gcaplabs.com",
      "https://headmaster.gcaplabs.com/admin",
      "https://user:pass@headmaster.gcaplabs.com",
      "https://a.example https://b.example",
    ]) {
      assert.deepEqual(await frameHeaders(app, origin), [], `${app}: ${origin}`);
    }
  }
});
