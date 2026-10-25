import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { ASSERTION_AUDIENCE, sha256, signAssertion } from "./assertion.mjs";
import { createInferenceService } from "./lib.mjs";
import { createMemoryQuotaStore } from "./quota.mjs";
import {
  TRANSCRIPTION_PATH,
  transcriptionConfigFromEnv,
  transcriptionCostMicroUsd,
  transcriptionReserveMicroUsd,
} from "./transcription.mjs";

const SECRET = "s".repeat(48);
const OWNER = "11111111-1111-4111-8111-111111111111";
const NOW = 1_800_000_000_000;
const VENDOR_KEY = "vendor-secret-key";
const CONFIG = { apiKey: VENDOR_KEY, baseUrl: "https://stt.vendor.example/openai/v1", model: "whisper-large-v3-turbo", microUsdPerHour: 40_000, responseFormat: "verbose_json" };

function token(body, extra = {}) {
  const iat = Math.floor(NOW / 1000);
  return signAssertion(
    {
      v: 1, aud: ASSERTION_AUDIENCE, sub: OWNER, authorization_revision: "7", method: "POST", path: TRANSCRIPTION_PATH,
      body_sha256: sha256(body), request_id: randomUUID(), nonce: randomBytes(16).toString("base64url"), iat, exp: iat + 20, ...extra,
    },
    SECRET,
  );
}

async function start(t, { vendor, wallet = null, walletMode = "on", transcription = CONFIG, otherBps = 11_000, markupBps = 10_000 } = {}) {
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
    walletMode,
    walletMarkupBps: markupBps,
    walletOtherMarkupBps: otherBps,
    transcription,
  });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  t.after(() => new Promise((resolve) => service.server.close(resolve)));
  return { origin: `http://127.0.0.1:${service.server.address().port}`, vendorCalls };
}

async function upload(origin, { seconds = 30, extra, fields = {}, file = new Blob([new Uint8Array(60_000)], { type: "audio/wav" }), contentType, claims } = {}) {
  const form = new FormData();
  if (file) form.set("file", file, "clip.wav");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const encoded = new Response(form);
  const body = Buffer.from(await encoded.arrayBuffer());
  return fetch(`${origin}${TRANSCRIPTION_PATH}`, {
    method: "POST",
    headers: { "content-type": contentType ?? encoded.headers.get("content-type"), "x-headmaster-inference-assertion": token(body, claims) },
    body,
  });
}

const vendorOk = (seconds = 30) => () => new Response(JSON.stringify({ text: "hello there", duration: seconds, segments: ["x"] }), { status: 200 });

function fakeWallet({ allowed = true, reason = null } = {}) {
  const log = { reserves: [], settles: [] };
  return {
    log,
    async reserve(args) { log.reserves.push(args); return { allowed, reason, balanceMicroUsd: 0, freeMicroUsd: 0 }; },
    async settle(args) { log.settles.push(args); },
  };
}

test("holds from the upload size, settles on measured seconds at the other-model markup", async (t) => {
  const wallet = fakeWallet();
  const { origin, vendorCalls } = await start(t, { vendor: vendorOk(30), wallet });
  const res = await upload(origin, { fields: { model: "whisper-1", language: "en", temperature: "1" } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: "hello there" });
  assert.equal(vendorCalls[0].url, "https://stt.vendor.example/openai/v1/audio/transcriptions");
  assert.equal(vendorCalls[0].init.headers.authorization, `Bearer ${VENDOR_KEY}`);
  assert.equal(vendorCalls[0].init.body.get("model"), CONFIG.model);
  assert.equal(vendorCalls[0].init.body.get("response_format"), "verbose_json");
  assert.equal(vendorCalls[0].init.body.get("temperature"), null);
  assert.equal(wallet.log.reserves.length, 1);
  assert.equal(wallet.log.reserves[0].ownerId, OWNER);
  assert.equal(wallet.log.reserves[0].amountMicroUsd, Math.ceil(transcriptionReserveMicroUsd(60_000, CONFIG) * 1.1));
  const expected = Math.ceil(transcriptionCostMicroUsd(30, CONFIG) * 1.1);
  assert.equal(wallet.log.settles[0].actualMicroUsd, expected);
  assert.equal(wallet.log.settles[0].detail.kind, "transcription");
});

test("a vendor that reports usage.seconds (OpenRouter shape) is billed on it", async (t) => {
  const wallet = fakeWallet();
  const { origin, vendorCalls } = await start(t, {
    vendor: () => new Response(JSON.stringify({ text: "hi", usage: { seconds: 60 } }), { status: 200 }),
    wallet,
    transcription: { ...CONFIG, responseFormat: "json" },
  });
  assert.equal((await upload(origin)).status, 200);
  assert.equal(vendorCalls[0].init.body.get("response_format"), "json");
  assert.equal(wallet.log.settles[0].actualMicroUsd, Math.ceil(transcriptionCostMicroUsd(60, CONFIG) * 1.1));
});

test("a vendor that reports no duration is billed on the clip size, never zero", async (t) => {
  const wallet = fakeWallet();
  const { origin } = await start(t, { vendor: () => new Response(JSON.stringify({ text: "hi" }), { status: 200 }), wallet });
  assert.equal((await upload(origin)).status, 200);
  assert.ok(wallet.log.settles[0].actualMicroUsd > 0);
});

test("short clips are billed the vendor minimum", () => {
  assert.equal(transcriptionCostMicroUsd(1, CONFIG), transcriptionCostMicroUsd(10, CONFIG));
  assert.ok(transcriptionCostMicroUsd(3600, CONFIG) === 40_000);
});

test("an empty wallet refuses before any vendor call", async (t) => {
  const wallet = fakeWallet({ allowed: false, reason: "insufficient_credit" });
  const { origin, vendorCalls } = await start(t, { vendor: vendorOk(), wallet });
  const res = await upload(origin);
  assert.equal(res.status, 402);
  assert.equal(vendorCalls.length, 0);
  assert.equal(wallet.log.settles.length, 0);
});

test("a suspended organization is refused", async (t) => {
  const wallet = fakeWallet({ allowed: false, reason: "org_suspended" });
  const { origin } = await start(t, { vendor: vendorOk(), wallet });
  assert.equal((await upload(origin)).status, 403);
});

test("a failed vendor call releases the hold at no charge and leaks nothing", async (t) => {
  const wallet = fakeWallet();
  const { origin } = await start(t, { vendor: () => new Response("boom vendor-secret", { status: 500 }), wallet });
  const res = await upload(origin);
  assert.equal(res.status, 503);
  const text = await res.text();
  assert.equal(text.includes("boom"), false);
  assert.equal(text.includes(VENDOR_KEY), false);
  assert.equal(wallet.log.settles[0].actualMicroUsd, 0);
});

test("route is absent without a vendor key", async (t) => {
  const { origin } = await start(t, { vendor: vendorOk(), transcription: null });
  assert.equal((await upload(origin)).status, 404);
});

test("rejects non-multipart, missing audio and a personal-key claim", async (t) => {
  const { origin, vendorCalls } = await start(t, { vendor: vendorOk() });
  assert.equal((await upload(origin, { contentType: "application/json" })).status, 415);
  assert.equal((await upload(origin, { file: null })).status, 400);
  assert.equal((await upload(origin, { claims: { v: 2, byo_provider: "openai" } })).status, 400);
  assert.equal(vendorCalls.length, 0);
});

test("config needs a key and an https base", () => {
  assert.equal(transcriptionConfigFromEnv({}), null);
  assert.equal(transcriptionConfigFromEnv({ HEADMASTER_STT_API_KEY: "k", HEADMASTER_STT_BASE_URL: "http://x.example/v1" }), null);
  const cfg = transcriptionConfigFromEnv({ HEADMASTER_STT_API_KEY: "k" });
  assert.equal(cfg.baseUrl, "https://api.groq.com/openai/v1");
  assert.equal(cfg.microUsdPerHour, 40_000);
});

const MUNSIT = { kind: "munsit", apiKey: "munsit-secret-key", baseUrl: "https://api.munsit.example/api/v1", model: "munsit", microUsdPerHour: 0, languages: [] };
const munsitVendor = (init) => init.headers["x-api-key"]
  ? new Response(JSON.stringify({ statusCode: 200, data: { transcriptionId: "t1", transcription: "مرحبا" } }), { status: 200 })
  : vendorOk(5)();

test("choosing the munsit model sends dictation in any language to Munsit with its own auth and answer shape", async (t) => {
  const { origin, vendorCalls } = await start(t, { vendor: munsitVendor, transcription: { ...CONFIG, munsit: MUNSIT } });

  const chosen = await upload(origin, { fields: { model: "munsit", language: "en", prompt: "names" } });
  assert.equal(chosen.status, 200);
  assert.deepEqual(await chosen.json(), { text: "مرحبا" });
  assert.equal(vendorCalls[0].url, "https://api.munsit.example/api/v1/audio/transcribe");
  assert.equal(vendorCalls[0].init.headers["x-api-key"], "munsit-secret-key");
  assert.equal(vendorCalls[0].init.headers.authorization, undefined);
  assert.equal(vendorCalls[0].init.body.get("model"), "munsit");
  assert.equal(vendorCalls[0].init.body.get("prompt"), null);

  // Any other model, or none, stays on the default engine; a language alone does not switch engines.
  for (const fields of [{ model: "whisper-1", language: "ar" }, { language: "ar" }]) {
    assert.equal((await upload(origin, { fields })).status, 200);
    assert.equal(vendorCalls.at(-1).url, "https://stt.vendor.example/openai/v1/audio/transcriptions");
    assert.equal(vendorCalls.at(-1).init.headers["x-api-key"], undefined);
    assert.equal(vendorCalls.at(-1).init.body.get("model"), CONFIG.model);
  }
});

test("Munsit dictation is billed at the Headmaster markup, other engines at their own, never both", async (t) => {
  // The owner's rate: 100 credits a minute at $0.00004 a credit = $0.24 an hour.
  const priced = { ...MUNSIT, microUsdPerHour: 240_000 };
  const timed = (init) => (init.headers["x-api-key"]
    ? new Response(JSON.stringify({ data: { transcription: "مرحبا", duration: 60 } }), { status: 200 })
    : vendorOk(60)());
  const wallet = fakeWallet();
  const { origin } = await start(t, { vendor: timed, wallet, markupBps: 12_500, otherBps: 11_000, transcription: { ...CONFIG, munsit: priced } });
  assert.equal((await upload(origin, { fields: { model: "munsit" } })).status, 200);
  // One minute is $0.004 raw; +25% is $0.005.
  assert.equal(transcriptionCostMicroUsd(60, priced), 4_000);
  assert.equal(wallet.log.settles[0].actualMicroUsd, 5_000);
  assert.equal(wallet.log.reserves[0].amountMicroUsd, Math.ceil(transcriptionReserveMicroUsd(60_000, priced) * 1.25));

  assert.equal((await upload(origin, { fields: { model: "whisper-1" } })).status, 200);
  assert.equal(wallet.log.settles[1].actualMicroUsd, Math.ceil(transcriptionCostMicroUsd(60, CONFIG) * 1.1));
});

test("an operator may route chosen languages to Munsit", async (t) => {
  const { origin, vendorCalls } = await start(t, { vendor: munsitVendor, transcription: { ...CONFIG, munsit: { ...MUNSIT, languages: ["ar"] } } });
  assert.equal((await upload(origin, { fields: { language: "ar-SA" } })).status, 200);
  assert.equal(vendorCalls[0].url, "https://api.munsit.example/api/v1/audio/transcribe");
});

test("without a Munsit key the munsit model stays on the default vendor", async (t) => {
  const { origin, vendorCalls } = await start(t, { vendor: vendorOk(5) });
  assert.equal((await upload(origin, { fields: { model: "munsit", language: "ar" } })).status, 200);
  assert.equal(vendorCalls[0].url, "https://stt.vendor.example/openai/v1/audio/transcriptions");
  assert.equal(vendorCalls[0].init.body.get("language"), "ar");
});

test("Munsit config needs its key and an https base; language routing is off unless listed", () => {
  assert.equal(transcriptionConfigFromEnv({ HEADMASTER_STT_API_KEY: "k" }).munsit, null);
  assert.deepEqual(transcriptionConfigFromEnv({ HEADMASTER_STT_API_KEY: "k", HEADMASTER_MUNSIT_API_KEY: "m" }).munsit.languages, []);
  const config = transcriptionConfigFromEnv({ HEADMASTER_STT_API_KEY: "k", HEADMASTER_MUNSIT_API_KEY: "m", HEADMASTER_MUNSIT_LANGUAGES: "ar, ar-SA" });
  assert.equal(config.munsit.baseUrl, "https://api.munsit.com/api/v1");
  assert.deepEqual(config.munsit.languages, ["ar", "ar-sa"]);
  assert.equal(transcriptionConfigFromEnv({ HEADMASTER_STT_API_KEY: "k", HEADMASTER_MUNSIT_API_KEY: "m", HEADMASTER_MUNSIT_BASE_URL: "http://x.example" }).munsit, null);
});
