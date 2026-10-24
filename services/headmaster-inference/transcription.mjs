// Managed speech-to-text. A Cloud runtime's stock `stt.openai` provider posts an OpenAI-style
// multipart request; admission authenticates the account and forwards it here under the same signed
// assertion as chat. The relay holds the vendor key, reserves wallet credit before the vendor call
// and settles the real audio duration after it, like chat. Only the audio file and an optional
// language/prompt reach the vendor; the requested model only picks the engine, whose own model is the operator's.
//
// The person picks the engine the upstream way, with the provider's model setting (stt.openai.model,
// sent as the OpenAI `model` field): "munsit" goes to Munsit when its key is set, anything else to the
// default engine. The operator may also send chosen languages to Munsit (HEADMASTER_MUNSIT_LANGUAGES,
// off by default), so a language never limits which engine a person can choose.

export const TRANSCRIPTION_PATH = "/v1/audio/transcriptions";
export const TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;
// Vendors bill a minimum per request (Groq: 10 s). Reserve against a low-bitrate clip so the hold covers it.
const MIN_BILLED_SECONDS = 10;
const RESERVE_BYTES_PER_SECOND = 2_000;
const MAX_BILLED_SECONDS = 3 * 60 * 60;
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
const MAX_PROMPT_CHARS = 1000;

function httpsBase(raw) {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash)
      return null;
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function microUsdPerHour(raw, fallback) {
  const price = Number.parseFloat(String(raw ?? ""));
  return Math.round((Number.isFinite(price) && price >= 0 ? price : fallback) * 1_000_000);
}

// Munsit (Arabic): x-api-key auth, POST {base}/audio/transcribe, answer { data: { transcription } }.
function munsitConfigFromEnv(env) {
  const apiKey = String(env.HEADMASTER_MUNSIT_API_KEY || "").trim();
  if (!apiKey) return null;
  const baseUrl = httpsBase(String(env.HEADMASTER_MUNSIT_BASE_URL || "https://api.munsit.com/api/v1"));
  if (!baseUrl) return null;
  const languages = String(env.HEADMASTER_MUNSIT_LANGUAGES || "")
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
  return {
    kind: "munsit",
    apiKey,
    baseUrl,
    model: String(env.HEADMASTER_MUNSIT_MODEL || "munsit").trim(),
    microUsdPerHour: microUsdPerHour(env.HEADMASTER_MUNSIT_USD_PER_HOUR, 0),
    languages,
  };
}

export function transcriptionConfigFromEnv(env = process.env) {
  const apiKey = String(env.HEADMASTER_STT_API_KEY || "").trim();
  if (!apiKey) return null;
  const baseUrl = httpsBase(String(env.HEADMASTER_STT_BASE_URL || "https://api.groq.com/openai/v1"));
  if (!baseUrl) return null;
  return {
    kind: "openai",
    apiKey,
    baseUrl,
    model: String(env.HEADMASTER_STT_MODEL || "whisper-large-v3-turbo").trim(),
    // verbose_json carries the measured duration on Groq and OpenAI; OpenRouter answers plain "json" with a usage object.
    responseFormat: String(env.HEADMASTER_STT_RESPONSE_FORMAT || "verbose_json").trim(),
    // Vendor price, USD per audio hour (Groq whisper-large-v3-turbo: 0.04). Charged at the wallet's other-model markup.
    microUsdPerHour: microUsdPerHour(env.HEADMASTER_STT_USD_PER_HOUR, 0.04),
    munsit: munsitConfigFromEnv(env),
  };
}

/** The vendor for one request: Munsit when its model is asked for or the operator routes the language there, else the default. */
export function transcriptionVendor(config, language, model = "") {
  const munsit = config.munsit;
  if (!munsit) return config;
  const wanted = typeof model === "string" ? model.trim().toLowerCase() : "";
  if (wanted && (wanted === "munsit" || wanted === munsit.model.toLowerCase())) return munsit;
  const tag = typeof language === "string" ? language.toLowerCase() : "";
  if (tag && munsit.languages.some((l) => tag === l || tag.startsWith(`${l}-`))) return munsit;
  return config;
}

// Used to bill a successful call whose vendor reported no duration: the clip's size at a typical compressed bitrate.
export function estimatedSeconds(byteLength) {
  return byteLength / 4_000;
}

export function transcriptionCostMicroUsd(seconds, config) {
  const billed = Math.min(MAX_BILLED_SECONDS, Math.max(MIN_BILLED_SECONDS, Number.isFinite(seconds) ? seconds : 0));
  return Math.ceil((billed * config.microUsdPerHour) / 3600);
}

/** Upper-ish bound from the upload size alone, before the vendor has measured the audio. */
export function transcriptionReserveMicroUsd(byteLength, config) {
  return transcriptionCostMicroUsd(byteLength / RESERVE_BYTES_PER_SECOND, config);
}

/** Parse the upload. Resolves { form, fileBytes, vendor } (vendor request body) or { error: "bad_request" }. */
export async function prepareTranscription(body, contentType, config) {
  let incoming;
  try {
    incoming = await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch {
    return { error: "bad_request" };
  }
  const file = incoming.get("file");
  if (!file || typeof file === "string" || file.size === 0) return { error: "bad_request" };
  const rawLanguage = incoming.get("language");
  const language = typeof rawLanguage === "string" && LANGUAGE.test(rawLanguage) ? rawLanguage : null;
  const vendor = transcriptionVendor(config, language, incoming.get("model"));
  const form = new FormData();
  form.set("file", file, file.name || "audio.webm");
  form.set("model", vendor.model);
  if (vendor.kind === "munsit") return { form, fileBytes: file.size, vendor };
  form.set("response_format", config.responseFormat);
  if (language) form.set("language", language);
  const prompt = incoming.get("prompt");
  if (typeof prompt === "string" && prompt) form.set("prompt", prompt.slice(0, MAX_PROMPT_CHARS));
  return { form, fileBytes: file.size, vendor };
}

// The vendor's own measurement of the audio, whichever shape it uses; NaN when it gave none.
function measuredSeconds(json) {
  for (const value of [json.duration, json.usage?.seconds, json.usage?.duration, json.usage?.audio_seconds, json.data?.duration]) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return Number.NaN;
}

/** Resolves { text, seconds } or { error: "bad_request" | "unavailable" | "timeout" }. Never throws. */
export async function callVendor({ form, config, fetchImpl = fetch, signal }) {
  try {
    const munsit = config.kind === "munsit";
    const upstream = await fetchImpl(`${config.baseUrl}/audio/${munsit ? "transcribe" : "transcriptions"}`, {
      method: "POST",
      headers: munsit ? { "x-api-key": config.apiKey } : { authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal,
      redirect: "error",
    });
    if (!upstream.ok)
      return { error: upstream.status >= 500 || upstream.status === 429 ? "unavailable" : "bad_request" };
    const json = await upstream.json();
    const text = munsit ? json?.data?.transcription : json?.text;
    if (typeof text !== "string") return { error: "unavailable" };
    return { text, seconds: measuredSeconds(json) };
  } catch (error) {
    return { error: signal?.aborted || error?.name === "TimeoutError" ? "timeout" : "unavailable" };
  }
}
