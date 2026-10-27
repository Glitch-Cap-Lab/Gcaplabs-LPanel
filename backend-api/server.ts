// @ts-nocheck
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");

const db = require("./db");
const billing = require("./billing");
const channels = require("./channels");
const agentHubStore = require("./agentHubStore");
const integrations = require("./integrations");
const snapshots = require("./snapshots");
const {
  getDeploymentDefaults,
  getLanguageSettings,
  getSystemBanner,
} = require("./platformSettings");
const { buildReleaseInfo } = require("./releaseInfo");
const { collectAgentTelemetrySample } = require("./agentTelemetry");
const {
  collectBackgroundTelemetry,
  reconcileBackgroundAgentStatuses,
  reconcileExternalAgentStatuses,
} = require("./backgroundTasks");
const agentBudgets = require("./agentBudgets");
const agentSchedules = require("./agentSchedules");
const { createDeletionClient } = require("./headmasterAccountDeletions");
const { addScheduleRunJob } = require("./redisQueue");
// OpenTelemetry GenAI exporter — self-initializes on require (no-op unless
// NORA_OTEL_ENABLED=true; fail-open). Wrapped so even a module load/parse error
// (e.g. a corrupted dependency) disables OTel rather than crashing boot — the
// init() try/catch only covers runtime errors, not require-time failures.
let otel;
try {
  otel = require("./otel");
} catch (otelErr) {
  console.warn(`[otel] module load failed — telemetry disabled: ${otelErr?.message || otelErr}`);
  otel = { isEnabled: () => false, shutdown: async () => {} };
}
const { listKubernetesExecutionTargets } = require("./kubernetesClusters");
const { STARTER_TEMPLATES } = require("./starterTemplates");
const {
  allowsFirstAdminSignupClaim,
  getBootstrapAdminSeedConfig,
  isSignupEnabled,
} = require("./bootstrapAdmin");
const { ensureFirstRegisteredUserIsAdmin } = require("./ensureAdminUser");
const { authenticateToken, isSessionTokenPayload } = require("./middleware/auth");
const { checkGatewayEmbedSession } = require("./gatewayEmbedSession");
const {
  buildAccessibleAgentQuery,
  requireApiKeyAgentPathScope,
  roleSatisfies,
} = require("./middleware/ownership");
const { AppError, correlationId, errorHandler } = require("./middleware/errorHandler");
const {
  createGatewayRouter,
  attachGatewayWS,
  resolveSafeGatewayHttpTarget,
  resolveSafeHermesDashboardTarget,
} = require("./gatewayProxy");
const { isGatewayAvailableStatus } = require("./agentStatus");
const {
  isBackendEnabled,
  enabledAdminSurfaces,
  requireSandboxProfileEnabled,
} = require("./middleware/backendGate");
const { assertRemoteHostAgentUse, toPublicRemoteHostAuthorizationError } = require("./remoteHosts");
const { repairHermesAgentConfig } = require("./hermesUi");
const { HERMES_EMBED_AGENT_COLUMNS, GATEWAY_EMBED_AGENT_COLUMNS } = require("./embedAgentColumns");
const { establishHermesDashboardSession, needsHermesLogin } = require("./hermesDashboardSession");
const { decrypt: decryptSecret } = require("./crypto");
const {
  joinHttpUrl,
  hasGatewayEndpoint,
  hasHermesDashboardEndpoint,
} = require("../agent-runtime/lib/agentEndpoints");
const {
  getBackendCatalog,
  getDefaultBackend,
  getDefaultDeployTarget,
  getDefaultRuntimeFamily,
  getDefaultSandboxProfile,
  getEnabledBackends,
  getEnabledDeployTargets,
  getEnabledSandboxProfiles,
  getExecutionTargetCatalog,
  getRuntimeCatalog,
  getRuntimeSelectionStatus,
  getSandboxProfileCatalog,
} = require("../agent-runtime/lib/backendCatalog");

// ─── JWT Secret ───────────────────────────────────────────────────
const IS_TEST_ENV = process.env.NODE_ENV === "test" || !!process.env.JEST_WORKER_ID;
const { looksLikePlaceholderSecret } = require("./lib/secretValidation");
const { runVersionedMigrations } = require("./lib/migrationRunner");
const { loadMigrationFiles } = require("./lib/migrationFiles");
const MIN_JWT_SECRET_LENGTH = 32;
// When a dev boot generated an ephemeral JWT secret, we persist/restore it via
// platform_settings after the DB is up so sessions survive restarts (dev only;
// production refuses to boot without an explicit secret).
let usedEphemeralJwtSecret = false;
if (!process.env.JWT_SECRET) {
  if (IS_TEST_ENV) {
    process.env.JWT_SECRET = "secret";
  } else if (process.env.NODE_ENV === "production") {
    console.error(
      "FATAL: JWT_SECRET must be set in production. Refusing to start with an ephemeral secret.",
    );
    process.exit(1);
  } else {
    console.warn(
      "SECURITY WARNING: JWT_SECRET not configured. Using a generated dev secret (persisted in the database so sessions survive restarts). Set JWT_SECRET in .env for real deployments.",
    );
    process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
    usedEphemeralJwtSecret = true;
  }
} else if (!IS_TEST_ENV && process.env.JWT_SECRET.length < MIN_JWT_SECRET_LENGTH) {
  // A short JWT_SECRET is brute-forceable offline given any signed token. Fail
  // closed rather than silently accept a weak production secret. We
  // deliberately do NOT log the observed length — even a length is a useful
  // bit for an attacker reading process logs, and CodeQL flags the dataflow.
  console.error(
    `FATAL: JWT_SECRET is shorter than the minimum of ${MIN_JWT_SECRET_LENGTH} characters. Generate a stronger one (e.g. node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") and restart.`,
  );
  process.exit(1);
} else if (!IS_TEST_ENV && looksLikePlaceholderSecret(process.env.JWT_SECRET)) {
  // Placeholder-looking secrets (your_*, changeme, <REPLACE_...>, "test-...")
  // mean the operator never edited .env.example. Tokens signed with a guessable
  // secret are forgeable, so refuse in production; warn loudly in dev.
  if (process.env.NODE_ENV === "production") {
    console.error(
      "FATAL: JWT_SECRET looks like a placeholder value. Generate a real secret and restart.",
    );
    process.exit(1);
  }
  console.warn("SECURITY WARNING: JWT_SECRET looks like a placeholder value — replace it in .env.");
}

// ─── Encryption key (credentials at rest) ─────────────────────────
// crypto.ts already warns when ENCRYPTION_KEY is missing/invalid and blocks new
// secret writes. In production that soft failure becomes a refusal to boot:
// running a control plane that cannot encrypt integration credentials is a
// footgun. NORA_ALLOW_PLAINTEXT_SECRETS=true is the explicit operator override
// (e.g. air-gapped throwaway demos).
{
  const { isEncryptionConfigured } = require("./crypto");
  if (
    !IS_TEST_ENV &&
    process.env.NODE_ENV === "production" &&
    !isEncryptionConfigured() &&
    process.env.NORA_ALLOW_PLAINTEXT_SECRETS !== "true"
  ) {
    console.error(
      "FATAL: ENCRYPTION_KEY is not set (or is not a 64-char hex key) in production. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" " +
        "and set it in .env. To intentionally run without encryption at rest, set NORA_ALLOW_PLAINTEXT_SECRETS=true.",
    );
    process.exit(1);
  }
}

// ─── Redis authentication ─────────────────────────────────────────
if (!IS_TEST_ENV) require("./lib/connectionConfig").enforceRedisAuth();

// ─── App Setup ────────────────────────────────────────────────────
const app = express();
const EMBED_SESSION_TTL_MS = 15 * 60 * 1000;
const EMBED_SESSION_COOKIE_PREFIX = "__nora_gateway_embed_";
const HERMES_EMBED_SESSION_COOKIE_PREFIX = "__nora_hermes_embed_";
const HERMES_DASHBOARD_TOKEN_COOKIE_PREFIX = "__nora_hermes_dashboard_token_";
const EMBED_CONTENT_SECURITY_POLICY = [
  "default-src 'self' data: blob: https:",
  "base-uri 'self'",
  "font-src 'self' data: https:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https:",
  "connect-src 'self' ws: wss: http: https:",
  "worker-src 'self' blob:",
  "frame-ancestors 'self'",
  "form-action 'self'",
].join("; ");

app.set("trust proxy", 1);
app.use(helmet());

function requestProtocol(req) {
  const forwarded = req.headers["x-forwarded-proto"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0 && forwarded[0].trim()) {
    return forwarded[0].split(",")[0].trim();
  }
  return req.protocol;
}

// Whether to set the Secure flag on session cookies. Defaults to "only when
// the inbound request was HTTPS" so local-dev over plain HTTP keeps working.
// Operators running always-on TLS (PaaS, public-domain deployments) should set
// NORA_FORCE_SECURE_COOKIES=1 so cookies are never emitted over cleartext even
// if a proxy regression strips `X-Forwarded-Proto`.
function cookieSecureFlag(req) {
  if (process.env.NORA_FORCE_SECURE_COOKIES === "1") return true;
  return requestProtocol(req) === "https";
}

function getEmbedSessionCookieName(agentId, prefix = EMBED_SESSION_COOKIE_PREFIX) {
  return `${prefix}${agentId}`;
}

function parseCookieHeader(cookieHeader) {
  if (!cookieHeader) return {};
  return cookieHeader
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce((cookies, entry) => {
      const sep = entry.indexOf("=");
      if (sep === -1) return cookies;
      const key = entry.slice(0, sep).trim();
      const value = entry.slice(sep + 1).trim();
      try {
        cookies[key] = decodeURIComponent(value);
      } catch {
        cookies[key] = value;
      }
      return cookies;
    }, {});
}

function buildForwardedSearch(req) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query || {})) {
    if (key === "token" || value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  const str = params.toString();
  return str ? `?${str}` : "";
}

/**
 * Build the browser bootstrap that redirects gateway WebSockets through Nora
 * and performs gateway-password login without placing the user JWT in URLs.
 *
 * @param {Object} context - Agent id, public request origin, and gateway token.
 * @returns {string} JavaScript injected into the embedded gateway UI.
 */
function buildEmbedBootstrapScript({ agentId, requestHost, requestScheme, gatewayToken }) {
  const wsProto = requestScheme === "https" ? "wss" : "ws";
  // Intentionally no `?token=` — the WebSocket upgrade is authenticated via
  // the HttpOnly embed session cookie (`__nora_gateway_embed_<agentId>`) that
  // the browser sends automatically on same-origin upgrade requests. Keeping
  // the JWT out of the URL prevents it from surfacing in nginx/access logs,
  // browser history, and DevTools network panels.
  const wsRelayUrl = `${wsProto}://${requestHost}/api/ws/gateway/${agentId}`;
  return `(function(){
  var R=${JSON.stringify(wsRelayUrl)};
  var P=${JSON.stringify(gatewayToken)};
  window.__NORA_EMBED_AUTO_LOGIN__ = true;
  var _WS=window.WebSocket;
  window.WebSocket=function(u,p){return p?new _WS(R,p):new _WS(R)};
  window.WebSocket.prototype=_WS.prototype;
  window.WebSocket.CONNECTING=_WS.CONNECTING;
  window.WebSocket.OPEN=_WS.OPEN;
  window.WebSocket.CLOSING=_WS.CLOSING;
  window.WebSocket.CLOSED=_WS.CLOSED;

  function setPasswordHash() {
    try {
      var nextHash = "password=" + encodeURIComponent(P);
      if (window.location.hash !== "#" + nextHash) {
        window.location.hash = nextHash;
      }
    } catch {}
  }

  function visible(el) {
    if (!el) return false;
    var style = window.getComputedStyle(el);
    if (!style || style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") return false;
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function findLoginButton() {
    var buttons = Array.prototype.slice.call(document.querySelectorAll("button, input[type='submit']"));
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      if (!visible(b) || b.disabled) continue;
      var txt = String((b.innerText || b.textContent || b.value || "")).toLowerCase().trim();
      if (/^login$|^log in$|^sign in$|connect|unlock/.test(txt)) return b;
    }
    return null;
  }

  function findConfirmGatewayUrlButton() {
    var buttons = Array.prototype.slice.call(document.querySelectorAll("button, input[type='submit']"));
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      if (!visible(b) || b.disabled) continue;
      var txt = String((b.innerText || b.textContent || b.value || "")).toLowerCase().trim();
      if (/^confirm$|^continue$|^ok$|^yes$/.test(txt)) return b;
    }
    return null;
  }

  function tryAutoLogin() {
    if (window.__NORA_EMBED_AUTO_LOGIN_DONE__) return true;
    setPasswordHash();

    var pw = document.querySelector("input[type='password'], input[name='password'], input[id*='password']");
    if (pw && visible(pw) && pw.value !== P) {
      pw.focus();
      pw.value = P;
      pw.dispatchEvent(new Event("input", { bubbles: true }));
      pw.dispatchEvent(new Event("change", { bubbles: true }));
    }

    var form = pw && (pw.form || pw.closest("form"));
    if (form && visible(form)) {
      window.__NORA_EMBED_AUTO_LOGIN_DONE__ = true;
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      return true;
    }

    var loginBtn = findLoginButton();
    if (loginBtn) {
      window.__NORA_EMBED_AUTO_LOGIN_DONE__ = true;
      loginBtn.click();
      return true;
    }
    return false;
  }

  function startAutoLogin() {
    if (window.__NORA_EMBED_AUTO_LOGIN_STARTED__) return;
    window.__NORA_EMBED_AUTO_LOGIN_STARTED__ = true;
    setPasswordHash();

    var attempts = 0;
    var maxAttempts = 80;
    var interval = setInterval(function() {
      attempts++;
      if (tryAutoLogin() || attempts >= maxAttempts) {
        clearInterval(interval);
        if (observer) observer.disconnect();
      }
    }, 200);

    var observer = new MutationObserver(function() {
      if (window.__NORA_EMBED_AUTO_LOGIN_DONE__) {
        observer.disconnect();
        clearInterval(interval);
        return;
      }
      tryAutoLogin();
    });
    if (document.documentElement) {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startAutoLogin, { once: true });
  } else {
    startAutoLogin();
  }
})();`;
}

function injectEmbedBootstrapScript(html, agentId) {
  const embedBaseHref = `/api/agents/${encodeURIComponent(agentId)}/gateway/embed/`;
  const bootstrapSrc = `/api/agents/${encodeURIComponent(agentId)}/gateway/embed/bootstrap.js`;
  return html.replace(
    /<head[^>]*>/i,
    (match) => `${match}<base href="${embedBaseHref}"><script src="${bootstrapSrc}"></script>`,
  );
}

function setEmbedHtmlHeaders(res) {
  // OpenClaw's control UI ships an inline theme bootstrap and may load
  // same-origin WebSockets via the injected relay script, so the global
  // Helmet defaults are too strict for the proxied embed document.
  res.removeHeader("Content-Security-Policy");
  res.removeHeader("Content-Security-Policy-Report-Only");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", EMBED_CONTENT_SECURITY_POLICY);
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Vary", "Cookie");
}

function hermesEmbedBasePath(agentId) {
  return `/api/agents/${encodeURIComponent(agentId)}/hermes-ui/embed`;
}

function rewriteHermesEmbedHtml(html, agentId) {
  const embedBase = hermesEmbedBasePath(agentId);
  return html
    .replace(/(["'])\/assets\//g, `$1${embedBase}/assets/`)
    .replace(/(["'])\/fonts\//g, `$1${embedBase}/fonts/`)
    .replace(/(["'])\/favicon\.ico(["'])/g, `$1${embedBase}/favicon.ico$2`);
}

function rewriteHermesEmbedCss(css, agentId) {
  const embedBase = hermesEmbedBasePath(agentId);
  return css.replace(/url\((['"]?)\/fonts\//g, `url($1${embedBase}/fonts/`);
}

function rewriteHermesEmbedJavascript(source, agentId) {
  const embedBase = hermesEmbedBasePath(agentId);
  let rewritten = source
    .replace(/(["'`])\/api\//g, `$1${embedBase}/api/`)
    .replace(/(["'`])\/dashboard-plugins\//g, `$1${embedBase}/dashboard-plugins/`);
  const routerMarker = "jsx($y,{children:";
  if (rewritten.includes(routerMarker)) {
    rewritten = rewritten.replace(
      routerMarker,
      `jsx($y,{basename:${JSON.stringify(embedBase)},children:`,
    );
  }
  const browserRouterName = rewritten.match(
    /function\s+([A-Za-z_$][\w$]*)\(\{basename:[^}]*children:[^}]*window:/,
  )?.[1];
  if (browserRouterName) {
    const routerRenderPattern = new RegExp(
      `(\\.jsx\\(${browserRouterName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},\\{)(children:)`,
      "g",
    );
    rewritten = rewritten.replace(
      routerRenderPattern,
      `$1basename:${JSON.stringify(embedBase)},$2`,
    );
  }
  return rewritten;
}

function setProxyResponseHeaders(res, resp, { cachePolicy = "asset" } = {}) {
  const contentType = resp.headers.get("content-type");
  if (contentType) res.setHeader("Content-Type", contentType);

  const cacheControl = resp.headers.get("cache-control");
  if (cacheControl) {
    res.setHeader("Cache-Control", cacheControl);
  } else if (cachePolicy === "no-store") {
    res.setHeader("Cache-Control", "no-store");
  } else {
    res.setHeader("Cache-Control", "public, max-age=3600");
  }

  res.setHeader("Vary", "Cookie");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

async function lookupEmbedAgent(agentId, userId) {
  // Owner or sharing-workspace member, same as the Hermes lookup below. The
  // OpenClaw callers all demand `editor` (see GATEWAY_EMBED_MIN_WORKSPACE_ROLE)
  // rather than the Hermes per-method split: bootstrap.js hands the browser the
  // decrypted gateway password, and the relay socket it configures is a live
  // chat/terminal channel, so there is no coherent read-only mode to grant.
  const result = await db.query(buildAccessibleAgentQuery(GATEWAY_EMBED_AGENT_COLUMNS), [
    agentId,
    userId,
  ]);
  if (
    !result.rows[0] ||
    !isGatewayAvailableStatus(result.rows[0].status) ||
    !hasGatewayEndpoint(result.rows[0])
  ) {
    return null;
  }
  return result.rows[0];
}

async function lookupHermesEmbedAgent(agentId, userId) {
  // Selects the SSRF-relevant fields (deploy_target / execution_target_id /
  // user_id / gateway_host) the embed proxy's allowlist authorizes against — see
  // embedAgentColumns.ts. Omitting them would mis-route a remote-docker/k8s agent
  // or short-circuit the owner-scoping check.
  //
  // Access mirrors the native Hermes WebUI routes (routes/agents.ts →
  // loadHermesUiAgent → findAccessibleAgent): the agent's owner, plus any member
  // of a workspace the agent is shared into. An owner-only lookup here made the
  // embedded dashboard the one Hermes surface a workspace member could see in
  // the tab bar but never load. `user_id` stays selected because it is the
  // *owner* the remote-host grant check authorizes against — never the caller.
  //
  // effective_role is the caller's highest role across the sharing workspaces;
  // resolveEmbedAccess gates mutating embed requests on it so a viewer cannot
  // reach through the proxy for writes the native panels reserve for editors.
  const result = await db.query(buildAccessibleAgentQuery(HERMES_EMBED_AGENT_COLUMNS), [
    agentId,
    userId,
  ]);
  if (
    !result.rows[0] ||
    !isGatewayAvailableStatus(result.rows[0].status) ||
    !hasHermesDashboardEndpoint(result.rows[0])
  ) {
    return null;
  }
  return result.rows[0];
}

async function fetchAgentForHermesRepair(agentId) {
  const result = await db.query("SELECT * FROM agents WHERE id = $1", [agentId]);
  const row = result.rows[0];
  if (!row || !row.container_id) return null;
  return row;
}

/**
 * Authenticate an embedded UI through a verified JWT or agent-scoped HttpOnly
 * session, verify agent access/runtime availability, and mint the scoped
 * cookie when needed.
 *
 * @param {Object} req - Express embed request.
 * @param {Object} res - Express response used for auth failures and cookies.
 * @param {Object} [options={}] - Scope, cookie, lookup, role, and query-token policy.
 * @returns {Promise<Object|null>} Authorized embed context, or `null` after responding.
 */
async function resolveEmbedAccess(
  req,
  res,
  {
    allowQueryToken = true,
    lookupAgent = lookupEmbedAgent,
    cookiePrefix = EMBED_SESSION_COOKIE_PREFIX,
    scope = "gateway-embed",
    requiredRole = "viewer",
  } = {},
) {
  const jwt = require("jsonwebtoken");
  const { AUTH_COOKIE_NAME } = require("./authCookie");
  const agentId = req.params.agentId;
  const embedCookieName = getEmbedSessionCookieName(agentId, cookiePrefix);
  const cookies = parseCookieHeader(req.headers.cookie || "");
  const cookieToken = cookies[embedCookieName];
  const mainAuthCookie = cookies[AUTH_COOKIE_NAME];
  const queryToken = allowQueryToken && typeof req.query.token === "string" ? req.query.token : "";
  // A full user JWT may arrive either as a ?token= query parameter (legacy,
  // from the iframe src) or as the main HttpOnly nora_auth cookie that
  // same-origin iframe navigations carry automatically. Either minting path
  // yields the same embed-scoped cookie on success.
  const mintingToken = queryToken || mainAuthCookie || "";

  let userId;
  let relayToken;
  let loginSession;

  if (mintingToken) {
    let payload;
    try {
      payload = jwt.verify(mintingToken, process.env.JWT_SECRET, {
        algorithms: ["HS256"],
      });
    } catch {
      res.status(401).send("invalid token");
      return null;
    }
    // Full user JWTs may mint a session for an owned agent. Scoped JWTs are
    // accepted here only when both their scope and agent id match this embed,
    // preventing reuse for a sibling agent.
    if (payload.scope && (payload.scope !== scope || payload.agentId !== agentId)) {
      res.status(401).send("invalid token for this embed");
      return null;
    }
    userId = payload.id;
    loginSession = isSessionTokenPayload(payload) ? payload : payload.session;
  } else if (cookieToken) {
    let payload;
    try {
      payload = jwt.verify(cookieToken, process.env.JWT_SECRET, {
        algorithms: ["HS256"],
      });
    } catch {
      res.status(401).send("invalid embed session");
      return null;
    }
    if (payload.scope !== scope || payload.agentId !== agentId) {
      res.status(401).send("invalid embed session");
      return null;
    }
    userId = payload.id;
    relayToken = cookieToken;
    loginSession = payload.session;
  } else {
    res.status(401).send("embed session required");
    return null;
  }

  // Both embed scopes carry the originating login so logout, password change
  // and admin sign-out end them before the cookie expires.
  const verdict = await checkGatewayEmbedSession({ id: userId, session: loginSession });
  if (!verdict.ok) {
    res
      .status(verdict.status)
      .send(verdict.status === 503 ? "Session check unavailable" : "Session has been revoked");
    return null;
  }
  loginSession = verdict.actor;

  const agent = await lookupAgent(agentId, userId);
  if (!agent) {
    res.status(404).send("agent not found or not running");
    return null;
  }

  // Both lookups that reach here (lookupEmbedAgent, lookupHermesEmbedAgent) go
  // through buildAccessibleAgentQuery, whose CASE and WHERE together guarantee a
  // non-null effective_role on every row it returns. So treat a missing role as
  // a bug and deny, rather than defaulting it to "owner": the default was
  // unreachable, and if a projection ever drops the column it would silently
  // promote every caller to owner-level instead of failing visibly.
  //
  // 403 (not 404) is correct here: the caller already knows the agent exists.
  if (!roleSatisfies(agent.effective_role, requiredRole)) {
    res.status(403).send("insufficient workspace permissions for this agent");
    return null;
  }

  try {
    // Embed sessions and the OpenClaw bootstrap script expose live runtime
    // traffic and, for bootstrap.js, the decrypted gateway password. Re-check
    // the current host grant before minting/accepting an embed session so a
    // stale agent row cannot remain a credential oracle after unshare.
    await assertRemoteHostAgentUse(agent, { includeProfile: false });
  } catch (error) {
    const publicError = toPublicRemoteHostAuthorizationError(error);
    res.status(publicError.statusCode || 503).send(publicError.message);
    return null;
  }

  if (!relayToken) {
    relayToken = jwt.sign(
      {
        id: userId,
        agentId,
        scope,
        session: loginSession,
      },
      process.env.JWT_SECRET,
      { expiresIn: Math.floor(EMBED_SESSION_TTL_MS / 1000), algorithm: "HS256" },
    );
    res.cookie(embedCookieName, relayToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: cookieSecureFlag(req),
      maxAge: EMBED_SESSION_TTL_MS,
      path: "/",
    });
  }

  return { agent, agentId, userId, relayToken };
}

function getEmbeddedGatewayPath(req) {
  const fullPath = `${req.baseUrl || ""}${req.path || ""}`;
  const prefix = `${req.baseUrl || `/agents/${req.params.agentId}/gateway`}/embed`;
  const suffix = fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : "";
  return suffix.replace(/^\/+/, "");
}

function getEmbeddedHermesPath(req) {
  const fullPath = `${req.baseUrl || ""}${req.path || ""}`;
  const prefix = `${req.baseUrl || `/agents/${req.params.agentId}/hermes-ui`}/embed`;
  const suffix = fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : "";
  return suffix.replace(/^\/+/, "");
}

const corsOrigins = (
  process.env.CORS_ORIGINS ||
  process.env.NEXTAUTH_URL ||
  "http://localhost:8080"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors({ origin: corsOrigins }));
// Cookie-authenticated mutations must come from an allowed origin (CSRF gate).
app.use(require("./middleware/csrfOrigin").createCsrfOriginGate({ allowedOrigins: corsOrigins }));

// Rate-limit caps are env-overridable so CI/E2E — where the whole Playwright
// suite hits the API from a single localhost IP — can raise them without
// disabling abuse protection. Production keeps the defaults below. Mirrors the
// helper in routes/auth.ts (which already exposes AUTH_/SIGNUP_ overrides).
function parsePositiveIntegerEnv(name, fallback) {
  const raw = String(process.env[name] || "").trim();
  if (!/^[1-9]\d*$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

const globalLimiter = rateLimit({
  windowMs: parsePositiveIntegerEnv("GLOBAL_RATE_LIMIT_WINDOW_MS", 15 * 60 * 1000),
  max: parsePositiveIntegerEnv("GLOBAL_RATE_LIMIT_MAX", 1000),
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

// State-changing operations (POST/PUT/PATCH/DELETE) get a tighter per-IP cap
// on top of the global limit. The global limiter is generous so that chatty
// read traffic doesn't get throttled; the mutation limiter is where the real
// abuse protection lives — a leaked JWT cannot be used to spam destructive
// calls (delete/restart/stop, admin writes, billing changes, channel mutations)
// at more than 60 per minute from a single IP. Safe methods are skipped so
// normal browsing is unaffected.
const mutationLimiter = rateLimit({
  windowMs: parsePositiveIntegerEnv("MUTATION_RATE_LIMIT_WINDOW_MS", 60 * 1000),
  max: parsePositiveIntegerEnv("MUTATION_RATE_LIMIT_MAX", 60),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down" },
  // Skip in tests: the unit suites fire far more than 60 mutations/min from a
  // single IP, and the global limiter is not what they exercise (the signup
  // limiter has its own dedicated test). Fully active outside test environments.
  skip: (req) =>
    IS_TEST_ENV || req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS",
});
app.use(mutationLimiter);

// Stripe webhook needs raw body — must come before express.json(). Correlation
// applies before parsing so signed-webhook and JSON-parser failures share it.
app.use(correlationId);
async function stripeWebhookHandler(req, res, next) {
  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(500).json({ error: "Webhook secret not configured" });
  try {
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    await billing.handleWebhookEvent(event);
    res.json({ received: true });
  } catch (e) {
    const error = new AppError("Webhook could not be processed", 400, "WEBHOOK_FAILED");
    error.cause = e;
    next(error);
  }
}
if (billing.BILLING_ENABLED) {
  app.post("/stripe/webhook", express.raw({ type: "application/json" }), stripeWebhookHandler);
}

app.use(
  express.json({
    limit: "1mb",
    // Inbound channel webhooks are signed over the exact bytes sent.
    verify: (req, _res, buf) => {
      if (String(req.originalUrl || req.url || "").startsWith("/webhooks/")) req.rawBody = buf;
    },
  }),
);
app.use(require("./middleware/requestMetrics"));

// ─── Public Routes ────────────────────────────────────────────────

let _startupComplete = IS_TEST_ENV;
app.get("/health", (req, res) => {
  if (!_startupComplete) return res.status(503).json({ status: "starting" });
  res.json({ status: "ok" });
});

function enabledDeployTargetsFromExecutionTargets(executionTargets = []) {
  const enabled = new Set(getEnabledDeployTargets().filter((target) => target !== "k8s"));
  for (const target of executionTargets) {
    if (target?.enabled) {
      enabled.add(target.deployTarget || String(target.id || "").split(":")[0]);
    }
  }
  return Array.from(enabled).filter(Boolean);
}

function defaultExecutionTargetFromCatalog(executionTargets = []) {
  return (
    executionTargets.find(
      (target) =>
        target.isDefault && target.available && String(target.id || "").startsWith("k8s:"),
    )?.id ||
    executionTargets.find((target) => target.isDefault && target.available)?.id ||
    executionTargets.find((target) => target.available)?.id ||
    executionTargets[0]?.id ||
    getDefaultDeployTarget()
  );
}

function localDockerDemoCapability() {
  const status = getRuntimeSelectionStatus({
    runtime_family: "openclaw",
    deploy_target: "docker",
    execution_target_id: "docker",
    sandbox_profile: "standard",
  });
  return {
    enabled: status.available === true,
    runtimeFamily: status.runtimeFamily,
    deployTarget: status.deployTarget,
    executionTargetId: status.executionTargetId,
    sandboxProfile: status.sandboxProfile,
    requiresLiveDocker: true,
    issue: status.available ? null : status.issue || "Local Docker demo is not enabled.",
  };
}

app.get("/config/platform", async (_req, res) => {
  try {
    const kubernetesClusters = await listKubernetesExecutionTargets();
    const defaultRuntimeFamily = getDefaultRuntimeFamily();
    const runtimeFamilies = getRuntimeCatalog(process.env, { kubernetesClusters });
    const executionTargets = getExecutionTargetCatalog(process.env, {
      runtimeFamily: defaultRuntimeFamily,
      kubernetesClusters,
    });
    const sandboxProfiles = getSandboxProfileCatalog(process.env, {
      runtimeFamily: defaultRuntimeFamily,
      kubernetesClusters,
    });
    const [deploymentDefaults, systemBanner, language, release] = await Promise.all([
      getDeploymentDefaults(),
      getSystemBanner(),
      getLanguageSettings(),
      buildReleaseInfo(),
    ]);
    res.json({
      mode: billing.PLATFORM_MODE,
      selfhosted: billing.PLATFORM_MODE !== "paas" ? billing.SELFHOSTED_LIMITS : null,
      billingEnabled: billing.BILLING_ENABLED,
      enabledBackends: getEnabledBackends(),
      defaultBackend: getDefaultBackend(),
      remoteHostsEnabled: isBackendEnabled("remote-docker"),
      adminSurfaces: enabledAdminSurfaces(),
      enabledDeployTargets: enabledDeployTargetsFromExecutionTargets(executionTargets),
      defaultDeployTarget: getDefaultDeployTarget(),
      defaultExecutionTarget: defaultExecutionTargetFromCatalog(executionTargets),
      enabledSandboxProfiles: getEnabledSandboxProfiles(),
      defaultSandboxProfile: getDefaultSandboxProfile(),
      runtimeFamilies,
      executionTargets,
      sandboxProfiles,
      defaultRuntimeFamily,
      deploymentDefaults,
      systemBanner,
      language,
      release,
      capabilities: {
        localDockerDemo: localDockerDemoCapability(),
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/config/backends", async (_req, res) => {
  const kubernetesClusters = await listKubernetesExecutionTargets();
  const defaultRuntimeFamily = getDefaultRuntimeFamily();
  const runtimeFamilies = getRuntimeCatalog(process.env, { kubernetesClusters });
  const executionTargets = getExecutionTargetCatalog(process.env, {
    runtimeFamily: defaultRuntimeFamily,
    kubernetesClusters,
  });
  const sandboxProfiles = getSandboxProfileCatalog(process.env, {
    runtimeFamily: defaultRuntimeFamily,
    kubernetesClusters,
  });
  const activeRuntimeFamily =
    runtimeFamilies.find((runtimeFamily) => runtimeFamily.id === defaultRuntimeFamily) ||
    runtimeFamilies[0] ||
    null;
  res.json({
    runtimeFamily: activeRuntimeFamily,
    runtimeFamilies,
    defaultRuntimeFamily,
    enabledDeployTargets: enabledDeployTargetsFromExecutionTargets(executionTargets),
    defaultDeployTarget: getDefaultDeployTarget(),
    defaultExecutionTarget: defaultExecutionTargetFromCatalog(executionTargets),
    enabledSandboxProfiles: getEnabledSandboxProfiles(),
    defaultSandboxProfile: getDefaultSandboxProfile(),
    executionTargets,
    sandboxProfiles,
    enabledBackends: getEnabledBackends(),
    defaultBackend: getDefaultBackend(),
    backends: getBackendCatalog(process.env, { kubernetesClusters }),
    legacyBackends: getBackendCatalog(process.env, { kubernetesClusters }),
  });
});

app.get("/config/nemoclaw", requireSandboxProfileEnabled("nemoclaw"), (req, res) => {
  const nemoclaw =
    getSandboxProfileCatalog(process.env, { runtimeFamily: "openclaw" }).find(
      (profile) => profile.id === "nemoclaw",
    ) || {};
  res.json({
    enabled: Boolean(nemoclaw.enabled),
    configured: Boolean(nemoclaw.configured),
    available: Boolean(nemoclaw.available),
    issue: nemoclaw.issue || null,
    defaultModel: nemoclaw.defaultModel || null,
    sandboxImage: nemoclaw.sandboxImage || null,
    models: nemoclaw.models || [],
  });
});

// Inbound webhook receiver (public — external services POST here)
app.post("/webhooks/:channelId", async (req, res) => {
  try {
    await channels.handleInboundWebhook(req.params.channelId, req.body, req.headers, req.rawBody);
    res.json({ received: true });
  } catch (e) {
    // 503 for runtime-unreachable so providers retry delivery; 400 for
    // malformed/unknown-channel requests they should not retry.
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

app.use("/auth", require("./routes/auth"));

// Zero-key demo LLM stub (OpenAI-compatible). Pre-auth: agent runtimes call it
// over the container network with the derived demo bearer token, not a JWT.
app.use("/demo-llm", require("./routes/demoLlm"));

// ─── OpenAPI spec + interactive reference (pre-auth: the spec documents the
// public surface and contains no secrets; publicly /api/api.json + /api/api-docs).
app.get("/api.json", (req, res) => {
  const { buildOpenApiDocument } = require("./openapi");
  res.json(buildOpenApiDocument());
});
app.get("/api-docs", (req, res) => {
  // Scalar's standalone bundle renders the reference client-side from the spec
  // URL; loading it from the CDN keeps the backend dependency-free.
  res
    .type("html")
    .send(
      [
        "<!doctype html>",
        "<html><head><title>LPanel API Reference</title>",
        '<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>',
        "</head><body>",
        '<script id="api-reference" data-url="api.json"></script>',
        '<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>',
        "</body></html>",
      ].join("\n"),
    );
});

// ─── Gateway UI static assets (before auth wall — JS/CSS/icons contain no user data) ──
// These are served pre-auth because iframes can't set Authorization headers on sub-resource loads.
// Only opaque static files (JS bundles, CSS, favicons) are exempted — not HTML or
// internal gateway API/config endpoints.
const gatewayUIAssetProxy = require("express").Router();
const PREAUTH_ASSET_METHODS = new Set(["GET", "HEAD"]);
const EMBED_PROXY_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
const EMBED_READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Every OpenClaw gateway embed surface — the control UI, its assets, and the
// bootstrap script — takes this single role instead of the Hermes per-method
// split. bootstrap.js inlines the decrypted gateway password into browser JS
// and rebinds the UI's WebSocket onto the relay, so even a GET here is a grant
// of live control. A workspace viewer loses nothing: this surface was
// owner-only before, so `editor` only ever widens access.
const GATEWAY_EMBED_MIN_WORKSPACE_ROLE = "editor";

// The embedded dashboard is a full control UI, so proxying it verbatim would let
// any caller who can read it also write through it. Map the request method onto
// the same viewer/editor split the native Hermes WebUI routes use
// (routes/agents.ts: reads default to viewer, mutations require editor) so a
// workspace viewer gets the read-only dashboard and nothing more. Re-derived per
// request — the embed session cookie deliberately carries no role of its own.
function embedRoleForMethod(method) {
  return EMBED_READ_METHODS.has(String(method || "").toUpperCase()) ? "viewer" : "editor";
}

gatewayUIAssetProxy.use("/agents/:agentId/gateway", (req, res, next) => {
  if (!PREAUTH_ASSET_METHODS.has(req.method)) return next();
  if (
    req.path === "/assets" ||
    req.path.startsWith("/assets/") ||
    req.path.startsWith("/favicon")
  ) {
    return proxyGatewayAsset(req, res);
  }
  return next();
});

// ─── Gateway UI Embed (pre-auth) ────────────────────────────────────────────────
// The first HTML request authenticates via ?token= and mints a short-lived
// HttpOnly embed-session cookie. Subsequent iframe navigations and relative
// asset/config requests stay within /gateway/embed/* and authenticate via that
// cookie so the control UI can keep using its own relative paths.
gatewayUIAssetProxy.get("/agents/:agentId/gateway/embed/bootstrap.js", async (req, res) => {
  try {
    const access = await resolveEmbedAccess(req, res, {
      requiredRole: GATEWAY_EMBED_MIN_WORKSPACE_ROLE,
    });
    if (!access) return;

    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Vary", "Cookie");
    // gateway_token is encrypted at rest; decrypt before inlining it into the
    // embed bootstrap JS that the browser uses for the gateway WS handshake.
    // decrypt() is transparent to legacy plaintext tokens.
    const { decrypt } = require("./crypto");
    res.send(
      buildEmbedBootstrapScript({
        agentId: access.agentId,
        requestHost: req.headers.host,
        requestScheme: requestProtocol(req),
        gatewayToken: decrypt(access.agent.gateway_token),
      }),
    );
  } catch (err) {
    console.error("[gateway-embed-bootstrap] error:", err);
    if (!res.headersSent) {
      res.status(502).type("text/plain").send("embed bootstrap error");
    }
  }
});

/**
 * Proxy an authenticated OpenClaw embed request through Nora's SSRF-checked
 * gateway target, rewriting HTML to keep assets and WebSockets same-origin.
 *
 * @param {Object} req - Express gateway embed request.
 * @param {Object} res - Express response receiving proxied content.
 * @returns {Promise<void>} Resolves after proxying or sending an error.
 */
async function proxyEmbeddedGateway(req, res) {
  try {
    const access = await resolveEmbedAccess(req, res, {
      requiredRole: GATEWAY_EMBED_MIN_WORKSPACE_ROLE,
    });
    if (!access) return;

    const gatewayPath = getEmbeddedGatewayPath(req);
    // Validate + resolve the gateway host against the SSRF allowlist before
    // connecting (mirrors the HTTP gateway proxy; closes the embed-proxy SSRF
    // gap where gatewayUrlForAgent reached the agent host unchecked).
    const safeTarget = await resolveSafeGatewayHttpTarget(
      access.agent,
      gatewayPath,
      buildForwardedSearch(req),
    );
    const targetUrl = safeTarget.url;
    const headers = {
      Accept: req.headers.accept || "*/*",
      "Accept-Encoding": "identity",
      Host: safeTarget.hostHeader,
    };

    const method = req.method.toUpperCase();
    let body;
    if (method !== "GET" && method !== "HEAD" && req.body != null) {
      if (Buffer.isBuffer(req.body) || typeof req.body === "string") {
        body = req.body;
      } else if (Object.keys(req.body).length > 0) {
        body = JSON.stringify(req.body);
        if (req.headers["content-type"]) headers["Content-Type"] = req.headers["content-type"];
      }
    }

    const resp = await fetch(targetUrl, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(15000),
    });

    const contentType = resp.headers.get("content-type") || "";
    res.status(resp.status);

    if (/text\/html/i.test(contentType)) {
      const html = injectEmbedBootstrapScript(await resp.text(), access.agentId);
      setEmbedHtmlHeaders(res);
      res.send(html);
      return;
    }

    if (contentType) res.setHeader("Content-Type", contentType);
    const cacheControl = resp.headers.get("cache-control");
    if (cacheControl) res.setHeader("Cache-Control", cacheControl);
    else res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Vary", "Cookie");

    const bodyBuffer = await resp.arrayBuffer();
    res.send(Buffer.from(bodyBuffer));
  } catch (err) {
    console.error("[gateway-embed-proxy] error:", err);
    if (!res.headersSent) res.status(502).send(`embed proxy error: ${err.message}`);
  }
}

gatewayUIAssetProxy.use("/agents/:agentId/gateway", (req, res, next) => {
  if (!EMBED_PROXY_METHODS.has(req.method)) return next();
  if (req.path === "/embed" || req.path.startsWith("/embed/")) {
    return proxyEmbeddedGateway(req, res);
  }
  return next();
});

/**
 * Proxy an authenticated Hermes dashboard request through its SSRF-checked
 * target and rewrite dashboard assets/API paths for the embedded base path.
 *
 * @param {Object} req - Express Hermes embed request.
 * @param {Object} res - Express response receiving proxied content.
 * @returns {Promise<void>} Resolves after proxying or sending an error.
 */
async function proxyEmbeddedHermes(req, res) {
  try {
    const access = await resolveEmbedAccess(req, res, {
      lookupAgent: lookupHermesEmbedAgent,
      cookiePrefix: HERMES_EMBED_SESSION_COOKIE_PREFIX,
      scope: "hermes-embed",
      requiredRole: embedRoleForMethod(req.method),
    });
    if (!access) return;

    const hermesPath = getEmbeddedHermesPath(req);
    // Validate + resolve the dashboard host against the gateway allowlist before
    // connecting (closes the SSRF gap where runtime_host was reached unchecked).
    const safeTarget = await resolveSafeHermesDashboardTarget(access.agent);
    const targetUrl = `${joinHttpUrl(safeTarget.host, safeTarget.port, hermesPath)}${buildForwardedSearch(req)}`;
    const cookies = parseCookieHeader(req.headers.cookie || "");
    const dashboardTokenCookieName = getEmbedSessionCookieName(
      access.agentId,
      HERMES_DASHBOARD_TOKEN_COOKIE_PREFIX,
    );
    const headers = {
      Accept: req.headers.accept || "*/*",
      "Accept-Encoding": "identity",
    };
    // Relay the stored Hermes dashboard session (established via server-side
    // login below) as the upstream Cookie. We intentionally do NOT forward the
    // client's Authorization header to the tenant-owned Hermes container: the
    // embed session cookie already authenticates this request at the proxy
    // boundary, and forwarding the platform JWT would expose it to a process
    // whose image may be operator-supplied and should be treated as untrusted.
    let dashboardSession = cookies[dashboardTokenCookieName];
    if (dashboardSession) headers.Cookie = dashboardSession;

    const method = req.method.toUpperCase();
    let body;
    if (method !== "GET" && method !== "HEAD" && req.body != null) {
      if (Buffer.isBuffer(req.body) || typeof req.body === "string") {
        body = req.body;
      } else if (Object.keys(req.body).length > 0) {
        body = JSON.stringify(req.body);
      }
      if (req.headers["content-type"]) {
        headers["Content-Type"] = req.headers["content-type"];
      }
    }

    const fetchUpstream = () =>
      fetch(targetUrl, {
        method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      });

    let resp = await fetchUpstream();

    // If the dashboard says we're unauthenticated, log in once with the
    // per-agent derived basic-auth credential, persist the Hermes session in
    // the Nora-managed HttpOnly cookie, and retry with the new session.
    if (needsHermesLogin(resp)) {
      const seed = decryptSecret(access.agent.gateway_token);
      if (seed) {
        const session = await establishHermesDashboardSession(safeTarget, seed);
        if (session) {
          headers.Cookie = session;
          res.cookie(dashboardTokenCookieName, session, {
            httpOnly: true,
            sameSite: "lax",
            secure: cookieSecureFlag(req),
            maxAge: EMBED_SESSION_TTL_MS,
            path: "/",
          });
          resp = await fetchUpstream();
        }
      }
    }

    // Relay any remaining redirect (login failed, or a non-login 3xx) instead of
    // dropping it: fetch is in manual-redirect mode, so setProxyResponseHeaders /
    // setEmbedHtmlHeaders would otherwise send a bare 3xx with no Location and
    // strand the iframe. Rewrite same-origin targets onto the embed base path so
    // the iframe stays within the proxied dashboard.
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location");
      if (location) {
        const rewritten = location.startsWith("/")
          ? `${hermesEmbedBasePath(access.agentId)}${location}`
          : location;
        res.setHeader("Location", rewritten);
      }
      res.status(resp.status).end();
      return;
    }

    const isApiRequest = hermesPath.startsWith("api/");
    // Self-heal: Hermes's response serializer (UTF-8) crashes on lone UTF-16
    // surrogates that can land in its on-disk config (emoji-bearing usernames,
    // channel labels). When we see 500 on an api/* request, attempt one
    // surrogate repair against the agent's config; only retry the upstream
    // request if the repair actually mutated something — otherwise the 500 is
    // unrelated and we let it propagate.
    if (resp.status === 500 && isApiRequest && method === "GET") {
      try {
        const fullAgent = await fetchAgentForHermesRepair(access.agentId);
        if (fullAgent) {
          const repair = await repairHermesAgentConfig(fullAgent);
          if (repair?.mutated) {
            console.warn(
              `[hermes-embed-proxy] surrogate repair applied for agent ${access.agentId}, retrying upstream`,
            );
            resp = await fetchUpstream();
          }
        }
      } catch (repairErr) {
        console.error("[hermes-embed-proxy] surrogate repair failed:", repairErr);
      }
    }

    const contentType = resp.headers.get("content-type") || "";
    res.status(resp.status);

    if (/text\/html/i.test(contentType)) {
      const rawHtml = await resp.text();
      const html = rewriteHermesEmbedHtml(rawHtml, access.agentId);
      setEmbedHtmlHeaders(res);
      res.send(html);
      return;
    }

    if (/(?:javascript|ecmascript)/i.test(contentType) || /\.js(?:$|\?)/i.test(hermesPath)) {
      const javascript = rewriteHermesEmbedJavascript(await resp.text(), access.agentId);
      setProxyResponseHeaders(res, resp, {
        cachePolicy: isApiRequest ? "no-store" : "asset",
      });
      res.send(javascript);
      return;
    }

    if (/text\/css/i.test(contentType) || /\.css(?:$|\?)/i.test(hermesPath)) {
      const css = rewriteHermesEmbedCss(await resp.text(), access.agentId);
      setProxyResponseHeaders(res, resp, {
        cachePolicy: isApiRequest ? "no-store" : "asset",
      });
      res.send(css);
      return;
    }

    setProxyResponseHeaders(res, resp, {
      cachePolicy: isApiRequest ? "no-store" : "asset",
    });
    const bodyBuffer = await resp.arrayBuffer();
    res.send(Buffer.from(bodyBuffer));
  } catch (err) {
    console.error("[hermes-embed-proxy] error:", err);
    if (!res.headersSent) res.status(502).send(`embed proxy error: ${err.message}`);
  }
}

gatewayUIAssetProxy.use("/agents/:agentId/hermes-ui", (req, res, next) => {
  if (!EMBED_PROXY_METHODS.has(req.method)) return next();
  if (req.path === "/embed" || req.path.startsWith("/embed/")) {
    return proxyEmbeddedHermes(req, res);
  }
  return next();
});

/**
 * Proxy only allowlisted gateway UI asset paths for an authorized embed,
 * rejecting HTML/internal API paths and retaining SSRF-safe resolution.
 *
 * @param {Object} req - Express asset request.
 * @param {Object} res - Express response receiving the asset.
 * @returns {Promise<void>} Resolves after proxying or sending an error.
 */
async function proxyGatewayAsset(req, res) {
  try {
    const access = await resolveEmbedAccess(req, res, {
      requiredRole: GATEWAY_EMBED_MIN_WORKSPACE_ROLE,
    });
    if (!access) return;

    const gatewayPath = req.path || "/";
    // Same SSRF allowlist as the embed proxy — gateway asset/favicon fetches must
    // not reach an unvalidated agent host either.
    const safeTarget = await resolveSafeGatewayHttpTarget(
      access.agent,
      gatewayPath,
      buildForwardedSearch(req),
    );
    const resp = await fetch(safeTarget.url, {
      method: req.method,
      headers: {
        Accept: req.headers.accept || "*/*",
        "Accept-Encoding": "identity",
        Host: safeTarget.hostHeader,
      },
      signal: AbortSignal.timeout(10000),
    });
    res.status(resp.status);
    setProxyResponseHeaders(res, resp);
    const body = await resp.arrayBuffer();
    res.send(Buffer.from(body));
  } catch {
    if (!res.headersSent) res.status(502).end();
  }
}
app.use(gatewayUIAssetProxy);

// ─── Public Agent Hub Catalog ─────────────────────────────────────
app.use("/agent-hub", require("./routes/agentHubPublic"));

// ─── Headmaster account deletion (server-to-server) ───────────────
// Account API -> platform, guarded only by the x-headmaster-internal-secret
// header (HEADMASTER_ACCOUNT_DELETION_SECRET, constant-time compared, >= 32
// chars, unset = 503). It must sit before the auth wall, which would otherwise
// 401 the caller for lacking a user session, and before the broader
// /internal/headmaster router, which 404s everything when the S2S launch
// exchange is not configured.
app.use("/internal/headmaster/account-deletion", require("./routes/internalAccountDeletion"));

// ─── Headmaster S2S launch exchange ───────────────────────────────
// Bearer-token server-to-server surface for the Headmaster site. Reachable
// publicly as /api/internal/headmaster/* through the reverse proxy's existing
// /api/ location (prefix is stripped on pass-through); browsers never call it
// and it 404s entirely unless HEADMASTER_S2S_TOKEN and
// HEADMASTER_PARENT_ORIGIN are configured.
app.use("/internal/headmaster", require("./routes/headmaster"));

// Bearer-token server-to-server surface for the Headmaster memory gateway's
// N3 identity resolution (the "runtime-identity" adapter contract). Reachable
// publicly as /api/integrations/headmaster/runtime-identity through the same
// /api/ proxy path; 404s entirely unless
// HEADMASTER_RUNTIME_IDENTITY_SERVICE_TOKEN is configured.
app.use("/integrations/headmaster", require("./routes/headmasterRuntimeIdentity"));

// ─── Auth Wall ────────────────────────────────────────────────────
app.use(authenticateToken);

// Agent-id paths enforce the API key's exact workspace assignment before any
// router can touch runtime state. Each router then applies its own public scope
// contract (agents, integrations, monitoring, or session-only).
app.use("/agents", requireApiKeyAgentPathScope());

// ─── Gateway Proxy ────────────────────────────────────────────────
app.use(createGatewayRouter());

// ─── Protected Routes ─────────────────────────────────────────────
app.use("/agents", require("./routes/agents"));
app.use("/agents", require("./routes/backups"));
// Account-scoped backup access by backup id. The agent-scoped router above
// cannot reach a backup once its source agent is deleted (#338).
app.use("/backups", require("./routes/accountBackups"));
app.use("/agents", require("./routes/agentFiles"));
app.use("/agents", require("./routes/channels"));
app.use("/agents", require("./routes/nemoclaw"));
app.use("/agent-migrations", require("./routes/agentMigrations"));
app.use("/", require("./routes/integrations")); // handles /agents/:id/integrations + /integrations/catalog
app.use("/", require("./routes/monitoring")); // handles /monitoring/* + /agents/:id/metrics
app.use("/llm-providers", require("./routes/llmProviders"));
app.use("/clawhub", require("./routes/clawhub"));
app.use("/hermes-skills", require("./routes/hermesSkills"));
app.use("/agent-hub", require("./routes/agentHub"));
app.use("/workspaces", require("./routes/workspaces"));
app.use("/remote-hosts", require("./routes/remoteHosts"));
app.use("/billing", require("./routes/billing"));
// Fleet routes mount before /admin so the explicit prefix wins; both still go
// through requireAdmin (the fleet router applies it itself, and /admin's own
// guard is redundant but harmless). Same pattern for the platform-admin RBAC
// god view.
app.use("/admin/fleet/migrations", require("./routes/fleetMigrations"));
app.use("/admin/account-deletions", require("./routes/adminAccountDeletions"));
app.use("/admin/headmaster-accounts", require("./routes/adminHeadmasterAccounts"));
app.use("/admin", require("./routes/adminMembers"));
app.use("/admin", require("./routes/admin"));

// ─── Central Error Handler ────────────────────────────────────────
app.use(errorHandler);

// ─── DB Migration ─────────────────────────────────────────────────
// These repairs are intentionally outside the positional migration ledger.
// They are idempotent compatibility preconditions for replaying the historical
// reconciliation list on databases that predate the checksum ledger. Keeping
// them separate avoids renumbering or changing checksums for deployed entries.
const LEGACY_COMPATIBILITY_REPAIRS = [
  {
    name: "normalize-legacy-backup-kinds",
    sql: `DO $nora$
      DECLARE
        backups_table REGCLASS := to_regclass('backups');
        schedules_table REGCLASS := to_regclass('backup_schedules');
        backups_have_scope BOOLEAN := false;
      BEGIN
        IF backups_table IS NOT NULL THEN
          SELECT EXISTS (
            SELECT 1
              FROM pg_attribute
             WHERE attrelid = backups_table
               AND attname = 'scope'
               AND NOT attisdropped
          ) INTO backups_have_scope;

          IF backups_have_scope THEN
            EXECUTE $repair$
              UPDATE backups
                 SET kind = CASE
                   WHEN LOWER(BTRIM(COALESCE(kind, ''))) = 'installation' THEN 'installation'
                   WHEN LOWER(BTRIM(COALESCE(kind, ''))) = 'agent' THEN 'agent'
                   WHEN COALESCE(scope, '{}'::jsonb) @> '{"installation": true}'::jsonb
                     THEN 'installation'
                   ELSE 'agent'
                 END
               WHERE kind IS DISTINCT FROM 'agent'
                 AND kind IS DISTINCT FROM 'installation'
            $repair$;
          ELSE
            EXECUTE $repair$
              UPDATE backups
                 SET kind = CASE
                   WHEN LOWER(BTRIM(COALESCE(kind, ''))) = 'installation' THEN 'installation'
                   WHEN LOWER(BTRIM(COALESCE(kind, ''))) = 'agent' THEN 'agent'
                   WHEN agent_id IS NULL THEN 'installation'
                   ELSE 'agent'
                 END
               WHERE kind IS DISTINCT FROM 'agent'
                 AND kind IS DISTINCT FROM 'installation'
            $repair$;
          END IF;
        END IF;

        IF schedules_table IS NOT NULL THEN
          EXECUTE $repair$
            UPDATE backup_schedules
               SET kind = CASE
                 WHEN LOWER(BTRIM(COALESCE(kind, ''))) = 'installation' THEN 'installation'
                 WHEN LOWER(BTRIM(COALESCE(kind, ''))) = 'agent' THEN 'agent'
                 WHEN schedule_key = 'installation' OR agent_id IS NULL THEN 'installation'
                 ELSE 'agent'
               END
             WHERE kind IS DISTINCT FROM 'agent'
               AND kind IS DISTINCT FROM 'installation'
          $repair$;
        END IF;
      END
    $nora$`,
  },
  {
    name: "deduplicate-legacy-agent-hub-slugs",
    sql: `DO $nora$
      DECLARE
        listings_table REGCLASS := to_regclass('agent_hub_listings');
        listings_have_slug BOOLEAN := false;
      BEGIN
        IF listings_table IS NOT NULL THEN
          SELECT EXISTS (
            SELECT 1
              FROM pg_attribute
             WHERE attrelid = listings_table
               AND attname = 'slug'
               AND NOT attisdropped
          ) INTO listings_have_slug;
        END IF;

        IF listings_have_slug THEN
          EXECUTE $repair$
            UPDATE agent_hub_listings
               SET slug = NULL
             WHERE slug IS NOT NULL AND BTRIM(slug) = ''
          $repair$;

          EXECUTE $repair$
            WITH ranked AS (
              SELECT id,
                     ROW_NUMBER() OVER (
                       PARTITION BY slug
                       ORDER BY created_at ASC NULLS LAST, id ASC
                     ) AS slug_position
                FROM agent_hub_listings
               WHERE slug IS NOT NULL
            )
            UPDATE agent_hub_listings AS listing
               SET slug = NULL
              FROM ranked
             WHERE listing.id = ranked.id
               AND ranked.slug_position > 1
          $repair$;
        END IF;
      END
    $nora$`,
  },
  {
    name: "repair-llm-provider-defaults",
    sql: `DO $nora$
      BEGIN
        IF to_regclass('llm_providers') IS NOT NULL THEN
          WITH ranked AS (
            SELECT id,
                   ROW_NUMBER() OVER (
                     PARTITION BY user_id
                     ORDER BY is_default DESC,
                              CASE WHEN provider = 'demo' THEN 1 ELSE 0 END,
                              created_at ASC NULLS LAST,
                              id ASC
                   ) AS provider_position
              FROM llm_providers
          )
          UPDATE llm_providers AS provider
             SET is_default = (ranked.provider_position = 1)
            FROM ranked
           WHERE provider.id = ranked.id
             AND provider.is_default IS DISTINCT FROM (ranked.provider_position = 1);
        END IF;
      END
    $nora$`,
  },
];

/**
 * Apply compatibility repairs and append-only schema migrations under one
 * transactional advisory lock; any failure rolls back and blocks startup.
 *
 * @param {Object} [database=db] - PostgreSQL pool or client used for migration work.
 * @param {Object} [env=process.env] - Migration timeout configuration.
 * @returns {Promise<Object>} Total and newly applied migration counts after commit.
 */
async function migrateDB(database = db, env = process.env) {
  // Versioned migrations live in backend-api/migrations/NNNN_name.sql and are
  // pinned by migrations.lock.json. Add a new file with the next number, then run
  // `npm run migrations:lock`; never insert, rename or edit one.
  const migrations = loadMigrationFiles();

  return runVersionedMigrations(database, migrations, {
    compatibilityRepairs: LEGACY_COMPATIBILITY_REPAIRS,
    lockTimeoutMs: env.DB_MIGRATION_LOCK_TIMEOUT_MS,
    statementTimeoutMs: env.DB_MIGRATION_STATEMENT_TIMEOUT_MS,
  });
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Reconcile on-disk starter templates into built-in snapshots and Agent Hub
 * listings without replacing unchanged snapshot content.
 *
 * @returns {Promise<void>} Resolves after starter listings are synchronized.
 */
async function seedStarterAgentHub() {
  for (const template of STARTER_TEMPLATES) {
    const existingListing = await agentHubStore.getPlatformListingByTemplateKey(
      template.templateKey,
    );

    let snapshotId = existingListing?.snapshot_id || null;
    let shouldCreateSnapshot = !snapshotId;

    if (snapshotId) {
      const currentSnapshot = await snapshots.getSnapshot(snapshotId);
      const currentConfig =
        currentSnapshot?.config && typeof currentSnapshot.config === "object"
          ? currentSnapshot.config
          : {};
      shouldCreateSnapshot =
        !currentSnapshot ||
        currentSnapshot.name !== template.name ||
        currentSnapshot.description !== template.description ||
        stableStringify(currentConfig) !== stableStringify(template.snapshotConfig);
    }

    if (shouldCreateSnapshot) {
      const snapshot = await snapshots.createSnapshot(
        null,
        template.name,
        template.description,
        template.snapshotConfig,
        {
          kind: template.snapshotConfig.kind || "starter-template",
          templateKey: template.templateKey,
          builtIn: true,
        },
      );
      snapshotId = snapshot.id;
    }

    await agentHubStore.upsertListing({
      listingId: existingListing?.id || null,
      snapshotId,
      name: template.name,
      description: template.description,
      price: template.price,
      category: template.category,
      builtIn: true,
      sourceType: agentHubStore.LISTING_SOURCE_PLATFORM,
      status: agentHubStore.LISTING_STATUS_PUBLISHED,
      visibility: agentHubStore.LISTING_VISIBILITY_PUBLIC,
      slug: template.templateKey,
    });
  }

  console.log(`Agent Hub seeded with ${STARTER_TEMPLATES.length} built-in starter templates`);
}

/**
 * Seed the first admin account on boot when the user table is empty. Hosted
 * PaaS refuses to start without explicit, valid `DEFAULT_ADMIN_EMAIL` and
 * `DEFAULT_ADMIN_PASSWORD`; selfhosted installs may instead leave the account
 * to be claimed through first-run signup.
 *
 * @returns {Promise<void>}
 */
async function seedBootstrapAdminAccount() {
  const { rows } = await db.query("SELECT id FROM users LIMIT 1");
  if (rows.length > 0) return;

  const adminEmail = process.env.DEFAULT_ADMIN_EMAIL;
  const adminPassword = process.env.DEFAULT_ADMIN_PASSWORD;
  const bootstrapAdmin = getBootstrapAdminSeedConfig({ adminEmail, adminPassword });

  if (!bootstrapAdmin.shouldSeed) {
    const emailConfigured = typeof adminEmail === "string" && adminEmail.trim() !== "";
    const passwordConfigured = typeof adminPassword === "string" && adminPassword !== "";
    if (!emailConfigured && !passwordConfigured) {
      if (!allowsFirstAdminSignupClaim()) {
        const error = new Error(
          "Hosted PaaS requires explicit DEFAULT_ADMIN_EMAIL and DEFAULT_ADMIN_PASSWORD before the API can start with an empty user database.",
        );
        error.code = "PAAS_BOOTSTRAP_ADMIN_REQUIRED";
        throw error;
      }
      if (!isSignupEnabled()) {
        // The advice below would be impossible to follow: signup is disabled,
        // so with an empty user table and no seedable admin the instance has
        // no way to create its first account until the operator intervenes.
        console.warn(
          "Skipping bootstrap admin seed with SIGNUP_ENABLED=false: the user database is empty and public signup is disabled, so no account can be created. Set explicit DEFAULT_ADMIN_EMAIL and a non-default DEFAULT_ADMIN_PASSWORD with at least 12 characters, or temporarily set SIGNUP_ENABLED=true to claim the first account through signup.",
        );
        return;
      }
      console.warn(
        "Skipping bootstrap admin seed: set explicit DEFAULT_ADMIN_EMAIL and a non-default DEFAULT_ADMIN_PASSWORD with at least 12 characters, or claim the first account through signup.",
      );
      return;
    }

    const error = new Error(
      `Invalid bootstrap admin configuration (${bootstrapAdmin.reason}). Refusing to start with an empty user database because the configured account would not be created.`,
    );
    error.code = "BOOTSTRAP_ADMIN_CONFIGURATION_INVALID";
    throw error;
  }

  const bcrypt = require("bcryptjs");
  const hash = await bcrypt.hash(bootstrapAdmin.password, 10);
  await db.query(
    "INSERT INTO users(email, password_hash, role, name) VALUES($1, $2, 'admin', 'Admin') ON CONFLICT DO NOTHING",
    [bootstrapAdmin.email, hash],
  );
  console.log(`Bootstrap admin account created: ${bootstrapAdmin.email}`);
}

// ─── Startup ──────────────────────────────────────────────────────
if (require.main === module) {
  const { attachLogStream } = require("./logStream");
  const { attachExecStream } = require("./execStream");
  const { attachMetricsStream } = require("./metricsStream");

  const PORT = parseInt(process.env.PORT || "4000");
  async function startServer() {
    // Schema reconciliation is a hard startup gate. The migration runner uses
    // a transaction, advisory lock, append-only ledger, and checksums; Nora
    // must never serve traffic against a partially migrated database.
    await migrateDB();
    // Bootstrap credentials are an activation and security gate. Validate and
    // seed them before binding the HTTP listener so a copied placeholder or a
    // password rejected by policy cannot silently leave first-run signup open.
    await seedBootstrapAdminAccount();

    const server = app.listen(PORT, async () => {
      console.log(`api running on ${PORT}`);

      // New Hermes bots start on the newest finalized runtime release; env is the fallback.
      require("../agent-runtime/lib/currentRuntimeImage").startCurrentRuntimeImagePoll();

      // Headmaster launch exchange: schema, revocation pub/sub, and the
      // bounded-delay session revalidator. No-op unless configured.
      require("./headmasterLaunch")
        .init()
        .catch((e) => {
          console.error("headmaster launch init failed:", e.message);
        });

      // Dev-mode only: persist the generated JWT secret in platform_settings so
      // sessions survive restarts; on later boots restore the stored one. The
      // restore happens before real traffic in practice, and the worst case of a
      // racing request is one invalidated token — the prior behavior for ALL
      // tokens on every restart. Production never reaches this branch (boot
      // fails without an explicit JWT_SECRET).
      if (usedEphemeralJwtSecret) {
        try {
          const existing = await db.query("SELECT dev_jwt_secret FROM platform_settings LIMIT 1");
          const stored = existing.rows[0]?.dev_jwt_secret;
          if (stored && stored.length >= MIN_JWT_SECRET_LENGTH) {
            process.env.JWT_SECRET = stored;
            console.log("Restored persisted dev JWT secret — existing sessions remain valid.");
          } else {
            await db.query(
              `INSERT INTO platform_settings(singleton, dev_jwt_secret) VALUES (TRUE, $1)
             ON CONFLICT (singleton) DO UPDATE SET dev_jwt_secret = EXCLUDED.dev_jwt_secret`,
              [process.env.JWT_SECRET],
            );
            console.log("Persisted generated dev JWT secret — sessions will survive restarts.");
          }
        } catch (e) {
          console.warn("Could not persist/restore dev JWT secret:", e.message);
        }
      }

      try {
        const promotedUser = await ensureFirstRegisteredUserIsAdmin(db);
        if (promotedUser) {
          console.log(`Promoted first registered user to admin: ${promotedUser.email}`);
        }
      } catch (e) {
        console.error("Failed to ensure an admin user exists:", e.message);
      }

      try {
        await integrations.seedCatalog();
      } catch (e) {
        console.error("Failed to seed integration catalog:", e.message);
      }

      try {
        await seedStarterAgentHub();
      } catch (e) {
        console.error("Failed to seed Agent Hub:", e.message);
      }

      _startupComplete = true;
      console.log("Startup complete — health check now returning ok");

      // ── Background stats collector: sample supported backends every 5s ──
      const STATS_INTERVAL = 5000;
      setInterval(async () => {
        await collectBackgroundTelemetry({
          dbClient: db,
          telemetryCollector: collectAgentTelemetrySample,
        });
      }, STATS_INTERVAL);

      // ── Background status reconciler: sync DB status with real container state every 30s ──
      const RECONCILE_INTERVAL = 30000;
      setInterval(async () => {
        await reconcileBackgroundAgentStatuses({ dbClient: db });
      }, RECONCILE_INTERVAL);

      // ── External runtime reconciler: adopted runtimes have no container, so probe
      // their endpoint over HTTP (SSRF-safe) and reconcile status every 30s. ──
      setInterval(async () => {
        await reconcileExternalAgentStatuses({ dbClient: db });
      }, RECONCILE_INTERVAL);

      // ── Budget sweep: re-enforce per-agent hard caps every 60s. The status
      // reconciler above flips stopped->running whenever a container is live,
      // so re-enforcement is what keeps a budget pause stuck. ──
      const BUDGET_SWEEP_INTERVAL = 60000;
      setInterval(async () => {
        await agentBudgets.sweepAgentBudgets({ dbClient: db });
      }, BUDGET_SWEEP_INTERVAL);

      // ── Account deletion sweep: wipe accounts whose 14-day grace period has
      // ended (claimed in Supabase, FOR UPDATE SKIP LOCKED). Hourly; off when
      // the Headmaster Supabase settings are absent. ──
      const deletionClient = createDeletionClient();
      if (deletionClient) {
        let deletionSweepRunning = false;
        setInterval(async () => {
          if (deletionSweepRunning) return;
          deletionSweepRunning = true;
          try {
            await deletionClient.sweepDueDeletions();
          } catch (err) {
            console.error("[account-deletion] sweep failed:", err?.message || err);
          } finally {
            deletionSweepRunning = false;
          }
        }, 60 * 60 * 1000);
      }

      // ── Schedule sweep: claim due agent_schedules and enqueue each run for the
      // worker to execute. Replica-safe (FOR UPDATE SKIP LOCKED in the module).
      // The re-entrancy guard prevents a slow sweep from overlapping the next
      // tick (setInterval doesn't await), bounding concurrent enqueue load. ──
      const SCHEDULE_SWEEP_INTERVAL = 30000;
      let scheduleSweepRunning = false;
      setInterval(async () => {
        if (scheduleSweepRunning) return;
        scheduleSweepRunning = true;
        try {
          await agentSchedules.sweepDueSchedules({
            dbClient: db,
            enqueue: addScheduleRunJob,
          });
        } catch (err) {
          console.error("[schedules] sweep failed:", err?.message || err);
        } finally {
          scheduleSweepRunning = false;
        }
      }, SCHEDULE_SWEEP_INTERVAL);
    });

    attachLogStream(server);
    attachExecStream(server);
    attachMetricsStream(server);
    attachGatewayWS(server);

    // Flush batched OpenTelemetry spans/metrics on shutdown — only when OTel is
    // actually enabled, so the default/disabled path (and tests) keep Node's
    // stock signal behavior. Bounded so a stuck exporter can't block exit.
    if (otel.isEnabled()) {
      for (const sig of ["SIGTERM", "SIGINT"]) {
        process.once(sig, () => {
          Promise.race([
            otel.shutdown(),
            new Promise((resolve) => setTimeout(resolve, 3000)),
          ]).finally(() => process.exit(0));
        });
      }
    }
  }

  startServer().catch(async (error) => {
    console.error(`Fatal startup error: ${error?.message || error}`);
    try {
      await db.end();
    } catch (closeError) {
      console.error(
        `Failed to close PostgreSQL pool after startup failure: ${closeError?.message || closeError}`,
      );
    }
    process.exit(1);
  });
}

module.exports = app;
module.exports.__test = Object.freeze({
  migrateDB,
  seedBootstrapAdminAccount,
  stripeWebhookHandler,
});
