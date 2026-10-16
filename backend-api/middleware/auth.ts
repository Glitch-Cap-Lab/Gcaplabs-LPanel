// @ts-nocheck
const jwt = require("jsonwebtoken");
const { readAuthCookie, extractSessionTokenFromUpgrade } = require("../authCookie");

// Session and API-key authentication

function headerValues(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return values.map((entry) => String(entry).trim()).filter(Boolean);
}

/**
 * Parse explicit Bearer and API-key headers, rejecting malformed or conflicting credentials.
 * Cookie fallback is intentionally handled only after this result is accepted.
 *
 * @param {Object} req - Express request.
 * @returns {Object} Parsed token and source, or a fail-closed error code.
 */
function extractExplicitAuth(req) {
  const hasAuthorization = Object.prototype.hasOwnProperty.call(req.headers || {}, "authorization");
  const authorizationValues = headerValues(req.headers?.authorization);
  if (hasAuthorization && authorizationValues.length !== 1) {
    return { error: "invalid_auth_header" };
  }

  let authorizationToken = null;
  if (authorizationValues.length === 1) {
    const match = authorizationValues[0].match(/^Bearer\s+(\S+)$/i);
    if (!match) return { error: "invalid_auth_header" };
    authorizationToken = match[1];
  }

  const apiKeyValues = [
    ...headerValues(req.headers?.["x-api-key"]),
    ...headerValues(req.headers?.["x-nora-api-key"]),
  ];
  const hasApiKeyHeader = ["x-api-key", "x-nora-api-key"].some((name) =>
    Object.prototype.hasOwnProperty.call(req.headers || {}, name),
  );
  if (hasApiKeyHeader && apiKeyValues.length === 0) {
    return { error: "invalid_auth_header" };
  }
  const uniqueApiKeys = [...new Set(apiKeyValues)];
  if (uniqueApiKeys.length > 1) {
    return { error: "conflicting_auth" };
  }

  const apiKeyToken = uniqueApiKeys[0] || null;
  if (authorizationToken && apiKeyToken && authorizationToken !== apiKeyToken) {
    return { error: "conflicting_auth" };
  }

  if (authorizationToken) {
    return { token: authorizationToken, source: "authorization" };
  }
  if (apiKeyToken) {
    return { token: apiKeyToken, source: "api_key_header" };
  }
  return { token: null, source: null };
}

/**
 * Whether a verified JWT payload is a full login session. Scoped tokens that
 * share the signing secret (gateway/embed relay tokens carry `scope` and
 * `agentId`) are limited credentials and must never be accepted as sessions.
 *
 * @param {Object} payload - Verified JWT payload.
 * @returns {boolean} True only for session-shaped payloads.
 */
function isSessionTokenPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if (payload.scope !== undefined || payload.agentId !== undefined || payload.typ !== undefined) {
    return false;
  }
  return typeof payload.id === "string" && Boolean(payload.id);
}

function tryDecodeSession(token) {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    return isSessionTokenPayload(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Run the same per-request session checks as authenticateToken for a
 * WebSocket session: Headmaster-launched sessions must still exist, and
 * password/OAuth sessions must match the stored session version and role.
 * Fails closed (503) when the check cannot reach its storage. Used at
 * upgrade time and again on every periodic socket re-check.
 *
 * @param {Object} payload - Verified session JWT payload.
 * @returns {Promise<{ok: true, actor: Object} | {ok: false, status: number, code: string}>}
 *   `actor` carries the role read from the users row for password/OAuth sessions.
 */
async function checkSocketSession(payload) {
  if (!isSessionTokenPayload(payload)) return { ok: false, status: 401, code: "session_invalid" };
  // JWT verification covers expiry at upgrade time; established sockets retain
  // the decoded payload, so every periodic check must enforce the same bound.
  if (payload.exp !== undefined &&
      (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) ||
       payload.exp <= Math.floor(Date.now() / 1000))) {
    return { ok: false, status: 401, code: "session_revoked" };
  }
  if (payload.hm) {
    try {
      await require("../headmasterLaunch").assertPrivilegedSocketSession(payload);
    } catch (error) {
      const status = error?.statusCode === 503 ? 503 : 401;
      return { ok: false, status, code: error?.code || "session_revoked" };
    }
    return { ok: true, actor: payload };
  }
  const { checkSession } = require("../sessionVersion");
  const verdict = await checkSession(require("../db"), payload);
  if (!verdict.ok) {
    return {
      ok: false,
      status: verdict.code === "session_check_unavailable" ? 503 : 401,
      code: verdict.code,
    };
  }
  return { ok: true, actor: { ...payload, role: verdict.role ?? payload.role } };
}

/**
 * Authenticate a WebSocket upgrade with the session cookie (or legacy
 * `?token=`), applying checkSocketSession. On failure the upgrade is refused
 * with 401 (or 503 when the check is unavailable) and the socket destroyed.
 *
 * The session check is async, and nothing else listens for socket errors
 * until `ws` takes the socket over, so a client reset during the lookup would
 * be an uncaught error. A guard destroys the socket on error until the caller
 * calls `release()` right after `handleUpgrade`.
 *
 * @param {Object} request - HTTP upgrade request.
 * @param {Object} socket - Raw upgrade socket.
 * @param {URLSearchParams} searchParams - Parsed upgrade query string.
 * @returns {Promise<{actor: Object, release: Function}|null>} The authorized
 *   actor and the guard release, or null when refused.
 */
async function authenticateSocketUpgrade(request, socket, searchParams) {
  const onError = () => socket.destroy();
  socket.on?.("error", onError);
  const payload = tryDecodeSession(extractSessionTokenFromUpgrade(request, searchParams));
  const verdict = payload ? await checkSocketSession(payload) : { ok: false, status: 401 };
  // The client may have gone away during the lookup; nothing to upgrade.
  if (socket.destroyed) return null;
  if (verdict.ok) {
    return { actor: verdict.actor, release: () => socket.removeListener?.("error", onError) };
  }
  socket.write(
    verdict.status === 503
      ? "HTTP/1.1 503 Service Unavailable\r\n\r\n"
      : "HTTP/1.1 401 Unauthorized\r\n\r\n",
  );
  socket.destroy();
  return null;
}

/**
 * Authenticate an HS256 session or workspace API key and attach its actor,
 * key metadata, scopes, and workspace binding for downstream authorization.
 *
 * @param {Object} req - Express request to authenticate.
 * @param {Object} res - Express response used for authentication failures.
 * @param {Function} next - Continuation invoked for valid credentials.
 * @returns {Promise} Resolves after authentication or an error response.
 */
async function authenticateToken(req, res, next) {
  const explicit = extractExplicitAuth(req);
  if (explicit.error === "conflicting_auth") {
    return res.status(400).json({
      error: "Conflicting authentication headers",
      code: "conflicting_auth",
    });
  }
  if (explicit.error === "invalid_auth_header") {
    return res.status(400).json({
      error: "Invalid authentication header",
      code: "invalid_auth_header",
    });
  }

  // Explicit Authorization/API-key headers always win over the browser cookie.
  // Otherwise a caller could attach a restricted API key to an authenticated
  // browser request and silently inherit the cookie's broader session powers.
  const token = explicit.token || readAuthCookie(req);
  const tokenSource = explicit.source || (token ? "cookie" : null);
  if (token && tokenSource !== "api_key_header" && !token.startsWith("nora_")) {
    const decoded = tryDecodeSession(token);
    if (decoded) {
      // Headmaster-launched sessions are tracked server-side: logout, account
      // switch, suspension, demotion, and link removal revoke them. The check
      // fails closed when shared storage cannot be reached.
      if (decoded.hm && decoded.jti) {
        const headmasterLaunch = require("../headmasterLaunch");
        if (!(await headmasterLaunch.sessionExists(decoded.jti))) {
          return res
            .status(401)
            .json({ error: "Session has been revoked", code: "session_revoked" });
        }
      }
      // Password/OAuth sessions carry a session version: logout, password
      // change, role change and admin sign-out bump it server-side.
      if (!decoded.hm) {
        const { checkSession } = require("../sessionVersion");
        const verdict = await checkSession(require("../db"), decoded);
        if (!verdict.ok) {
          if (verdict.code === "session_check_unavailable") {
            return res.status(503).json({ error: "Session check unavailable", code: verdict.code });
          }
          return res
            .status(401)
            .json({ error: "Session has been revoked", code: "session_revoked" });
        }
      }
      req.user = decoded;
      return next();
    }
    return res.status(401).json({ error: "Invalid or expired session" });
  }

  // Bearer tokens with the nora_ prefix and explicit API-key headers use the
  // workspace API-key verifier. Cookies are never allowed to override them.
  const rawKey = tokenSource === "api_key_header" || token?.startsWith("nora_") ? token : null;
  if (rawKey) {
    try {
      const { verifyApiKey } = require("../apiKeys");
      const verified = await verifyApiKey(rawKey);
      if (verified) {
        req.user = verified.user
          ? {
              id: verified.user.id,
              email: verified.user.email,
              role: verified.user.role || "user",
              name: verified.user.name,
              authMethod: "api_key",
            }
          : { id: null, email: null, role: "user", authMethod: "api_key" };
        req.apiKey = verified.key;
        req.apiKeyWorkspace = verified.workspace;
        return next();
      }
    } catch (error) {
      console.error("API key verification failed:", error.message);
    }
    return res.status(401).json({ error: "Invalid or expired API key" });
  }

  return res.status(401).json({ error: "Authentication required" });
}

// Authorization guards

/**
 * Require the authenticated actor's platform role to be `admin`. This does not
 * exclude API keys; combine it with `requireSession` for session-only surfaces.
 *
 * @param {Object} req - Authenticated Express request.
 * @param {Object} res - Express response.
 * @param {Function} next - Continuation invoked for platform admins.
 * @returns {void}
 */
function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

/**
 * Build a route guard that enforces one scope for API keys while allowing
 * session-authenticated requests to continue to their role guards.
 *
 * @param {string} requiredScope - Scope required from API-key callers.
 * @returns {Function} Express authorization middleware.
 */
function requireScope(requiredScope) {
  return (req, res, next) => {
    if (!req.apiKey) return next();
    const scopes = Array.isArray(req.apiKey.scopes) ? req.apiKey.scopes : [];
    if (!scopes.includes(requiredScope)) {
      return res.status(403).json({
        error: `API key is missing the "${requiredScope}" scope`,
        code: "missing_scope",
      });
    }
    next();
  };
}

/**
 * Build a method-aware API-key guard; a null read or write scope makes that
 * method class session-only while session callers continue normally.
 *
 * @param {string|null} readScope - Scope for GET, HEAD, and OPTIONS requests.
 * @param {string|null} writeScope - Scope for all mutating methods.
 * @returns {Function} Express authorization middleware.
 */
function scopeByMethod(readScope, writeScope) {
  return (req, res, next) => {
    if (!req.apiKey) return next();
    const isRead = ["GET", "HEAD", "OPTIONS"].includes(req.method);
    const required = isRead ? readScope : writeScope;
    if (!required) {
      return res.status(403).json({
        error: "This endpoint requires session authentication",
        code: "session_required",
      });
    }
    const scopes = Array.isArray(req.apiKey.scopes) ? req.apiKey.scopes : [];
    if (!scopes.includes(required)) {
      return res.status(403).json({
        error: `API key is missing the "${required}" scope`,
        code: "missing_scope",
      });
    }
    next();
  };
}

/**
 * Reject API-key-authenticated requests from a session-only route.
 *
 * @param {Object} req - Authenticated Express request.
 * @param {Object} res - Express response.
 * @param {Function} next - Continuation invoked for session callers.
 * @returns {void}
 */
function requireSession(req, res, next) {
  if (req.apiKey) {
    return res.status(403).json({
      error: "This endpoint requires session authentication",
      code: "session_required",
    });
  }
  next();
}

module.exports = {
  authenticateSocketUpgrade,
  authenticateToken,
  checkSocketSession,
  extractExplicitAuth,
  isSessionTokenPayload,
  requireAdmin,
  requireScope,
  requireSession,
  scopeByMethod,
};
