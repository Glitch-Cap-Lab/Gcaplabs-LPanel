// Short-lived realtime voice session tokens minted from a user's own key.
//
// Realtime voice is a WebSocket the relay does not proxy. Instead the relay
// decrypts the user's vaulted key (byo.mjs), asks the provider for an
// ephemeral token that expires within REALTIME_MAX_TTL_SECONDS, and returns
// only that token. The raw key never leaves this process and is never logged;
// each minted session is logged by owner id and provider only. Personal keys
// are not counted against the Headmaster spending cap.

export const REALTIME_SESSION_PATH = "/v1/realtime/session";
export const REALTIME_MAX_TTL_SECONDS = 600;
export const REALTIME_MIN_TTL_SECONDS = 10;
export const REALTIME_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;
// Providers sometimes round the expiry up by a few seconds.
const EXPIRY_SLACK_SECONDS = 30;
const MODEL_ID = /^[A-Za-z0-9._:/@-]{1,128}$/;

// Fixed provider endpoints; never client supplied.
const MINTERS = Object.freeze({
  openai: {
    url: "https://api.openai.com/v1/realtime/client_secrets",
    request: (apiKey, { ttl, model }) => ({
      headers: { authorization: `Bearer ${apiKey}` },
      body: {
        expires_after: { anchor: "created_at", seconds: ttl },
        ...(model ? { session: { type: "realtime", model } } : {}),
      },
    }),
    parse: (json) => ({ token: json?.value, expiresAt: json?.expires_at }),
  },
  xai: {
    url: "https://api.x.ai/v1/realtime/client_secrets",
    request: (apiKey, { ttl }) => ({
      headers: { authorization: `Bearer ${apiKey}` },
      body: { expires_after: { seconds: ttl } },
    }),
    parse: (json) => ({ token: json?.value, expiresAt: json?.expires_at }),
  },
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1alpha/auth_tokens",
    request: (apiKey, { ttl, model, nowSeconds }) => ({
      headers: { "x-goog-api-key": apiKey },
      body: {
        uses: 1,
        expireTime: new Date((nowSeconds + ttl) * 1000).toISOString(),
        newSessionExpireTime: new Date((nowSeconds + Math.min(ttl, 60)) * 1000).toISOString(),
        ...(model ? { liveConnectConstraints: { model } } : {}),
      },
    }),
    parse: (json) => ({
      token: json?.name,
      expiresAt: json?.expireTime ? Math.floor(Date.parse(json.expireTime) / 1000) : undefined,
    }),
  },
});

export function isRealtimeProvider(value) {
  return typeof value === "string" && Object.hasOwn(MINTERS, value);
}

// Validates the client body: optional { model, ttl_seconds }. Anything else,
// including authority fields like owner_id or provider, is rejected.
export function prepareRealtimeRequest(body) {
  let parsed = {};
  if (body && body.length > 0) {
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      return { error: "body_invalid" };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "body_invalid" };
  if (Object.keys(parsed).some((k) => k !== "model" && k !== "ttl_seconds"))
    return { error: "realtime_field_forbidden" };
  if (parsed.model !== undefined && (typeof parsed.model !== "string" || !MODEL_ID.test(parsed.model)))
    return { error: "model_not_allowed" };
  let ttl = REALTIME_MAX_TTL_SECONDS;
  if (parsed.ttl_seconds !== undefined) {
    if (!Number.isSafeInteger(parsed.ttl_seconds) || parsed.ttl_seconds < 1)
      return { error: "ttl_invalid" };
    ttl = Math.min(Math.max(parsed.ttl_seconds, REALTIME_MIN_TTL_SECONDS), REALTIME_MAX_TTL_SECONDS);
  }
  return { model: parsed.model, ttl };
}

function mintError(code, status) {
  return Object.assign(new Error(code), { code, status });
}

// Asks the provider for an ephemeral token. Returns { token, expires_at, model? }
// or throws { code, status } with a safe code; the provider body is never echoed.
export async function mintRealtimeToken({
  provider,
  apiKey,
  model,
  ttl,
  fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = REALTIME_TIMEOUT_MS,
}) {
  const minter = MINTERS[provider];
  if (!minter) throw mintError("realtime_provider_unsupported", 400);
  const boundedTtl = Math.min(Math.max(ttl, REALTIME_MIN_TTL_SECONDS), REALTIME_MAX_TTL_SECONDS);
  const nowSeconds = Math.floor(now() / 1000);
  const { headers, body } = minter.request(apiKey, { ttl: boundedTtl, model, nowSeconds });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let response;
  let text;
  try {
    response = await fetchImpl(minter.url, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
      body: JSON.stringify(body),
    });
    text = await response.text();
  } catch {
    throw mintError("provider_unavailable", 502);
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 429) throw mintError("provider_rate_limited", 429);
  if (response.status === 401 || response.status === 403)
    throw mintError("provider_key_rejected", 502);
  if (!response.ok || text.length > MAX_RESPONSE_BYTES) throw mintError("provider_error", 502);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw mintError("provider_error", 502);
  }
  const { token, expiresAt } = minter.parse(json);
  if (typeof token !== "string" || !token || token === apiKey) throw mintError("provider_error", 502);
  // A token the provider says lives longer than we asked for is not handed out.
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= nowSeconds ||
    expiresAt > nowSeconds + boundedTtl + EXPIRY_SLACK_SECONDS
  )
    throw mintError("provider_token_ttl_invalid", 502);
  return { token, expires_at: expiresAt, ...(model ? { model } : {}) };
}
