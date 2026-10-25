// Managed text-to-speech. A Cloud runtime's stock `tts.openai` provider posts an OpenAI-style JSON
// request; admission authenticates the account and forwards it here under the same signed assertion
// as chat. The relay sends only the text, voice, format and speed to the operator's speech server
// (Kokoro on the private network by default, any OpenAI-compatible /audio/speech otherwise) and
// returns the audio. The model is always the operator's choice. A priced server is metered to the
// wallet per input character, like transcription per second.
//
// The person picks the engine the upstream way, with the provider's model setting (tts.openai.model,
// sent as the OpenAI `model` field), like dictation: "munsit" goes to Munsit (Arabic) when its key is
// set, anything else to the speech server above. The voice is then a Munsit voice id.

import { isIP } from "node:net";
import { needsTranscode, transcodeWav } from "./transcode.mjs";

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

function microUsdPerMillion(raw) {
  const price = Number.parseFloat(String(raw ?? ""));
  return Math.round((Number.isFinite(price) && price >= 0 ? price : 0) * 1_000_000);
}

function speechServerFromEnv(env) {
  const raw = String(env.HEADMASTER_TTS_BASE_URL || "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && privateHost(parsed.hostname))) return null;
    return {
      baseUrl: `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, ""),
      apiKey: String(env.HEADMASTER_TTS_API_KEY || "").trim() || null,
      model: String(env.HEADMASTER_TTS_MODEL || "kokoro").trim(),
      voice: String(env.HEADMASTER_TTS_VOICE || "af_heart").trim(),
      // Kokoro on our own server costs nothing per request; a paid server sets its USD per million characters.
      microUsdPerMillionChars: microUsdPerMillion(env.HEADMASTER_TTS_USD_PER_MILLION_CHARS),
    };
  } catch {
    return null;
  }
}

// Munsit (Arabic): shares the dictation key and base URL. x-api-key auth, POST {base}/text-to-speech/{model},
// JSON { voice_id, text, stability, speed? }, answer a complete WAV file. Voice ids come from its own voice
// list (the catalog); a request that names none, or one the catalog does not know, gets the default.
function munsitFromEnv(env) {
  const apiKey = String(env.HEADMASTER_MUNSIT_API_KEY || "").trim();
  if (!apiKey) return null;
  let baseUrl;
  try {
    const parsed = new URL(String(env.HEADMASTER_MUNSIT_BASE_URL || "https://api.munsit.com/api/v1").trim());
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    baseUrl = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
  } catch {
    return null;
  }
  const stability = Number.parseFloat(String(env.HEADMASTER_MUNSIT_TTS_STABILITY ?? ""));
  return {
    baseUrl,
    apiKey,
    // Unset means the first model and voice of the engine's own catalog (speech-catalog.mjs).
    model: String(env.HEADMASTER_MUNSIT_TTS_MODEL || "").trim() || null,
    voice: String(env.HEADMASTER_MUNSIT_TTS_VOICE || "").trim() || null,
    stability: Number.isFinite(stability) && stability >= 0 && stability <= 1 ? stability : 0.5,
    microUsdPerMillionChars: microUsdPerMillion(env.HEADMASTER_MUNSIT_TTS_USD_PER_MILLION_CHARS),
  };
}

/** { server, munsit }, either of which may be null; null when neither is configured (the route is absent). */
export function speechConfigFromEnv(env = process.env) {
  const server = speechServerFromEnv(env);
  const munsit = munsitFromEnv(env);
  return server || munsit ? { server, munsit } : null;
}

export function speechCostMicroUsd(chars, config) {
  return Math.ceil((chars * config.microUsdPerMillionChars) / 1_000_000);
}

/** Validate the runtime's request. Returns { engine, body, chars } (vendor JSON) or { error: "bad_request" }. */
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
  let speed;
  if (incoming.speed !== undefined) {
    speed = Number(incoming.speed);
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) return { error: "bad_request" };
  }
  const engine =
    incoming.model === "munsit" && config.munsit
      ? { kind: "munsit", ...config.munsit }
      : config.server
        ? { kind: "server", ...config.server }
        : null;
  if (!engine) return { error: "bad_request" };
  const voice = typeof incoming.voice === "string" && VOICE.test(incoming.voice) ? incoming.voice : null;
  if (engine.kind === "munsit") {
    // The model and voice are filled in from the catalog by the caller. Munsit takes speed only between
    // 0.7 and 1.2 and answers WAV, which the caller converts to `format`.
    const body = { voice_id: voice, text: input, stability: engine.stability };
    if (speed !== undefined) body.speed = Math.min(1.2, Math.max(0.7, speed));
    return { engine, body, chars: input.length, format };
  }
  const body = { model: engine.model, input, voice: voice ?? engine.voice, response_format: format };
  if (speed !== undefined) body.speed = speed;
  return { engine, body, chars: input.length, format };
}

/**
 * Resolves { audio, contentType } or { error: "bad_request" | "unavailable" | "timeout" }. Never throws.
 * An engine that answers WAV only (Munsit) is converted to `format` by `transcode`.
 */
export async function callSpeechServer({ body, config, format = "wav", fetchImpl = fetch, signal, transcode = transcodeWav }) {
  const munsit = config.kind === "munsit";
  const url = munsit
    ? `${config.baseUrl}/text-to-speech/${encodeURIComponent(config.model)}`
    : `${config.baseUrl}/audio/speech`;
  const auth = munsit ? { "x-api-key": config.apiKey } : config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};
  try {
    const upstream = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
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
    if (munsit && needsTranscode(format)) return await transcode(audio, format);
    const type = String(upstream.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    return { audio, contentType: /^audio\/[a-z0-9.+-]+$/.test(type) ? type : "application/octet-stream" };
  } catch (error) {
    return { error: signal?.aborted || error?.name === "TimeoutError" ? "timeout" : "unavailable" };
  }
}
