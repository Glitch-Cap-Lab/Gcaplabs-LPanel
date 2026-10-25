import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { ASSERTION_AUDIENCE, sha256, signAssertion } from "./assertion.mjs";
import { createInferenceService } from "./lib.mjs";
import { createMemoryQuotaStore } from "./quota.mjs";
import { SPEECH_PATH, speechConfigFromEnv, speechCostMicroUsd } from "./speech.mjs";

const SECRET = "s".repeat(48);
const OWNER = "11111111-1111-4111-8111-111111111111";
const NOW = 1_800_000_000_000;
const FREE = { baseUrl: "http://headmaster-kokoro:8880/v1", apiKey: null, model: "kokoro", voice: "af_heart", microUsdPerMillionChars: 0 };
const PAID = { ...FREE, baseUrl: "https://tts.vendor.example/v1", apiKey: "vendor-secret-key", microUsdPerMillionChars: 22_000_000 };
const MUNSIT = { baseUrl: "https://api.munsit.com/api/v1", apiKey: "munsit-secret-key", model: "faseeh-v1-preview", voice: "ar-najdi-male-2", stability: 0.5, microUsdPerMillionChars: 0 };
const WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3]);
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

async function start(t, { vendor = () => new Response(AUDIO, { headers: { "content-type": "audio/mpeg" } }), wallet = null, speech = { server: FREE, munsit: null } } = {}) {
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
      return vendor(init);
    },
    walletStore: wallet,
    walletMode: "on",
    walletOtherMarkupBps: 10_000,
    speech,
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

test("model munsit goes to Munsit with the person's voice, WAV back, speed held to its range", async (t) => {
  const wallet = fakeWallet();
  const { origin, vendorCalls } = await start(t, {
    wallet,
    speech: { server: FREE, munsit: MUNSIT },
    vendor: () => new Response(WAV, { headers: { "content-type": "audio/wav" } }),
  });
  const res = await speak(origin, { model: "munsit", input: "مرحبا", voice: "ar-hijazi-female-1", response_format: "mp3", speed: 2 });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "audio/wav");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), WAV);
  assert.equal(vendorCalls[0].url, "https://api.munsit.com/api/v1/text-to-speech/faseeh-v1-preview");
  assert.equal(vendorCalls[0].init.headers["x-api-key"], "munsit-secret-key");
  assert.equal(vendorCalls[0].init.headers.authorization, undefined);
  assert.deepEqual(JSON.parse(vendorCalls[0].init.body), { voice_id: "ar-hijazi-female-1", text: "مرحبا", stability: 0.5, speed: 1.2 });
  assert.equal(wallet.log.reserves.length, 0);
});

test("a Munsit request with no valid voice gets the operator's default; other models stay on the speech server", async (t) => {
  const { origin, vendorCalls } = await start(t, { speech: { server: FREE, munsit: MUNSIT } });
  assert.equal((await speak(origin, { model: "munsit", input: "hi", voice: "bad voice!" })).status, 200);
  assert.equal(JSON.parse(vendorCalls[0].init.body).voice_id, "ar-najdi-male-2");
  assert.equal((await speak(origin, { model: "kokoro", input: "hi" })).status, 200);
  assert.equal(vendorCalls[1].url, "http://headmaster-kokoro:8880/v1/audio/speech");
});

test("Munsit alone enables the route; a priced Munsit call is held, settled, and released on failure", async (t) => {
  const priced = { ...MUNSIT, microUsdPerMillionChars: 30_000_000 };
  const wallet = fakeWallet();
  const { origin } = await start(t, { wallet, speech: { server: null, munsit: priced } });
  assert.equal((await speak(origin, { model: "munsit", input: "x".repeat(1000) })).status, 200);
  assert.equal(wallet.log.reserves[0].amountMicroUsd, speechCostMicroUsd(1000, priced));
  assert.equal(wallet.log.settles[0].detail.model, "faseeh-v1-preview");
  // Without the speech server, a non-Munsit model has nowhere to go.
  assert.equal((await speak(origin, { model: "kokoro", input: "hi" })).status, 400);

  const failing = fakeWallet();
  const down = await start(t, { wallet: failing, speech: { server: null, munsit: priced }, vendor: () => new Response("{}", { status: 429 }) });
  const res = await speak(down.origin, { model: "munsit", input: "hello" });
  assert.equal(res.status, 503);
  assert.equal(failing.log.settles[0].actualMicroUsd, 0);
});

test("speechConfigFromEnv: Munsit needs its key and https, shares the dictation base URL, and clamps stability", () => {
  assert.equal(speechConfigFromEnv({}), null);
  const config = speechConfigFromEnv({ HEADMASTER_MUNSIT_API_KEY: "k", HEADMASTER_MUNSIT_TTS_STABILITY: "7" });
  assert.equal(config.server, null);
  assert.equal(config.munsit.baseUrl, "https://api.munsit.com/api/v1");
  assert.equal(config.munsit.stability, 0.5);
  assert.equal(config.munsit.microUsdPerMillionChars, 0);
  assert.equal(speechConfigFromEnv({ HEADMASTER_MUNSIT_API_KEY: "k", HEADMASTER_MUNSIT_BASE_URL: "http://munsit.example/v1" }), null);
});
