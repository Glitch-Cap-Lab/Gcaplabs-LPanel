// The speech catalog: which engines the relay can speak with and every voice each one offers, read from
// the engines themselves and cached, so no client or default names a voice. A request that names no
// voice, or an operator who sets none, gets the first voice of the catalog (Arabic first). The catalog is
// served on GET /v1/audio/voices under the same signed assertion as the speech route.

export const SPEECH_CATALOG_PATH = "/v1/audio/voices";
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

const titled = (id) => id.charAt(0).toUpperCase() + id.slice(1);

async function getJson(url, headers, fetchImpl) {
  try {
    const res = await fetchImpl(url, { headers, redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const list = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : []);

// Arabic voices first (primary language, then any Arabic), then the rest; by name within a group.
function arabicRank(voice) {
  if (voice.languages[0] === "ar") return 0;
  return voice.languages.includes("ar") ? 1 : 2;
}
export function sortVoices(voices) {
  return [...voices].sort((a, b) => arabicRank(a) - arabicRank(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function munsitVoice(raw) {
  const id = text(raw?.voice_id);
  if (!id) return null;
  return {
    id,
    name: text(raw.name) ?? id,
    gender: text(raw.gender),
    dialects: list(raw.dialect),
    languages: list(raw.languages),
    sample_url: text(raw.sample_url),
  };
}

// An OpenAI-compatible speech server (Kokoro): { voices: [id, ...] }, or a bare array of ids.
function serverVoice(raw) {
  const id = text(raw);
  return id ? { id, name: id, gender: null, dialects: [], languages: [], sample_url: null } : null;
}

export function createSpeechCatalog({ config, fetchImpl = fetch, now = Date.now, ttlMs = DEFAULT_TTL_MS }) {
  const cache = new Map();

  // One cached read per engine; a failed refresh serves the last good answer.
  async function cached(key, read) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = await read();
    if (value) {
      cache.set(key, { at: now(), value });
      return value;
    }
    return hit?.value ?? null;
  }

  async function munsitEngine() {
    const { munsit } = config;
    const headers = { "x-api-key": munsit.apiKey };
    const voices = await cached("munsit:voices", async () => {
      const body = await getJson(`${munsit.baseUrl}/voices`, headers, fetchImpl);
      return Array.isArray(body) ? sortVoices(body.map(munsitVoice).filter(Boolean)) : null;
    });
    const models = await cached("munsit:models", async () => {
      const body = await getJson(`${munsit.baseUrl}/models`, headers, fetchImpl);
      const ids = Array.isArray(body) ? body.map((entry) => text(entry?.model_id)).filter(Boolean) : [];
      return ids.length ? ids : null;
    });
    return { id: "munsit", label: titled("munsit"), voices: voices ?? [], models: models ?? [] };
  }

  async function serverEngine() {
    const { server } = config;
    const voices = await cached("server:voices", async () => {
      const body = await getJson(
        `${server.baseUrl}/audio/voices`,
        server.apiKey ? { authorization: `Bearer ${server.apiKey}` } : {},
        fetchImpl,
      );
      const ids = Array.isArray(body) ? body : Array.isArray(body?.voices) ? body.voices : null;
      return ids ? sortVoices(ids.map(serverVoice).filter(Boolean)) : null;
    });
    return { id: server.model, label: titled(server.model), voices: voices ?? [], models: [server.model] };
  }

  /** { engines: [{ id, label, voices, models, default_voice }], default_engine }. */
  async function load() {
    const engines = [];
    if (config.server) engines.push(await serverEngine());
    if (config.munsit) engines.push(await munsitEngine());
    for (const engine of engines) {
      const configured = engine.id === "munsit" ? config.munsit?.voice : config.server?.voice;
      engine.default_voice = configured ?? engine.voices[0]?.id ?? null;
    }
    return { engines, default_engine: config.server ? config.server.model : "munsit" };
  }

  /**
   * The Munsit model and voice for one request. The requested voice stands when the catalog knows it (or the
   * catalog could not be read); otherwise the operator's setting, else the catalog's first (Arabic) voice.
   */
  async function munsitResolve(requestedVoice) {
    const engine = await munsitEngine();
    const known = engine.voices.length === 0 || engine.voices.some((voice) => voice.id === requestedVoice);
    return {
      model: config.munsit.model ?? engine.models[0] ?? null,
      voice: requestedVoice && known ? requestedVoice : (config.munsit.voice ?? engine.voices[0]?.id ?? null),
    };
  }

  return { load, munsitResolve };
}
