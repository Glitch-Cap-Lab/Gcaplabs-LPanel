// Managed text-to-speech. A Cloud runtime's stock `tts.openai` provider posts an OpenAI-style JSON
// request; admission authenticates the account and forwards it here under the same signed assertion
// as chat. The relay sends only the text, voice, format and speed to the operator's speech server
// (Kokoro on the private network by default, any OpenAI-compatible /audio/speech otherwise) and
// returns the audio. The model is always the operator's choice. A priced server is metered to the
// wallet per input character, like transcription per second.

import { isIP } from "node:net";

export const SPEECH_PATH = "/v1/audio/speech";
export const SPEECH_MAX_INPUT_CHARS = 4096;
export const SPEECH_MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const FORMATS = new Set(["mp3", "opus", "aac", "flac", "wav", "pcm"]);
const VOICE = /^[A-Za-z0-9_.+-]{1,64}$/;

// Plain http only to a host that cannot be on the public internet: a compose service name or a private address.
function privateHost(hostname) {
  if (!hostname.includes(".") && !isIP(hostname)) return true;
  if (isIP(hostname) !== 4) return false;
  const [a, b] = hostname.split(".").map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function speechConfigFromEnv(env = process.env) {
  const raw = String(env.HEADMASTER_TTS_BASE_URL || "").trim();
  if (!raw) return null;
  let baseUrl;
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && privateHost(parsed.hostname))) return null;
    baseUrl = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
  } catch {
    return null;
  }
  const price = Number.parseFloat(String(env.HEADMASTER_TTS_USD_PER_MILLION_CHARS ?? ""));
  return {
    baseUrl,
    apiKey: String(env.HEADMASTER_TTS_API_KEY || "").trim() || null,
    model: String(env.HEADMASTER_TTS_MODEL || "kokoro").trim(),
    voice: String(env.HEADMASTER_TTS_VOICE || "af_heart").trim(),
    // Kokoro on our own server costs nothing per request; a paid server sets its USD per million characters.
    microUsdPerMillionChars: Math.round((Number.isFinite(price) && price >= 0 ? price : 0) * 1_000_000),
  };
}

export function speechCostMicroUsd(chars, config) {
  return Math.ceil((chars * config.microUsdPerMillionChars) / 1_000_000);
}

/** Validate the runtime's request. Returns { body, chars } (vendor JSON) or { error: "bad_request" }. */
export function prepareSpeech(buffer, config) {
  let incoming;
  try {
    incoming = JSON.parse(buffer.toString("utf8"));
  } catch {
    return { error: "bad_request" };
  }
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return { error: "bad_request" };
  const input = incoming.input;
  if (typeof input !== "string" || !input.trim() || input.length > SPEECH_MAX_INPUT_CHARS) return { error: "bad_request" };
  const format = incoming.response_format === undefined ? "mp3" : incoming.response_format;
  if (!FORMATS.has(format)) return { error: "bad_request" };
  const voice = typeof incoming.voice === "string" && VOICE.test(incoming.voice) ? incoming.voice : config.voice;
  const body = { model: config.model, input, voice, response_format: format };
  if (incoming.speed !== undefined) {
    const speed = Number(incoming.speed);
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) return { error: "bad_request" };
    body.speed = speed;
  }
  return { body, chars: input.length };
}

/** Resolves { audio, contentType } or { error: "bad_request" | "unavailable" | "timeout" }. Never throws. */
export async function callSpeechServer({ body, config, fetchImpl = fetch, signal }) {
  try {
    const upstream = await fetchImpl(`${config.baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
      redirect: "error",
    });
    if (!upstream.ok)
      return { error: upstream.status >= 500 || upstream.status === 429 ? "unavailable" : "bad_request" };
    const declared = Number(upstream.headers.get("content-length") || 0);
    if (declared > SPEECH_MAX_AUDIO_BYTES) return { error: "unavailable" };
    const audio = Buffer.from(await upstream.arrayBuffer());
    if (!audio.length || audio.length > SPEECH_MAX_AUDIO_BYTES) return { error: "unavailable" };
    const type = String(upstream.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    return { audio, contentType: /^audio\/[a-z0-9.+-]+$/.test(type) ? type : "application/octet-stream" };
  } catch (error) {
    return { error: signal?.aborted || error?.name === "TimeoutError" ? "timeout" : "unavailable" };
  }
}
