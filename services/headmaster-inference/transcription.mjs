// Managed speech-to-text. A Cloud runtime's stock `stt.openai` provider posts an OpenAI-style
// multipart request; admission authenticates the account and forwards it here under the same signed
// assertion as chat. The relay holds the vendor key, reserves wallet credit before the vendor call
// and settles the real audio duration after it, like chat. Only the audio file and an optional
// language/prompt reach the vendor; the model is always the operator's choice.

export const TRANSCRIPTION_PATH = "/v1/audio/transcriptions";
export const TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;
// Vendors bill a minimum per request (Groq: 10 s). Reserve against a low-bitrate clip so the hold covers it.
const MIN_BILLED_SECONDS = 10;
const RESERVE_BYTES_PER_SECOND = 2_000;
const MAX_BILLED_SECONDS = 3 * 60 * 60;
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
const MAX_PROMPT_CHARS = 1000;

export function transcriptionConfigFromEnv(env = process.env) {
  const apiKey = String(env.HEADMASTER_STT_API_KEY || "").trim();
  if (!apiKey) return null;
  let baseUrl;
  try {
    const parsed = new URL(String(env.HEADMASTER_STT_BASE_URL || "https://api.groq.com/openai/v1"));
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash)
      return null;
    baseUrl = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
  } catch {
    return null;
  }
  const price = Number.parseFloat(String(env.HEADMASTER_STT_USD_PER_HOUR ?? ""));
  return {
    apiKey,
    baseUrl,
    model: String(env.HEADMASTER_STT_MODEL || "whisper-large-v3-turbo").trim(),
    // Vendor price, USD per audio hour (Groq whisper-large-v3-turbo: 0.04). Charged at the wallet's other-model markup.
    microUsdPerHour: Math.round((Number.isFinite(price) && price >= 0 ? price : 0.04) * 1_000_000),
  };
}

export function transcriptionCostMicroUsd(seconds, config) {
  const billed = Math.min(MAX_BILLED_SECONDS, Math.max(MIN_BILLED_SECONDS, Number.isFinite(seconds) ? seconds : 0));
  return Math.ceil((billed * config.microUsdPerHour) / 3600);
}

/** Upper-ish bound from the upload size alone, before the vendor has measured the audio. */
export function transcriptionReserveMicroUsd(byteLength, config) {
  return transcriptionCostMicroUsd(byteLength / RESERVE_BYTES_PER_SECOND, config);
}

/** Parse the upload. Resolves { form } (vendor request body) or { error: "bad_request" }. */
export async function prepareTranscription(body, contentType, config) {
  let incoming;
  try {
    incoming = await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch {
    return { error: "bad_request" };
  }
  const file = incoming.get("file");
  if (!file || typeof file === "string" || file.size === 0) return { error: "bad_request" };
  const form = new FormData();
  form.set("file", file, file.name || "audio.webm");
  form.set("model", config.model);
  // verbose_json carries the measured duration, which is what we bill.
  form.set("response_format", "verbose_json");
  const language = incoming.get("language");
  if (typeof language === "string" && LANGUAGE.test(language)) form.set("language", language);
  const prompt = incoming.get("prompt");
  if (typeof prompt === "string" && prompt) form.set("prompt", prompt.slice(0, MAX_PROMPT_CHARS));
  return { form, fileBytes: file.size };
}

/** Resolves { text, seconds } or { error: "bad_request" | "unavailable" | "timeout" }. Never throws. */
export async function callVendor({ form, config, fetchImpl = fetch, signal }) {
  try {
    const upstream = await fetchImpl(`${config.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal,
      redirect: "error",
    });
    if (!upstream.ok)
      return { error: upstream.status >= 500 || upstream.status === 429 ? "unavailable" : "bad_request" };
    const json = await upstream.json();
    if (typeof json?.text !== "string") return { error: "unavailable" };
    return { text: json.text, seconds: Number(json.duration) };
  } catch (error) {
    return { error: signal?.aborted || error?.name === "TimeoutError" ? "timeout" : "unavailable" };
  }
}
