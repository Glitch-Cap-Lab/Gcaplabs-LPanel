// @ts-nocheck
// Server-side revocation for password/OAuth control-plane sessions.
//
// Every session JWT minted by /auth/login and /auth/oauth-login carries the
// user's current `users.session_version` as the `sv` claim. Logout, password
// change, role change (demotion), and an admin "sign out everywhere" bump the
// column, which invalidates every token minted before the bump. The auth
// middleware also rejects a token whose role no longer matches the stored
// role, so a demoted admin's old token cannot keep admin powers.
//
// Tokens minted before this claim existed carry no `sv`; they are still
// accepted until their 7-day expiry so a deploy does not log everyone out.

const SESSION_VERSION_CLAIM = "sv";

function normalizeVersion(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * Build the JWT payload for a full login session.
 */
function buildSessionPayload(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    [SESSION_VERSION_CLAIM]: normalizeVersion(user.session_version),
  };
}

/**
 * Decide whether a verified session payload is still valid against the
 * stored user row. Pure; the caller fetches the row.
 *
 * @returns {{ok: true} | {ok: false, code: string}}
 */
function evaluateSessionAgainstUser(payload, userRow) {
  if (!payload || !Object.prototype.hasOwnProperty.call(payload, SESSION_VERSION_CLAIM)) {
    return { ok: true };
  }
  if (!userRow) return { ok: false, code: "session_revoked" };
  if (normalizeVersion(payload[SESSION_VERSION_CLAIM]) !== normalizeVersion(userRow.session_version)) {
    return { ok: false, code: "session_revoked" };
  }
  if (payload.role !== userRow.role) return { ok: false, code: "session_revoked" };
  return { ok: true };
}

/**
 * Check a verified payload against the database. Fails closed (`unavailable`)
 * when the lookup errors.
 */
async function checkSession(db, payload) {
  if (!payload || !Object.prototype.hasOwnProperty.call(payload, SESSION_VERSION_CLAIM)) {
    return { ok: true };
  }
  let row;
  try {
    const result = await db.query("SELECT role, session_version FROM users WHERE id = $1", [
      payload.id,
    ]);
    row = result?.rows?.[0] || null;
  } catch {
    return { ok: false, code: "session_check_unavailable" };
  }
  return evaluateSessionAgainstUser(payload, row);
}

/**
 * Invalidate every outstanding versioned session for one user. Atomic
 * increment, so concurrent revocations never lose a bump.
 */
async function revokeUserSessions(db, userId) {
  if (!userId) return null;
  const result = await db.query(
    "UPDATE users SET session_version = COALESCE(session_version, 0) + 1 WHERE id = $1 RETURNING session_version",
    [userId],
  );
  return result?.rows?.[0]?.session_version ?? null;
}

module.exports = {
  SESSION_VERSION_CLAIM,
  buildSessionPayload,
  checkSession,
  evaluateSessionAgainstUser,
  revokeUserSessions,
};
