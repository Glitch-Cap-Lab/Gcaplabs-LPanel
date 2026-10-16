// Headmaster / Nora rebranding tests. Dependency-free Node test file —
// run with:  node --test scripts/headmaster/branding.test.mjs
//
// Covers: exact-origin frame policy parsing, handshake payload validation,
// default frame restrictions, shared-file/theme synchronization across the
// two dashboards, navigation preservation, and the launch-exchange wiring in
// the backend. These are contract checks, not a substitute for builds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relative) => readFile(path.join(repoRoot, relative), "utf8");
const importRepo = async (relative) => import(pathToFileURL(path.join(repoRoot, relative)).href);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

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

test("nginx keeps its default frame restrictions for every surface", async () => {
  const nginx = await read("nginx.conf");
  assert.match(nginx, /default "DENY";/, "marketing and unknown paths stay DENY");
  assert.match(nginx, /"SAMEORIGIN";/, "dashboards stay SAMEORIGIN at the edge");
});

test("dashboards own their frame-ancestors policy from the build-time origin", async () => {
  for (const app of ["frontend-dashboard", "admin-dashboard"]) {
    const config = await read(`${app}/next.config.ts`);
    assert.match(config, /NEXT_PUBLIC_HEADMASTER_PARENT_ORIGIN/, `${app}: build-time origin read`);
    assert.match(config, /frame-ancestors 'self'/, `${app}: frame-ancestors emitted`);
    assert.ok(config.includes("https:"), `${app}: https scheme enforced`);
    assert.match(config, /function exactHttpsOrigin/, `${app}: exact-origin validation present`);

    const dockerfile = await read(`${app}/Dockerfile`);
    assert.match(
      dockerfile,
      /ARG NEXT_PUBLIC_HEADMASTER_PARENT_ORIGIN/,
      `${app}: build ARG threaded into the image build`,
    );
    assert.match(
      dockerfile,
      /ENV NEXT_PUBLIC_HEADMASTER_PARENT_ORIGIN=\$NEXT_PUBLIC_HEADMASTER_PARENT_ORIGIN/,
      `${app}: ARG exported for the Next.js build`,
    );
  }
});

test("bridge library and theme tokens stay synchronized across dashboards", async () => {
  const operatorBridge = await read("frontend-dashboard/lib/headmaster.ts");
  const adminBridge = await read("admin-dashboard/lib/headmaster.ts");
  assert.equal(sha256(operatorBridge), sha256(adminBridge), "bridge copies are byte-identical");

  const operatorTheme = await read("frontend-dashboard/styles/globals.css");
  const adminTheme = await read("admin-dashboard/styles/globals.css");
  for (const token of [
    "#111310",
    "#f3f4ef",
    "#cfefa5",
    "#e5d8a7",
    "#edaa86",
    "--hm-surface: #191e16",
    "--hm-line: #414d37",
    "--hm-muted: #b7c2ac",
  ]) {
    assert.ok(operatorTheme.includes(token), `operator theme has ${token}`);
    assert.ok(adminTheme.includes(token), `admin theme has ${token}`);
  }
  for (const theme of [operatorTheme, adminTheme]) {
    assert.ok(!theme.includes("#8ae6ff"), "legacy cyan palette removed");
    assert.ok(!theme.includes("#071018"), "legacy ink palette removed");
    assert.match(theme, /prefers-reduced-motion/, "reduced-motion policy kept");
  }

  const operatorTailwind = await read("frontend-dashboard/tailwind.config.ts");
  const adminTailwind = await read("admin-dashboard/tailwind.config.ts");
  for (const tailwind of [operatorTailwind, adminTailwind]) {
    assert.match(tailwind, /ink: "#111310"/);
    assert.match(tailwind, /cyan: "#cfefa5"/);
  }
});

test("operator navigation and notices are preserved, with no upstream attribution", async () => {
  const sidebar = await read("frontend-dashboard/components/layout/Sidebar.tsx");
  for (const href of [
    "/app/dashboard",
    "/app/getting-started",
    "/app/agents",
    "/app/agent-hub",
    "/app/deploy",
    "/app/remote-hosts",
    "/app/workspaces",
    "/app/monitoring",
    "/app/logs",
    "/app/settings",
  ]) {
    assert.ok(sidebar.includes(`"${href}"`), `operator nav keeps ${href}`);
  }
  assert.doesNotMatch(sidebar, /solomon2773\/nora/, "no upstream repo link in the footer");
  assert.doesNotMatch(sidebar, /Powered by/, "no upstream attribution in the footer");

  const topbar = await read("frontend-dashboard/components/layout/Topbar.tsx");
  assert.ok(!topbar.includes('"Operational"'), "hard-coded Operational health badge removed");
  assert.ok(!topbar.includes("CheckCircle2"), "badge icon removed with the badge");

  const adminLayout = await read("admin-dashboard/components/AdminLayout.tsx");
  for (const href of [
    '"/"',
    '"/health"',
    '"/fleet"',
    '"/queue"',
    '"/users"',
    '"/members"',
    '"/user-groups"',
    '"/kubernetes"',
    '"/remote-hosts"',
    '"/agent-hub"',
    '"/backups"',
    '"/audit"',
    '"/settings"',
  ]) {
    assert.ok(adminLayout.includes(`href: ${href}`), `platform nav keeps ${href}`);
  }
  assert.doesNotMatch(adminLayout, /Powered by/, "no upstream attribution in the admin footer");
});

test("launch exchange backend wiring is present and fail-closed", async () => {
  const launch = await read("backend-api/headmasterLaunch.ts");
  assert.match(launch, /getdel/, "launch codes are consumed atomically (single use)");
  assert.match(launch, /timingSafeEqual/, "comparisons are constant-time");
  assert.match(launch, /"NX"/, "code issuance is atomic");
  assert.match(launch, /no_admin_link/, "redemption requires an explicit identity link");
  assert.match(launch, /nora_user_not_admin/, "non-admin Nora accounts cannot be launched");
  assert.match(launch, /browser_binding_mismatch/, "browser-initiation cookie binding enforced");
  assert.match(launch, /sameSite: "none"/, "embedded sessions use SameSite=None");
  assert.match(launch, /httpOnly: true/, "session cookie stays HttpOnly");
  assert.match(launch, /HEADMASTER_LAUNCH_TTL_SECONDS, 60, 30, 120/, "launch code TTL ~60s");
  assert.match(
    launch,
    /HEADMASTER_SESSION_TTL_SECONDS,\s*12 \* 60 \* 60/,
    "hm session lifetime is capped (bounded staleness)",
  );
  assert.match(
    launch,
    /expiresIn: SESSION_TTL_SECONDS/,
    "JWT expiry matches the session record TTL",
  );
  assert.match(launch, /authorization_unavailable/, "storage outages fail closed");
  assert.match(launch, /registerPrivilegedSocket/, "live privileged sockets are tracked");
  assert.match(launch, /revokeHeadmasterSessions/, "revocation entry point exists");

  const routes = await read("backend-api/routes/headmaster.ts");
  assert.match(routes, /requireS2S/, "internal routes demand the S2S bearer token");
  assert.match(routes, /HEADMASTER_S2S_TOKEN/, "S2S token read from server env");
  assert.match(routes, /Not found/, "disabled deployments hide the surface");

  const auth = await read("backend-api/routes/auth.ts");
  assert.match(auth, /\/headmaster\/initiate/, "browser-binding initiation endpoint exists");
  assert.match(auth, /\/headmaster\/redeem/, "redemption endpoint exists");

  const middleware = await read("backend-api/middleware/auth.ts");
  assert.match(middleware, /decoded\.hm/, "headmaster sessions are detected");
  assert.match(middleware, /sessionExists/, "every request re-checks revocation state");

  const server = await read("backend-api/server.ts");
  const internalMount = server.indexOf('app.use("/internal/headmaster"');
  const authWall = server.indexOf("app.use(authenticateToken)");
  assert.ok(internalMount > -1, "internal router mounted");
  assert.ok(
    authWall > internalMount,
    "internal router sits before the auth wall (own bearer auth)",
  );

  const admin = await read("backend-api/routes/admin.ts");
  assert.match(admin, /nora_role_demoted/, "demotion revokes launched sessions");
  assert.match(admin, /nora_user_deleted/, "user deletion revokes launched sessions");

  for (const stream of ["logStream", "execStream", "metricsStream"]) {
    const file = await read(`backend-api/${stream}.ts`);
    assert.match(file, /assertPrivilegedSocketSession/, `${stream}: upgrade guard present`);
    assert.match(
      file,
      /registerPrivilegedSocket/,
      `${stream}: live socket registered for revocation`,
    );
  }
});

test("compose threads the parent origin into both dashboard builds", async () => {
  const compose = await read("docker-compose.yml");
  for (const app of ["frontend-dashboard", "admin-dashboard"]) {
    const block = compose.split(new RegExp(`^  ${app}:\\n`, "m"))[1]?.split(/^  \S/m)[0] ?? "";
    assert.match(
      block,
      /args:\s*\n(?:\s*#.*\n)*\s*NEXT_PUBLIC_HEADMASTER_PARENT_ORIGIN: \$\{NEXT_PUBLIC_HEADMASTER_PARENT_ORIGIN:-\}/,
      `${app}: compose build arg present`,
    );
  }
});

test("no visible \"Nora\" string in either dashboard", async () => {
  const { readdir } = await import("node:fs/promises");
  const walk = async (dir) => {
    const out = [];
    for (const entry of await readdir(path.join(repoRoot, dir), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) out.push(...(await walk(rel)));
      else if (/\.(tsx?|md)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(rel);
    }
    return out;
  };
  const hits = [];
  for (const dir of ["admin-dashboard", "frontend-dashboard"]) {
    for (const file of await walk(dir)) {
      const lines = (await read(file)).split("\n");
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
        if (/\bNora\b/.test(line)) hits.push(`${file}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(hits, [], "capitalised Nora must not appear in visible strings");
});
