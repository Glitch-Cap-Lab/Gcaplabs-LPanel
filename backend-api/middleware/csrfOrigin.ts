// @ts-nocheck
// Origin gate for cookie-authenticated, state-changing requests (CSRF defence).
//
// The browser session lives in the HttpOnly `nora_auth` cookie (SameSite=Lax).
// SameSite already blocks most cross-site subresource requests, but it is a
// single browser-side control and does not cover same-site sibling origins or
// older clients, so every cookie-authenticated mutation must also prove it came
// from one of our own origins: `Origin` must match the configured allow-list
// (CORS_ORIGINS), with `Referer` as the fallback when a client omits `Origin`.
// A cookie mutation that carries neither is refused.
//
// Not gated, by design:
//   - safe methods (GET, HEAD, OPTIONS);
//   - requests with no session cookie (nothing ambient to forge; this includes
//     login and signup);
//   - requests with an explicit Authorization or API-key header. The auth wall
//     already lets those win over the cookie, and a cross-site page cannot set
//     them without a CORS preflight that the allow-list refuses;
//   - server-to-server and provider-signed routes that never use the cookie
//     (see DEFAULT_EXEMPT_PREFIXES).

const { readAuthCookie } = require("../authCookie");

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Path prefixes (matched on a segment boundary) that authenticate by signature
// or shared secret rather than the browser session.
const DEFAULT_EXEMPT_PREFIXES = Object.freeze([
  "/stripe/webhook",
  "/webhooks/",
  "/internal/",
  "/integrations/headmaster",
  "/demo-llm",
]);

function normalizeOrigin(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null") return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

function hasExplicitCredential(headers = {}) {
  return ["authorization", "x-api-key", "x-nora-api-key"].some((name) =>
    Object.prototype.hasOwnProperty.call(headers, name),
  );
}

function isExemptPath(path, prefixes) {
  return prefixes.some((prefix) =>
    prefix.endsWith("/")
      ? path.startsWith(prefix)
      : path === prefix || path.startsWith(`${prefix}/`),
  );
}

/**
 * Build the Express middleware.
 *
 * @param {Object} options
 * @param {string[]} options.allowedOrigins - Allowed origins (same list as CORS).
 * @param {string[]} [options.exemptPrefixes] - Paths that skip the gate.
 * @returns {Function} Express middleware.
 */
function createCsrfOriginGate({ allowedOrigins = [], exemptPrefixes = DEFAULT_EXEMPT_PREFIXES } = {}) {
  const allowed = new Set(allowedOrigins.map(normalizeOrigin).filter(Boolean));
  return function csrfOriginGate(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();
    if (hasExplicitCredential(req.headers)) return next();
    if (!readAuthCookie(req)) return next();
    if (isExemptPath(String(req.path || req.url || ""), exemptPrefixes)) return next();

    const origin = req.headers?.origin;
    const source = origin !== undefined ? normalizeOrigin(origin) : normalizeOrigin(req.headers?.referer);
    if (source && allowed.has(source)) return next();
    return res.status(403).json({
      error: "Cross-origin request refused",
      code: "csrf_origin_rejected",
    });
  };
}

module.exports = { createCsrfOriginGate, DEFAULT_EXEMPT_PREFIXES };
