import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { ASSERTION_AUDIENCE, sha256, signAssertion } from "./assertion.mjs";
import { createProviderKeyResolver } from "./byo.mjs";
import { createInferenceService } from "./lib.mjs";
import { createMemoryByoQuotaStore, createMemoryQuotaStore } from "./quota.mjs";
import { encryptProviderKey } from "./provider-key-crypto.mjs";

const ASSERTION_SECRET = "s".repeat(48);
const KEY_SECRET = "k".repeat(48);
const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = 1_800_000_000_000;
const NOW_S = NOW / 1000;
const SUPABASE = "https://headmaster.supabase.example";
const KEYS = { [OWNER]: "sk-owner-SECRET-1111", [OTHER]: "sk-other-SECRET-2222" };
const PATH = "/v1/realtime/session";

function assertion(body, extra, owner = OWNER) {
  return signAssertion(
    {
      v: extra.byo_provider === undefined ? 1 : 2,
      aud: ASSERTION_AUDIENCE,
      sub: owner,
      authorization_revision: "3",
      method: "POST",
      path: PATH,
      body_sha256: sha256(body),
      request_id: randomUUID(),
      nonce: randomBytes(16).toString("base64url"),
      iat: NOW_S,
      exp: NOW_S + 20,
      ...extra,
    },
    ASSERTION_SECRET,
  );
}

function row(owner, provider) {
  const ciphertext = encryptProviderKey({ secret: KEY_SECRET, ownerId: owner, provider, apiKey: KEYS[owner] });
  return { owner_id: owner, provider, ciphertext, revision: 1 };
}

async function setup(t, { rows, reply, byoQuotaStore } = {}) {
  const state = { rows: rows ?? [row(OWNER, "openai"), row(OTHER, "openai")], calls: [], logs: [] };
  const fetchImpl = async (url, init) => {
    const href = String(url);
    if (href.startsWith(SUPABASE)) {
      const q = new URL(href).searchParams;
      const owner = q.get("owner_id").slice(3);
      const provider = q.get("provider").slice(3);
      const hits = state.rows.filter((r) => r.owner_id === owner && r.provider === provider);
      return new Response(JSON.stringify(hits), { status: 200 });
    }
    state.calls.push({ url: href, init, body: JSON.parse(init.body) });
    if (reply) return reply(href, init);
    if (href.includes("generativelanguage"))
      return Response.json({ name: "auth_tokens/eph-gem", expireTime: new Date((NOW_S + 600) * 1000).toISOString() });
    return Response.json({ value: "ek_ephemeral", expires_at: NOW_S + 600 });
  };
  const logger = Object.fromEntries(["info", "warn", "error"].map((l) => [l, (...a) => state.logs.push(a)]));
  const service = createInferenceService({
    assertionSecret: ASSERTION_SECRET,
    resolveAssignment: async () => {
      throw new Error("must not be read");
    },
    resolveProvider: async () => {
      throw new Error("must not be read");
    },
    quotaStore: createMemoryQuotaStore({ now: () => NOW }),
    byoQuotaStore: byoQuotaStore || createMemoryByoQuotaStore({ now: () => NOW }),
    resolveOwnKey: createProviderKeyResolver({
      supabaseUrl: SUPABASE,
      serviceRoleKey: "service-role-key",
      secret: KEY_SECRET,
      fetchImpl,
      now: () => NOW,
      logger,
    }),
    fetchImpl,
    now: () => NOW,
    logger,
  });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  t.after(() => new Promise((resolve) => service.server.close(resolve)));
  const origin = `http://127.0.0.1:${service.server.address().port}`;
  state.mint = async (payload = {}, extra = { byo_provider: "openai" }, owner = OWNER) => {
    const body = Buffer.from(JSON.stringify(payload));
    const res = await fetch(`${origin}${PATH}`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", "x-headmaster-inference-assertion": assertion(body, extra, owner) },
    });
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) };
  };
  return state;
}

function noKeyLeak(state, res) {
  for (const key of Object.values(KEYS)) {
    assert.ok(!res.text.includes(key));
    assert.ok(!JSON.stringify(state.logs).includes(key));
  }
}

test("valid owner gets a short-lived OpenAI token minted with their own key", async (t) => {
  const state = await setup(t);
  const res = await state.mint({ model: "gpt-realtime" });
  assert.equal(res.status, 200);
  assert.equal(res.json.token, "ek_ephemeral");
  assert.equal(res.json.provider, "openai");
  assert.ok(res.json.expires_at <= NOW_S + 600);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].url, "https://api.openai.com/v1/realtime/client_secrets");
  assert.equal(state.calls[0].init.headers.authorization, `Bearer ${KEYS[OWNER]}`);
  assert.ok(state.calls[0].body.expires_after.seconds <= 600);
  noKeyLeak(state, res);
  const minted = state.logs.find((l) => l[0].includes("realtime session minted"));
  assert.deepEqual(minted[1], { ownerId: OWNER, provider: "openai" });
});

test("xAI and Gemini tokens are minted at their fixed endpoints", async (t) => {
  const state = await setup(t, { rows: [row(OWNER, "xai"), row(OWNER, "gemini")] });
  const x = await state.mint({}, { byo_provider: "xai" });
  assert.equal(x.status, 200);
  assert.equal(state.calls[0].url, "https://api.x.ai/v1/realtime/client_secrets");
  assert.equal(state.calls[0].init.headers.authorization, `Bearer ${KEYS[OWNER]}`);
  const g = await state.mint({ ttl_seconds: 99999 }, { byo_provider: "gemini" });
  assert.equal(g.status, 200);
  assert.equal(g.json.token, "auth_tokens/eph-gem");
  assert.equal(state.calls[1].url, "https://generativelanguage.googleapis.com/v1alpha/auth_tokens");
  assert.equal(state.calls[1].init.headers["x-goog-api-key"], KEYS[OWNER]);
  assert.ok(Date.parse(state.calls[1].body.expireTime) / 1000 <= NOW_S + 600);
  noKeyLeak(state, g);
});

test("no stored key gives a clear 404 and calls no provider", async (t) => {
  const state = await setup(t, { rows: [row(OTHER, "openai")] });
  const res = await state.mint();
  assert.equal(res.status, 404);
  assert.equal(res.json.error.code, "provider_key_missing");
  assert.equal(state.calls.length, 0);
});

test("another owner's key is never used", async (t) => {
  // A row filed under OWNER but encrypted for OTHER fails closed.
  const foreign = { ...row(OTHER, "openai"), owner_id: OWNER };
  const state = await setup(t, { rows: [foreign] });
  const res = await state.mint();
  assert.equal(res.status, 503);
  assert.equal(state.calls.length, 0);
  const ok = await (await setup(t)).mint({}, { byo_provider: "openai" }, OTHER);
  assert.equal(ok.status, 200);
});

test("a token the provider says outlives 10 minutes is refused", async (t) => {
  const state = await setup(t, { reply: () => Response.json({ value: "ek_long", expires_at: NOW_S + 3600 }) });
  const res = await state.mint({ ttl_seconds: 120 });
  assert.equal(res.status, 502);
  assert.equal(res.json.error.code, "provider_token_ttl_invalid");
  assert.ok(!res.text.includes("ek_long"));
  assert.equal(state.calls[0].body.expires_after.seconds, 120);
});

test("operator assertions, unsupported providers and extra fields are rejected", async (t) => {
  const state = await setup(t);
  assert.equal((await state.mint({}, {})).json.error.code, "realtime_requires_own_key");
  assert.equal((await state.mint({}, { byo_provider: "groq" })).json.error.code, "realtime_provider_unsupported");
  assert.equal((await state.mint({ owner_id: OTHER })).status, 400);
  assert.equal(state.calls.length, 0);
});

test("provider key rejection is reported without echoing the provider body", async (t) => {
  const state = await setup(t, { reply: () => new Response(`bad key ${KEYS[OWNER]}`, { status: 401 }) });
  const res = await state.mint();
  assert.equal(res.status, 502);
  assert.equal(res.json.error.code, "provider_key_rejected");
  noKeyLeak(state, res);
});

test("ttl above 600 s is clamped to 600 and the response says so", async (t) => {
  const state = await setup(t);
  const big = await state.mint({ ttl_seconds: 3600 });
  assert.equal(big.status, 200);
  assert.equal(big.json.ttl_seconds, 600);
  assert.equal(big.json.ttl_clamped, true);
  assert.equal(state.calls[0].body.expires_after.seconds, 600);
  const ok = await state.mint({ ttl_seconds: 600 });
  assert.equal(ok.json.ttl_seconds, 600);
  assert.equal(ok.json.ttl_clamped, false);
});

test("realtime mints use the own-key hourly request budget and release slots", async (t) => {
  const byoQuotaStore = createMemoryByoQuotaStore({ now: () => NOW, maxRequestsPerHour: 2 });
  const state = await setup(t, { byoQuotaStore });
  assert.equal((await state.mint()).status, 200);
  assert.equal(byoQuotaStore.inspect(OWNER).active, 0);
  assert.equal((await state.mint()).status, 200);
  const limited = await state.mint();
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.code, "request_budget_exceeded");
  assert.equal(state.calls.length, 2);
});
