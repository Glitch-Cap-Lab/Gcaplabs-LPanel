import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { ASSERTION_AUDIENCE, sha256, signAssertion } from "./assertion.mjs";
import { createInferenceService } from "./lib.mjs";
import { createMemoryQuotaStore } from "./quota.mjs";
import { SPEECH_PATH, speechConfigFromEnv, speechCostMicroUsd } from "./speech.mjs";
import { SPEECH_CATALOG_PATH } from "./speech-catalog.mjs";

const SECRET = "s".repeat(48);
const OWNER = "11111111-1111-4111-8111-111111111111";
const NOW = 1_800_000_000_000;
const FREE = { baseUrl: "http://headmaster-kokoro:8880/v1", apiKey: null, model: "kokoro", voice: "af_heart", microUsdPerMillionChars: 0 };
const PAID = { ...FREE, baseUrl: "https://tts.vendor.example/v1", apiKey: "vendor-secret-key", microUsdPerMillionChars: 22_000_000 };
// No model or voice here: the relay takes them from the engine's own catalog unless the operator sets them.
const MUNSIT = { baseUrl: "https://api.munsit.com/api/v1", apiKey: "munsit-secret-key", model: null, voice: null, label: "Arabic", stability: 0.5, microUsdPerMillionChars: 0 };
const MUNSIT_VOICES = [
  { voice_id: "en-first", name: "Adam", languages: ["en", "ar"], dialect: ["american"], gender: "male", sample_url: "https://x/en.mp3" },
  { voice_id: "ar-second", name: "Zaid", languages: ["ar", "en"], dialect: ["najdi"], gender: "male", sample_url: "https://x/z.mp3" },
  { voice_id: "ar-first", name: "Amal", languages: ["ar", "en"], dialect: ["fusha"], gender: "female", sample_url: "https://x/a.mp3" },
];
const MUNSIT_MODELS = [{ id: "uuid-1", model_id: "model-one", model_name: "One", description: null }];
const WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3]);
const CONVERTED = new Uint8Array([0x49, 0x44, 0x33, 9, 9]);

// A fake Munsit: the catalog reads, and the WAV synthesis.
function munsitVendor(init, url) {
  if (String(url).endsWith("/voices")) return Response.json(MUNSIT_VOICES);
  if (String(url).endsWith("/models")) return Response.json(MUNSIT_MODELS);
  return new Response(WAV, { headers: { "content-type": "audio/wav" } });
}
const AUDIO = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]);

function token(body, extra = {}) {
  const iat = Math.floor(NOW / 1000);
  return signAssertion(
    {
      v: 1, aud: ASSERTION_AUDIENCE, sub: OWNER, authorization_revision: "7", method: "POST", path: SPEECH_PATH,
      body_sha256: sha256(body), request_id: randomUUID(), nonce: randomBytes(16).toString("base64url"), iat, exp: iat + 20, ...extra,
    },
    SECRET,
  );
}

async function start(
  t,
  {
    vendor = () => new Response(AUDIO, { headers: { "content-type": "audio/mpeg" } }),
    wallet = null,
    speech = { server: FREE, munsit: null },
    transcode = async () => ({ audio: Buffer.from(CONVERTED), contentType: "audio/mpeg" }),
  } = {},
) {
  const vendorCalls = [];
  const service = createInferenceService({
    assertionSecret: SECRET,
    accountProviderMap: new Map(),
    resolveProvider: async () => null,
    quotaStore: createMemoryQuotaStore({ now: () => NOW }),
    now: () => NOW,
    logger: { info() {}, warn() {}, error() {} },
    fetchImpl: async (url, init) => {
      vendorCalls.push({ url, init });
      return vendor(init, url);
    },
    walletStore: wallet,
    walletMode: "on",
    walletMarkupBps: 12_500,
    walletOtherMarkupBps: 10_000,
    speech,
    transcode,
  });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  t.after(() => new Promise((resolve) => service.server.close(resolve)));
  return { origin: `http://127.0.0.1:${service.server.address().port}`, vendorCalls };
}

function speak(origin, payload, { contentType = "application/json", claims } = {}) {
  const body = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
  return fetch(`${origin}${SPEECH_PATH}`, {
    method: "POST",
    headers: { "content-type": contentType, "x-headmaster-inference-assertion": token(body, claims) },
    body,
  });
}

function fakeWallet({ allowed = true } = {}) {
  const log = { reserves: [], settles: [] };
  return {
    log,
    async reserve(args) { log.reserves.push(args); return { allowed, reason: null, balanceMicroUsd: 0, freeMicroUsd: 0 }; },
    async settle(args) { log.settles.push(args); },
  };
}

test("returns the speech server's audio and sends only text, voice, format and speed under the operator's model", async (t) => {
  const wallet = fakeWallet();
  const { origin, vendorCalls } = await start(t, { wallet });
  const res = await speak(origin, { model: "gpt-4o-mini-tts", input: "Hello there", voice: "af_bella", response_format: "mp3", speed: 1.2, instructions: "whisper" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "audio/mpeg");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), AUDIO);
  assert.equal(vendorCalls[0].url, "http://headmaster-kokoro:8880/v1/audio/speech");
  assert.deepEqual(JSON.parse(vendorCalls[0].init.body), { model: "kokoro", input: "Hello there", voice: "af_bella", response_format: "mp3", speed: 1.2 });
  assert.equal(vendorCalls[0].init.headers.authorization, undefined);
  // A free speech server never touches the wallet.
  assert.equal(wallet.log.reserves.length, 0);
});

test("a priced server holds and settles the character cost; a failed call is not charged", async (t) => {
  const wallet = fakeWallet();
  const { origin, vendorCalls } = await start(t, { wallet, speech: { server: PAID, munsit: null } });
  assert.equal((await speak(origin, { input: "x".repeat(1000) })).status, 200);
  assert.equal(vendorCalls[0].init.headers.authorization, "Bearer vendor-secret-key");
  assert.equal(wallet.log.reserves[0].amountMicroUsd, speechCostMicroUsd(1000, PAID));
  assert.equal(wallet.log.settles[0].actualMicroUsd, speechCostMicroUsd(1000, PAID));

  const failing = fakeWallet();
  const down = await start(t, { wallet: failing, speech: { server: PAID, munsit: null }, vendor: () => new Response("no", { status: 503 }) });
  const res = await speak(down.origin, { input: "hello" });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "speech_unavailable");
  assert.equal(failing.log.settles[0].actualMicroUsd, 0);
});

test("an empty wallet refuses a priced call before the server is reached", async (t) => {
  const { origin, vendorCalls } = await start(t, { wallet: fakeWallet({ allowed: false }), speech: { server: PAID, munsit: null } });
  assert.equal((await speak(origin, { input: "hello" })).status, 402);
  assert.equal(vendorCalls.length, 0);
});

test("refuses bad text, formats and content types without calling the server", async (t) => {
  const { origin, vendorCalls } = await start(t);
  for (const payload of [{ input: "" }, { input: "x".repeat(5000) }, { input: "hi", response_format: "ogg" }, { input: "hi", speed: 9 }, "not json"]) {
    assert.equal((await speak(origin, payload)).status, 400);
  }
  assert.equal((await speak(origin, { input: "hi" }, { contentType: "text/plain" })).status, 415);
  assert.equal((await speak(origin, { input: "hi" }, { claims: { v: 2, byo_provider: "openai" } })).status, 400);
  assert.equal(vendorCalls.length, 0);
});

test("the route is absent without a configured speech server", async (t) => {
  const { origin } = await start(t, { speech: null });
  assert.equal((await speak(origin, { input: "hi" })).status, 404);
});

test("config takes https anywhere and plain http only to a private host", () => {
  assert.equal(speechConfigFromEnv({}), null);
  assert.equal(speechConfigFromEnv({ HEADMASTER_TTS_BASE_URL: "http://headmaster-kokoro:8880/v1" }).server.baseUrl, "http://headmaster-kokoro:8880/v1");
  assert.equal(speechConfigFromEnv({ HEADMASTER_TTS_BASE_URL: "http://172.23.0.9:8880/v1/" }).server.baseUrl, "http://172.23.0.9:8880/v1");
  assert.equal(speechConfigFromEnv({ HEADMASTER_TTS_BASE_URL: "http://tts.example.com/v1" }), null);
  assert.equal(speechConfigFromEnv({ HEADMASTER_TTS_BASE_URL: "https://user:pw@tts.example.com/v1" }), null);
  const paid = speechConfigFromEnv({ HEADMASTER_TTS_BASE_URL: "https://api.groq.com/openai/v1", HEADMASTER_TTS_USD_PER_MILLION_CHARS: "22", HEADMASTER_TTS_API_KEY: "k" }).server;
  assert.equal(paid.microUsdPerMillionChars, 22_000_000);
  assert.equal(paid.apiKey, "k");
});

const synth = (calls) => calls.filter((call) => call.init.method === "POST");

test("model munsit goes to Munsit with the person's catalog voice, converted to the asked format, speed held to its range", async (t) => {
  const converted = [];
  const { origin, vendorCalls } = await start(t, {
    speech: { server: FREE, munsit: MUNSIT },
    vendor: munsitVendor,
    transcode: async (wav, format) => {
      converted.push({ wav: new Uint8Array(wav), format });
      return { audio: Buffer.from(CONVERTED), contentType: "audio/mpeg" };
    },
  });
  const res = await speak(origin, { model: "munsit", input: "مرحبا", voice: "ar-second", response_format: "mp3", speed: 2 });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "audio/mpeg");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), CONVERTED);
  assert.deepEqual(converted, [{ wav: WAV, format: "mp3" }]);
  const [call] = synth(vendorCalls);
  // The model is the catalog's first, since the operator set none.
  assert.equal(call.url, "https://api.munsit.com/api/v1/text-to-speech/model-one");
  assert.equal(call.init.headers["x-api-key"], "munsit-secret-key");
  assert.equal(call.init.headers.authorization, undefined);
  assert.deepEqual(JSON.parse(call.init.body), { voice_id: "ar-second", text: "مرحبا", stability: 0.5, speed: 1.2 });
});

test("a WAV request passes Munsit's audio through unconverted", async (t) => {
  const { origin } = await start(t, {
    speech: { server: FREE, munsit: MUNSIT },
    vendor: munsitVendor,
    transcode: async () => assert.fail("wav must not be converted"),
  });
  const res = await speak(origin, { model: "munsit", input: "hi", response_format: "wav" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "audio/wav");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), WAV);
});

test("a failed conversion is a temporary outage and is not charged", async (t) => {
  const wallet = fakeWallet();
  const priced = { ...MUNSIT, microUsdPerMillionChars: 80_000_000 };
  const { origin } = await start(t, {
    wallet,
    speech: { server: null, munsit: priced },
    vendor: munsitVendor,
    transcode: async () => ({ error: "unavailable" }),
  });
  const res = await speak(origin, { model: "munsit", input: "hello" });
  assert.equal(res.status, 503);
  assert.equal(wallet.log.settles[0].actualMicroUsd, 0);
});

test("no voice, or one the catalog does not know, gets the first Arabic voice; other models stay on the speech server", async (t) => {
  const { origin, vendorCalls } = await start(t, { speech: { server: FREE, munsit: MUNSIT }, vendor: munsitVendor });
  for (const voice of [undefined, "af_heart", "bad voice!"]) {
    assert.equal((await speak(origin, { model: "munsit", input: "hi", voice })).status, 200);
  }
  const [a, b, c] = synth(vendorCalls);
  assert.deepEqual([a, b, c].map((call) => JSON.parse(call.init.body).voice_id), ["ar-first", "ar-first", "ar-first"]);
  assert.equal((await speak(origin, { model: "kokoro", input: "hi" })).status, 200);
  assert.equal(synth(vendorCalls)[3].url, "http://headmaster-kokoro:8880/v1/audio/speech");
});

test("the operator's model and voice settings beat the catalog's first", async (t) => {
  const { origin, vendorCalls } = await start(t, {
    speech: { server: null, munsit: { ...MUNSIT, model: "pinned-model", voice: "en-first" } },
    vendor: munsitVendor,
  });
  assert.equal((await speak(origin, { model: "munsit", input: "hi", voice: "nope" })).status, 200);
  const [call] = synth(vendorCalls);
  assert.equal(call.url, "https://api.munsit.com/api/v1/text-to-speech/pinned-model");
  assert.equal(JSON.parse(call.init.body).voice_id, "en-first");
});

test("Munsit alone enables the route; a priced call is held and settled at the Headmaster markup, once", async (t) => {
  // The owner's rate: 2 credits a character at $0.00004 a credit = $80 per million characters.
  const priced = { ...MUNSIT, microUsdPerMillionChars: 80_000_000 };
  const wallet = fakeWallet();
  const { origin } = await start(t, { wallet, speech: { server: null, munsit: priced }, vendor: munsitVendor });
  assert.equal((await speak(origin, { model: "munsit", input: "x".repeat(1000) })).status, 200);
  // 1000 characters cost $0.08 raw; +25% is $0.10 (not the 10% of other models, and not applied twice).
  assert.equal(speechCostMicroUsd(1000, priced), 80_000);
  assert.equal(wallet.log.reserves[0].amountMicroUsd, 100_000);
  assert.equal(wallet.log.settles[0].actualMicroUsd, 100_000);
  assert.equal(wallet.log.settles[0].detail.model, "model-one");
  // Without the speech server, a non-Munsit model has nowhere to go.
  assert.equal((await speak(origin, { model: "kokoro", input: "hi" })).status, 400);
});

test("a rate-limited Munsit call is a temporary outage and releases the hold", async (t) => {
  const failing = fakeWallet();
  const priced = { ...MUNSIT, microUsdPerMillionChars: 80_000_000 };
  const down = await start(t, {
    wallet: failing,
    speech: { server: null, munsit: priced },
    vendor: (init, url) => (String(url).includes("/text-to-speech/") ? new Response("{}", { status: 429 }) : munsitVendor(init, url)),
  });
  const res = await speak(down.origin, { model: "munsit", input: "hello" });
  assert.equal(res.status, 503);
  assert.equal(failing.log.settles[0].actualMicroUsd, 0);
});

test("with no model or voice anywhere, Munsit is unavailable rather than guessing", async (t) => {
  const { origin } = await start(t, { speech: { server: null, munsit: MUNSIT }, vendor: () => new Response("{}", { status: 500 }) });
  assert.equal((await speak(origin, { model: "munsit", input: "hi" })).status, 503);
});

function catalogRequest(origin) {
  const body = Buffer.alloc(0);
  return fetch(`${origin}${SPEECH_CATALOG_PATH}`, {
    method: "GET",
    headers: { "x-headmaster-inference-assertion": token(body, { method: "GET", path: SPEECH_CATALOG_PATH }) },
  });
}

test("the catalog lists every voice, Arabic first, with the first Arabic voice as the default", async (t) => {
  const { origin } = await start(t, { speech: { server: FREE, munsit: MUNSIT }, vendor: (init, url) => (String(url).endsWith("/audio/voices") ? Response.json({ voices: ["af_heart", "am_adam"] }) : munsitVendor(init, url)) });
  const res = await catalogRequest(origin);
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.deepEqual(data.engines.map((engine) => engine.id), ["kokoro", "munsit"]);
  assert.deepEqual(data.engines[0].voices.map((voice) => voice.id), ["af_heart", "am_adam"]);
  const munsit = data.engines[1];
  assert.deepEqual(munsit.voices.map((voice) => voice.id), ["ar-first", "ar-second", "en-first"]);
  assert.equal(munsit.default_voice, "ar-first");
  // People see the language, never the vendor; a speech server shows its model name unless labelled.
  assert.equal(munsit.label, "Arabic");
  assert.equal(data.engines[0].label, "Kokoro");
  assert.equal(JSON.stringify(data.engines.map((engine) => engine.label)).toLowerCase().includes("munsit"), false);
  assert.deepEqual(munsit.models, ["model-one"]);
  assert.equal(munsit.voices[0].sample_url, "https://x/a.mp3");
  assert.equal(JSON.stringify(data).includes("munsit-secret-key"), false);
});

test("the catalog serves its last good answer when the engine is down, and is absent without a speech config", async (t) => {
  let down = false;
  const { origin, vendorCalls } = await start(t, { speech: { server: null, munsit: MUNSIT }, vendor: (init, url) => (down ? new Response("no", { status: 500 }) : munsitVendor(init, url)) });
  assert.equal((await (await catalogRequest(origin)).json()).data.engines[0].voices.length, 3);
  down = true;
  // Cached for ten minutes, so the second read makes no engine calls at all.
  const before = vendorCalls.length;
  assert.equal((await (await catalogRequest(origin)).json()).data.engines[0].voices.length, 3);
  assert.equal(vendorCalls.length, before);

  const none = await start(t, { speech: null });
  assert.equal((await catalogRequest(none.origin)).status, 404);
});

test("speechConfigFromEnv: Munsit needs its key and https, shares the dictation base URL, and sets no model or voice itself", () => {
  assert.equal(speechConfigFromEnv({}), null);
  const config = speechConfigFromEnv({ HEADMASTER_MUNSIT_API_KEY: "k", HEADMASTER_MUNSIT_TTS_STABILITY: "7" });
  assert.equal(config.server, null);
  assert.equal(config.munsit.baseUrl, "https://api.munsit.com/api/v1");
  assert.equal(config.munsit.model, null);
  assert.equal(config.munsit.voice, null);
  assert.equal(config.munsit.label, "Arabic");
  const labelled = speechConfigFromEnv({ HEADMASTER_MUNSIT_API_KEY: "k", HEADMASTER_MUNSIT_TTS_LABEL: "Gulf Arabic", HEADMASTER_TTS_BASE_URL: "http://headmaster-kokoro:8880/v1", HEADMASTER_TTS_LABEL: "English and more" });
  assert.deepEqual([labelled.munsit.label, labelled.server.label], ["Gulf Arabic", "English and more"]);
  assert.equal(config.munsit.stability, 0.5);
  assert.equal(config.munsit.microUsdPerMillionChars, 0);
  const set = speechConfigFromEnv({ HEADMASTER_MUNSIT_API_KEY: "k", HEADMASTER_MUNSIT_TTS_MODEL: "m", HEADMASTER_MUNSIT_TTS_VOICE: "v", HEADMASTER_MUNSIT_TTS_USD_PER_MILLION_CHARS: "80" });
  assert.deepEqual([set.munsit.model, set.munsit.voice, set.munsit.microUsdPerMillionChars], ["m", "v", 80_000_000]);
  assert.equal(speechConfigFromEnv({ HEADMASTER_MUNSIT_API_KEY: "k", HEADMASTER_MUNSIT_BASE_URL: "http://munsit.example/v1" }), null);
});
