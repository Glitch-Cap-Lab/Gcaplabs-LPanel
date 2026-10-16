// @ts-nocheck
// Headmaster admin launch exchange.
//
// Server-to-server issuance (Headmaster site → Nora) plus browser redemption
// of a short-lived, single-use, audience/origin-bound launch code that is
// bound to a browser-initiation cookie nonce. Redemption establishes a real
// Nora session for an explicitly linked, existing Nora administrator using the
// platform's native authorization model. Headmaster-launched sessions carry
// an `hm` claim and are tracked in shared Redis storage so that logout,
// account switch, suspension, demotion, or link removal revoke them —
// including already-open privileged WebSockets — with a bounded delay.
//
// Fail-closed rule: every liveness check that cannot be evaluated (Redis or
// authorization-service outage) rejects the request instead of allowing it.
//
// This module never reuses per-user Hermes admission grants as platform
// credentials, never maps an arbitrary GCAP account by email, and never
// auto-promotes accounts: redemption only succeeds for an explicit, existing
// row in headmaster_admin_links whose Nora user is currently an admin.

const crypto = require("crypto");
const IORedis = require("ioredis");
const jwt = require("jsonwebtoken");
const db = require("./db");
const { createRedisClient } = require("./lib/connectionConfig");
const { AUTH_COOKIE_NAME, AUTH_COOKIE_MAX_AGE_MS } = require("./authCookie");

const IS_TEST_ENV = process.env.NODE_ENV === "test" || !!process.env.JEST_WORKER_ID;

const CODE_TTL_SECONDS = clampInt(process.env.HEADMASTER_LAUNCH_TTL_SECONDS, 60, 30, 120);
// Operator lever: 10-120 s, default 25 s. A revoked hm session can survive up to
// this long before the revalidator notices.
function parseRevalidateSeconds(rawValue) {
  return clampInt(rawValue, 25, 10, 120);
}
const REVALIDATE_SECONDS = parseRevalidateSeconds(process.env.HEADMASTER_REVALIDATE_SECONDS);
// Headmaster-launched sessions live shorter than native ones by default: the
// GCAP side has no admin session-enumeration API, so liveness revalidation
// covers role/suspension while this TTL bounds any stale binding. Re-launch
// from the workspace renews it.
const SESSION_TTL_SECONDS = clampInt(
  process.env.HEADMASTER_SESSION_TTL_SECONDS,
  12 * 60 * 60,
  300,
  7 * 24 * 60 * 60,
);
const REVOKE_CHANNEL = "hm:chan:revoke";
const KEY = {
  code: (hash) => `hm:code:${hash}`,
  sess: (jti) => `hm:sess:${jti}`,
  userSess: (noraUserId) => `hm:sess:user:${noraUserId}`,
};

function clampInt(rawValue, fallback, min, max) {
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireS2SToken() {
  return process.env.HEADMASTER_S2S_TOKEN || "";
}

function configuredParentOrigin() {
  return process.env.HEADMASTER_PARENT_ORIGIN || "";
}

function isEnabled() {
  return Boolean(requireS2SToken() && configuredParentOrigin());
}

/** Exact HTTPS origin, no wildcard/path/query/credentials. */
function isExactHttpsOrigin(value) {
  if (typeof value !== "string") return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || !url.hostname) return false;
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.pathname && url.pathname !== "/") return false;
  return `${url.protocol}//${url.host}`.toLowerCase() === value.toLowerCase().replace(/\/$/, "");
}

function assertParentOrigin(value) {
  const expected = configuredParentOrigin();
  if (!expected)
    throw httpError(503, "headmaster_disabled", "Headmaster launch is not configured.");
  if (!isExactHttpsOrigin(value) || value.toLowerCase() !== expected.toLowerCase()) {
    throw httpError(
      403,
      "origin_mismatch",
      "Launch origin does not match the configured parent origin.",
    );
  }
}

function httpError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

// ── Storage ──────────────────────────────────────────────────────────────────

let redis = null;
let redisSubscriber = null;

// Non-blocking key listing: SCAN walks the keyspace in batches instead of
// KEYS, which blocks Redis for the whole scan.
async function scanKeys(redis, pattern) {
  const found = new Set();
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 200);
    cursor = String(next);
    for (const key of batch || []) found.add(key);
  } while (cursor !== "0");
  return [...found];
}

function getRedis() {
  if (IS_TEST_ENV && !redis) {
    throw httpError(503, "storage_unavailable", "Launch storage is unavailable.");
  }
  if (!redis) {
    redis = createRedisClient(IORedis, process.env, { maxRetriesPerRequest: 2 });
  }
  return redis;
}

// ── Schema and audit ─────────────────────────────────────────────────────────

let schemaReady = null;

function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS headmaster_admin_links (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          gcap_user_id TEXT NOT NULL UNIQUE,
          nora_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_by UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          revoked_at TIMESTAMPTZ
        )
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS headmaster_audit (
          id BIGSERIAL PRIMARY KEY,
          at TIMESTAMPTZ NOT NULL DEFAULT now(),
          event TEXT NOT NULL,
          outcome TEXT NOT NULL,
          gcap_user_id TEXT,
          nora_user_id UUID,
          gcap_session_id TEXT,
          detail JSONB
        )
      `);
    })();
    schemaReady.catch(() => {
      schemaReady = null;
    });
  }
  return schemaReady;
}

async function audit(event, outcome, { gcapUserId, noraUserId, gcapSessionId, detail } = {}) {
  try {
    await ensureSchema();
    await db.query(
      `INSERT INTO headmaster_audit (event, outcome, gcap_user_id, nora_user_id, gcap_session_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        event,
        outcome,
        gcapUserId || null,
        noraUserId || null,
        gcapSessionId || null,
        detail ? JSON.stringify(detail) : null,
      ],
    );
  } catch (error) {
    console.error("headmaster audit write failed:", error.message);
  }
}

// ── Admin links ──────────────────────────────────────────────────────────────

async function listHeadmasterLinks() {
  await ensureSchema();
  const { rows } = await db.query(
    `SELECT l.id, l.gcap_user_id, l.nora_user_id, u.email AS nora_email, u.role AS nora_role,
            l.created_by, l.created_at, l.revoked_at
       FROM headmaster_admin_links l
       JOIN users u ON u.id = l.nora_user_id
      ORDER BY l.created_at ASC`,
  );
  return rows;
}

async function resolveHeadmasterLink(gcapUserId) {
  await ensureSchema();
  const { rows } = await db.query(
    `SELECT l.id, l.nora_user_id, u.email, u.role
       FROM headmaster_admin_links l
       JOIN users u ON u.id = l.nora_user_id
      WHERE l.gcap_user_id = $1 AND l.revoked_at IS NULL`,
    [gcapUserId],
  );
  const link = rows[0];
  if (!link)
    throw httpError(
      403,
      "no_admin_link",
      "No approved LPanel administrator is linked to this account.",
    );
  return link;
}

/**
 * Create the explicit identity link. `actor` is the Nora admin performing the
 * grant (or "s2s" for server-to-server provisioning). The Nora target must
 * already exist and hold the admin role — this never promotes anyone.
 */
async function createHeadmasterLink({ gcapUserId, noraUserId, actor }) {
  if (!gcapUserId || typeof gcapUserId !== "string" || gcapUserId.length > 128) {
    throw httpError(400, "invalid_gcap_user", "A GCAP user id is required.");
  }
  await ensureSchema();
  const { rows } = await db.query("SELECT id, email, role FROM users WHERE id = $1", [noraUserId]);
  const target = rows[0];
  if (!target) throw httpError(404, "nora_user_missing", "The LPanel user to link does not exist.");
  if (target.role !== "admin") {
    throw httpError(400, "nora_user_not_admin", "Only existing LPanel administrators can be linked.");
  }
  await db.query(
    `INSERT INTO headmaster_admin_links (gcap_user_id, nora_user_id, created_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (gcap_user_id) DO UPDATE
       SET nora_user_id = EXCLUDED.nora_user_id,
           revoked_at = NULL,
           created_by = EXCLUDED.created_by`,
    [gcapUserId, noraUserId, actor && actor !== "s2s" ? actor : null],
  );
  await audit("link_created", "allowed", {
    gcapUserId,
    noraUserId,
    detail: { actor: actor || null },
  });
  return { gcapUserId, noraUserId };
}

async function removeHeadmasterLink(linkId, actor) {
  await ensureSchema();
  const { rows } = await db.query(
    `UPDATE headmaster_admin_links SET revoked_at = now()
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING gcap_user_id, nora_user_id`,
    [linkId],
  );
  const removed = rows[0];
  if (!removed) throw httpError(404, "link_missing", "No active link with that id.");
  // Link removal revokes every session that was minted through it.
  const revoked = await revokeHeadmasterSessions({
    gcapUserId: removed.gcap_user_id,
    reason: "link_removed",
  });
  await audit("link_removed", "allowed", {
    gcapUserId: removed.gcap_user_id,
    noraUserId: removed.nora_user_id,
    detail: { actor: actor || null, sessionsRevoked: revoked },
  });
  return removed;
}

// ── Launch codes ─────────────────────────────────────────────────────────────

const CODE_PATTERN = /^[A-Fa-f0-9]{64}$/;
const BROWSER_NONCE_PATTERN = /^[A-Fa-f0-9]{32,128}$/;

/**
 * Issue a single-use launch code. Called only through the authenticated
 * server-to-server route after the Headmaster server has freshly verified the
 * GCAP session, admin role, and suspension state.
 */
async function createLaunchCode({ gcapUserId, gcapSessionId, browserNonce, parentOrigin }) {
  if (!isEnabled())
    throw httpError(503, "headmaster_disabled", "Headmaster launch is not configured.");
  if (typeof gcapSessionId !== "string" || gcapSessionId.length < 8 || gcapSessionId.length > 256) {
    throw httpError(400, "invalid_session", "A GCAP session id is required.");
  }
  if (!BROWSER_NONCE_PATTERN.test(browserNonce || "")) {
    throw httpError(
      400,
      "invalid_browser_nonce",
      "A browser nonce from the initiating browser is required.",
    );
  }
  assertParentOrigin(parentOrigin);
  const link = await resolveHeadmasterLink(gcapUserId);

  const code = crypto.randomBytes(32).toString("hex");
  const payload = JSON.stringify({
    g: gcapUserId,
    s: gcapSessionId,
    n: sha256Hex(browserNonce),
    u: link.nora_user_id,
    o: configuredParentOrigin().toLowerCase(),
  });
  const set = await getRedis().set(
    KEY.code(sha256Hex(code)),
    payload,
    "EX",
    CODE_TTL_SECONDS,
    "NX",
  );
  if (set !== "OK") throw httpError(503, "issue_failed", "Could not issue the launch code.");
  await audit("code_issued", "allowed", {
    gcapUserId,
    noraUserId: link.nora_user_id,
    gcapSessionId,
  });
  return { code, expiresInSeconds: CODE_TTL_SECONDS, noraUserId: link.nora_user_id };
}

/**
 * Atomically consume a launch code and establish the browser-binding match.
 * Returns the resolved Nora identity; the caller mints the session.
 */
async function consumeLaunchCode({ code, browserNonceCookie }) {
  if (!isEnabled())
    throw httpError(503, "headmaster_disabled", "Headmaster launch is not configured.");
  if (!CODE_PATTERN.test(code || "")) throw httpError(400, "invalid_code", "Invalid launch code.");
  if (!BROWSER_NONCE_PATTERN.test(browserNonceCookie || "")) {
    throw httpError(
      403,
      "browser_binding_missing",
      "Launch redemption requires the initiating browser cookie.",
    );
  }
  const redis = getRedis();
  const codeHash = sha256Hex(code);
  // GETDEL is atomic: a replayed code finds nothing on the second attempt.
  const raw = await redis.getdel(KEY.code(codeHash));
  if (!raw)
    throw httpError(403, "code_invalid", "Launch code is invalid, expired, or already used.");
  let binding;
  try {
    binding = JSON.parse(raw);
  } catch {
    throw httpError(403, "code_invalid", "Launch code is invalid.");
  }
  if (binding.o !== configuredParentOrigin().toLowerCase()) {
    await audit("redeem_rejected", "denied", { detail: { reason: "origin_mismatch" } });
    throw httpError(403, "origin_mismatch", "Launch code audience does not match this deployment.");
  }
  if (!timingSafeEqual(binding.n, sha256Hex(browserNonceCookie))) {
    await audit("redeem_rejected", "denied", { detail: { reason: "browser_binding_mismatch" } });
    throw httpError(
      403,
      "browser_binding_mismatch",
      "Launch was initiated by a different browser.",
    );
  }
  // Re-resolve at redemption time: a link removed between issuance and
  // redemption cancels the launch.
  const link = await resolveHeadmasterLink(binding.g);
  if (link.nora_user_id !== binding.u) {
    await audit("redeem_rejected", "denied", { detail: { reason: "identity_swapped" } });
    throw httpError(
      403,
      "identity_mismatch",
      "Launch code no longer matches the linked administrator.",
    );
  }
  if (link.role !== "admin") {
    await audit("redeem_rejected", "denied", {
      gcapUserId: binding.g,
      noraUserId: link.nora_user_id,
      detail: { reason: "nora_role_not_admin" },
    });
    throw httpError(
      403,
      "nora_user_not_admin",
      "The linked LPanel account is no longer an administrator.",
    );
  }
  await audit("code_consumed", "allowed", {
    gcapUserId: binding.g,
    noraUserId: link.nora_user_id,
    gcapSessionId: binding.s,
  });
  return {
    gcapUserId: binding.g,
    gcapSessionId: binding.s,
    noraUserId: link.nora_user_id,
    email: link.email,
  };
}

// ── Headmaster-launched session records ──────────────────────────────────────

async function createHeadmasterSession({ gcapUserId, gcapSessionId, noraUserId, email, role }) {
  const jti = crypto.randomUUID();
  const record = JSON.stringify({
    g: gcapUserId,
    s: gcapSessionId,
    u: noraUserId,
    iat: Date.now(),
    checked: Date.now(),
  });
  const redis = getRedis();
  const pipeline = redis
    .multi()
    .set(KEY.sess(jti), record, "EX", SESSION_TTL_SECONDS)
    .sadd(KEY.userSess(noraUserId), jti);
  const results = await pipeline.exec();
  if (!results || results.some(([error]) => error)) {
    // Fail closed: never hand out an untracked hm session.
    throw httpError(503, "storage_unavailable", "Could not record the launch session.");
  }
  await audit("session_created", "allowed", {
    gcapUserId,
    noraUserId,
    gcapSessionId,
    detail: { email, role },
  });
  return jti;
}

/** True when the hm session still exists. Throws (fail closed) on storage errors. */
async function sessionExists(jti) {
  try {
    return Boolean(await getRedis().exists(KEY.sess(jti)));
  } catch (error) {
    console.error("headmaster session check failed closed:", error.message);
    throw httpError(
      503,
      "authorization_unavailable",
      "Session authorization could not be verified.",
    );
  }
}

/**
 * Revoke headmaster sessions by GCAP session, GCAP user, or Nora user.
 * Returns the number of revoked sessions; also terminates live sockets.
 */
async function revokeHeadmasterSessions({ gcapSessionId, gcapUserId, noraUserId, reason }) {
  const redis = getRedis();
  const jtis = new Set();
  const noraUserIds = new Set();

  const collectForUser = async (userId) => {
    noraUserIds.add(userId);
    const members = await redis.smembers(KEY.userSess(userId));
    for (const jti of members || []) jtis.add(jti);
  };

  if (noraUserId) {
    await collectForUser(noraUserId);
  }
  if (gcapUserId || gcapSessionId) {
    await ensureSchema();
    // Nora users linked to this GCAP account: revoke everything indexed under
    // them (covers sessions created before a link was re-pointed).
    if (gcapUserId) {
      const { rows } = await db.query(
        "SELECT DISTINCT nora_user_id FROM headmaster_admin_links WHERE gcap_user_id = $1",
        [gcapUserId],
      );
      for (const row of rows) await collectForUser(row.nora_user_id);
    }
    // Live session records carry the GCAP binding directly; match on it so a
    // stale or re-pointed link cannot leave an orphaned session alive.
    const keys = await scanKeys(redis, "hm:sess:*");
    for (const key of keys || []) {
      if (key.startsWith("hm:sess:user:")) continue;
      const raw = await redis.get(key);
      if (!raw) continue;
      let record;
      try {
        record = JSON.parse(raw);
      } catch {
        continue;
      }
      if (
        (gcapUserId && record.g === gcapUserId) ||
        (gcapSessionId && record.s === gcapSessionId)
      ) {
        jtis.add(key.slice("hm:sess:".length));
        noraUserIds.add(record.u);
      }
    }
  }

  let revoked = 0;
  for (const jti of jtis) {
    const raw = await redis.getdel(KEY.sess(jti));
    if (raw) {
      revoked += 1;
      try {
        const record = JSON.parse(raw);
        noraUserIds.add(record.u);
        await redis.srem(KEY.userSess(record.u), jti);
      } catch {
        // Record already gone or unreadable — the GETDEL above did its job.
      }
    }
  }

  if (jtis.size > 0) {
    // Terminate already-open privileged WebSockets immediately (local process)
    // and in every other backend replica via pub/sub.
    closeLocalSockets(jtis, noraUserIds);
    redis
      .publish(
        REVOKE_CHANNEL,
        JSON.stringify({ jtis: [...jtis], noraUserIds: [...noraUserIds], reason: reason || null }),
      )
      .catch(() => {});
    await audit("sessions_revoked", "allowed", {
      gcapUserId: gcapUserId || null,
      noraUserId: noraUserId || null,
      gcapSessionId: gcapSessionId || null,
      detail: { reason: reason || null, count: revoked },
    });
  }
  return revoked;
}

/**
 * Revocation used inside admin mutations (role change, deletion): the primary
 * action must succeed even if shared storage is briefly unavailable. The
 * fail-closed middleware check plus the bounded revalidator still catch any
 * session this call could not reach.
 */
async function revokeHeadmasterSessionsBestEffort(params) {
  try {
    return await revokeHeadmasterSessions(params);
  } catch (error) {
    console.error("headmaster best-effort revoke failed:", error.message);
    return 0;
  }
}

// ── Privileged WebSocket lifecycle ───────────────────────────────────────────

// jti → Set<close>; noraUserId → Set<jti>
const localSockets = new Map();
const socketsByUser = new Map();
let subscriberReady = null;

function closeLocalSockets(jtis, noraUserIds) {
  for (const jti of jtis || []) {
    const closers = localSockets.get(jti);
    if (closers) {
      for (const close of closers) {
        try {
          close();
        } catch {
          // Socket already terminating.
        }
      }
    }
  }
  for (const userId of noraUserIds || []) {
    for (const jti of socketsByUser.get(userId) || []) {
      const closers = localSockets.get(jti);
      if (closers) {
        for (const close of closers) {
          try {
            close();
          } catch {
            // Socket already terminating.
          }
        }
      }
    }
  }
}

function handleRevokeMessage(raw) {
  try {
    const message = JSON.parse(raw);
    closeLocalSockets(message.jtis || [], message.noraUserIds || []);
  } catch {
    // Malformed control message — ignore.
  }
}

function ensureSubscriber() {
  if (!subscriberReady) {
    subscriberReady = (async () => {
      redisSubscriber = createRedisClient(IORedis, process.env, { maxRetriesPerRequest: 2 });
      await redisSubscriber.subscribe(REVOKE_CHANNEL);
      redisSubscriber.on("message", (_channel, raw) => handleRevokeMessage(raw));
    })();
    subscriberReady.catch(() => {
      subscriberReady = null;
    });
  }
  return subscriberReady;
}

/**
 * Track a privileged connection (logs/exec WebSocket) opened by a
 * headmaster-launched session. Returns an unregister function. The connection
 * is closed immediately when its session is revoked (pub/sub or local), and
 * re-checked every REVALIDATE_SECONDS as a bounded-delay backstop.
 */
async function registerPrivilegedSocket(payload, close) {
  if (!payload || !payload.hm || !payload.jti) return () => {};
  await ensureSubscriber();
  const jti = payload.jti;
  const userId = payload.id;
  if (!localSockets.has(jti)) localSockets.set(jti, new Set());
  localSockets.get(jti).add(close);
  if (!socketsByUser.has(userId)) socketsByUser.set(userId, new Set());
  socketsByUser.get(userId).add(jti);

  const interval = setInterval(async () => {
    let alive = false;
    try {
      alive = await sessionExists(jti);
    } catch {
      alive = false; // fail closed
    }
    if (!alive) {
      try {
        close();
      } catch {
        // Already closed.
      }
    }
  }, REVALIDATE_SECONDS * 1000);
  if (typeof interval.unref === "function") interval.unref();

  return () => {
    clearInterval(interval);
    localSockets.get(jti)?.delete(close);
    if (localSockets.get(jti)?.size === 0) localSockets.delete(jti);
    socketsByUser.get(userId)?.delete(jti);
    if (socketsByUser.get(userId)?.size === 0) socketsByUser.delete(userId);
  };
}

/**
 * Upgrade-time guard for headmaster-launched sessions on privileged
 * WebSocket endpoints. Fails closed when storage cannot be reached.
 */
async function assertPrivilegedSocketSession(payload) {
  if (!payload || !payload.hm) return;
  if (!payload.jti) throw httpError(401, "session_invalid", "Session is not valid.");
  if (!(await sessionExists(payload.jti))) {
    throw httpError(401, "session_revoked", "This session has been revoked.");
  }
}

// ── Periodic GCAP-side revalidation ──────────────────────────────────────────

let revalidatorStarted = false;

/**
 * Periodically re-check every active hm session against the Headmaster site.
 * The site endpoint freshly re-verifies the GCAP session and admin role; a
 * dead session, suspended account, or demoted role revokes the Nora session
 * and its live sockets. Bound: REVALIDATE_SECONDS (default 25s, max 120s).
 */
function startSessionRevalidator() {
  if (revalidatorStarted || IS_TEST_ENV) return;
  revalidatorStarted = true;
  const checkUrl = process.env.HEADMASTER_SESSION_CHECK_URL || "";
  const interval = setInterval(async () => {
    if (!checkUrl || !isEnabled()) return;
    let active;
    try {
      active = await scanKeys(getRedis(), "hm:sess:*");
    } catch {
      return; // Storage outage: fail closed paths already handle requests.
    }
    const token = requireS2SToken();
    await Promise.all(
      (active || [])
        .filter((key) => key !== "hm:sess:user")
        .map(async (key) => {
          const jti = key.slice("hm:sess:".length);
          let record;
          try {
            const raw = await getRedis().get(key);
            if (!raw) return;
            record = JSON.parse(raw);
          } catch {
            return;
          }
          try {
            const response = await fetch(checkUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({ gcapSessionId: record.s, gcapUserId: record.g }),
              signal: AbortSignal.timeout(10000),
            });
            if (response.ok) {
              const data = await response.json().catch(() => ({}));
              if (data && data.active === true) {
                await getRedis().set(
                  key,
                  JSON.stringify({ ...record, checked: Date.now() }),
                  "KEEPTTL",
                );
                return;
              }
            }
            await revokeHeadmasterSessions({
              gcapUserId: record.g,
              reason: `revalidation_failed_${response.status}`,
            });
          } catch (error) {
            // Authorization service unreachable: fail closed rather than
            // silently extending trust.
            console.error("headmaster revalidation error:", error.message);
            await revokeHeadmasterSessions({ gcapUserId: record.g, reason: "revalidation_error" });
          }
        }),
    );
  }, REVALIDATE_SECONDS * 1000);
  if (typeof interval.unref === "function") interval.unref();
}

// ── Session issuance (cookie + JWT) ──────────────────────────────────────────

async function issueHeadmasterSession(res, req, identity) {
  const { rows } = await db.query("SELECT id, email, role FROM users WHERE id = $1", [
    identity.noraUserId,
  ]);
  const user = rows[0];
  if (!user || user.role !== "admin") {
    throw httpError(403, "nora_user_not_admin", "The linked LPanel account is not an administrator.");
  }
  const jti = await createHeadmasterSession({
    gcapUserId: identity.gcapUserId,
    gcapSessionId: identity.gcapSessionId,
    noraUserId: user.id,
    email: user.email,
    role: user.role,
  });
  const token = jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      hm: 1,
      sid: identity.gcapSessionId,
      gcu: identity.gcapUserId,
      jti,
    },
    process.env.JWT_SECRET,
    { expiresIn: SESSION_TTL_SECONDS, algorithm: "HS256" },
  );
  // Cross-site iframe context: SameSite=None (+Partitioned for browsers that
  // gate third-party cookies) and always Secure behind HTTPS.
  const isSecure =
    process.env.NORA_FORCE_SECURE_COOKIES === "1" ||
    Boolean(req?.secure) ||
    req?.headers?.["x-forwarded-proto"] === "https";
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isSecure,
    sameSite: "none",
    partitioned: isSecure,
    path: "/",
    maxAge: AUTH_COOKIE_MAX_AGE_MS,
  });
  return { user, jti };
}

/** Set (and read) the short-lived browser-binding cookie for the launch exchange. */
function setLaunchBrowserCookie(res, nonce) {
  res.cookie("hm_launch_browser", nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    partitioned: true,
    path: "/",
    maxAge: 5 * 60 * 1000,
  });
}

function readLaunchBrowserCookie(req) {
  const cookies = String(req.headers?.cookie || "")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce((acc, entry) => {
      const sep = entry.indexOf("=");
      if (sep !== -1)
        acc[entry.slice(0, sep).trim()] = decodeURIComponent(entry.slice(sep + 1).trim());
      return acc;
    }, {});
  return cookies.hm_launch_browser || null;
}

async function init() {
  await ensureSchema();
  await ensureSubscriber();
  startSessionRevalidator();
}

module.exports = {
  isEnabled,
  scanKeys,
  isExactHttpsOrigin,
  assertParentOrigin,
  configuredParentOrigin,
  requireS2SToken,
  timingSafeEqual,
  sha256Hex,
  CODE_PATTERN,
  BROWSER_NONCE_PATTERN,
  REVALIDATE_SECONDS,
  parseRevalidateSeconds,
  ensureSchema,
  listHeadmasterLinks,
  createHeadmasterLink,
  removeHeadmasterLink,
  resolveHeadmasterLink,
  createLaunchCode,
  consumeLaunchCode,
  createHeadmasterSession,
  sessionExists,
  revokeHeadmasterSessions,
  registerPrivilegedSocket,
  assertPrivilegedSocketSession,
  revokeHeadmasterSessionsBestEffort,
  issueHeadmasterSession,
  setLaunchBrowserCookie,
  readLaunchBrowserCookie,
  audit,
  init,
  httpError,
};
