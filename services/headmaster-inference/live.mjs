// GPT-Live voice sessions created with a user's own OpenAI key.
//
// Upstream's live voice mode (Core tools/voice_live.py) has the runtime exchange
// the app's WebRTC SDP offer for an answer at `${voice.gpt_live.base_url}/live/sessions`.
// In Cloud that base URL is the account inference host's own-key OpenAI route, so
// the request lands here: the relay decrypts the user's vaulted key, makes the one
// vendor call and returns only the session id and the SDP answer. The audio then
// flows between the app and the vendor directly. The raw key never leaves this
// process and is never logged. Personal keys are not counted against the Headmaster
// spending cap, the same as the realtime token route.

export const LIVE_SESSION_PATH = "/v1/live/sessions";
export const LIVE_PROVIDER = "openai";
// Inside the runtime's own 30 s wait (tools/voice_live.py), so a slow vendor is a clean 502.
export const LIVE_TIMEOUT_MS = 25_000;
// Fixed vendor endpoint; never client supplied.
const LIVE_SESSIONS_URL = "https://api.openai.com/v1/live/sessions";
const MAX_SDP_CHARS = 64 * 1024;
const MAX_INSTRUCTIONS_CHARS = 16 * 1024;
const MAX_HISTORY_ITEMS = 64;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MODEL_ID = /^[A-Za-z0-9._:/@-]{1,128}$/;
const VOICE_ID = /^[A-Za-z0-9._ -]{1,64}$/;
const SESSION_FIELDS = new Set(["model", "instructions", "audio", "delegation", "input"]);

const invalid = (error) => ({ error });
const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

// Validates the body upstream's build_session_config + create_webrtc_session send:
// { session: { model, instructions, audio: { output: { voice } }, delegation: { type: "client" },
//   input?: [history items] }, transport: { type: "webrtc", sdp } }. Anything else is refused,
// so the user's key can only ever open a client-delegation WebRTC session.
export function prepareLiveSessionRequest(body) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return invalid("body_invalid");
  }
  if (!isPlainObject(parsed) || Object.keys(parsed).some((k) => k !== "session" && k !== "transport"))
    return invalid("live_field_forbidden");
  const { session, transport } = parsed;
  if (!isPlainObject(session) || !isPlainObject(transport)) return invalid("body_invalid");
  if (Object.keys(session).some((k) => !SESSION_FIELDS.has(k))) return invalid("live_field_forbidden");
  if (typeof session.model !== "string" || !MODEL_ID.test(session.model)) return invalid("model_not_allowed");
  if (typeof session.instructions !== "string" || session.instructions.length > MAX_INSTRUCTIONS_CHARS)
    return invalid("instructions_invalid");
  if (!isPlainObject(session.delegation) || session.delegation.type !== "client" || Object.keys(session.delegation).length !== 1)
    return invalid("delegation_invalid");
  const voice = session.audio?.output?.voice;
  if (
    !isPlainObject(session.audio) ||
    Object.keys(session.audio).length !== 1 ||
    !isPlainObject(session.audio.output) ||
    Object.keys(session.audio.output).length !== 1 ||
    typeof voice !== "string" ||
    !VOICE_ID.test(voice)
  )
    return invalid("voice_invalid");
  if (session.input !== undefined && (!Array.isArray(session.input) || session.input.length > MAX_HISTORY_ITEMS))
    return invalid("history_invalid");
  if (
    Object.keys(transport).length !== 2 ||
    transport.type !== "webrtc" ||
    typeof transport.sdp !== "string" ||
    !transport.sdp.trim() ||
    transport.sdp.length > MAX_SDP_CHARS
  )
    return invalid("sdp_invalid");
  return { payload: { session, transport } };
}

function liveError(code, status) {
  return Object.assign(new Error(code), { code, status });
}

// One vendor call. Returns { session: { id }, transport: { type: "webrtc", sdp } } or throws
// { code, status } with a safe code; the vendor body is never echoed.
export async function createLiveSession({ apiKey, payload, fetchImpl = fetch, timeoutMs = LIVE_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let response;
  let text;
  try {
    response = await fetchImpl(LIVE_SESSIONS_URL, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    });
    text = await response.text();
  } catch {
    throw liveError("provider_unavailable", 502);
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 429) throw liveError("provider_rate_limited", 429);
  if (response.status === 401 || response.status === 403) throw liveError("provider_key_rejected", 502);
  if (response.status === 400) throw liveError("provider_request_rejected", 400);
  if (!response.ok || text.length > MAX_RESPONSE_BYTES) throw liveError("provider_error", 502);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw liveError("provider_error", 502);
  }
  const id = json?.session?.id;
  const sdp = json?.transport?.sdp;
  if (typeof sdp !== "string" || !sdp || (id !== undefined && typeof id !== "string") || sdp.includes(apiKey))
    throw liveError("provider_error", 502);
  return { session: { id: id ?? null }, transport: { type: "webrtc", sdp } };
}
