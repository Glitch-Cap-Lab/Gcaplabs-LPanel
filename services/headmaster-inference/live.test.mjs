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
const PATH = "/v1/live/sessions";
const OFFER = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n";
const ANSWER = "v=0\r\no=- 9 9 IN IP4 203.0.113.9\r\ns=answer\r\n";

// The body upstream's tools/voice_live.py sends (build_session_config + create_webrtc_session).
function request(overrides = {}) {
  return {
    session: {
      model: "gpt-live-1",
      instructions: "You are Headmaster, a calm voice assistant.",
      audio: { output: { voice: "marin" } },
      delegation: { type: "client" },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    },
    transport: { type: "webrtc", sdp: OFFER },
    ...overrides,
  };
}

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
    return Response.json({ session: { id: "sess_live_1", object: "live.session" }, transport: { type: "webrtc", sdp: ANSWER } });
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
  state.open = async (payload = request(), extra = { byo_provider: "openai" }, owner = OWNER) => {
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

test("a live session is opened with the owner's own key and only the answer comes back", async (t) => {
  const state = await setup(t);
  const res = await state.open();
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.session, { id: "sess_live_1" });
  assert.deepEqual(res.json.transport, { type: "webrtc", sdp: ANSWER });
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].url, "https://api.openai.com/v1/live/sessions");
  assert.equal(state.calls[0].init.headers.authorization, `Bearer ${KEYS[OWNER]}`);
  assert.deepEqual(state.calls[0].body, request());
  noKeyLeak(state, res);
  const created = state.logs.find((l) => l[0].includes("live session created"));
  assert.deepEqual(created[1], { ownerId: OWNER, provider: "openai" });
});

test("live voice needs an own OpenAI key; operator and other providers are refused", async (t) => {
  const state = await setup(t, { rows: [row(OWNER, "xai")] });
  assert.equal((await state.open(request(), {})).json.error.code, "live_requires_own_key");
  assert.equal((await state.open(request(), { byo_provider: "xai" })).json.error.code, "live_provider_unsupported");
  const missing = await state.open();
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "provider_key_missing");
  assert.equal(state.calls.length, 0);
});

test("only a client-delegation WebRTC session can be asked for", async (t) => {
  const state = await setup(t);
  const base = request();
  const bodies = [
    { ...base, owner_id: OTHER },
    { ...base, session: { ...base.session, tools: [{ type: "function", name: "x" }] } },
    { ...base, session: { ...base.session, delegation: { type: "server" } } },
    { ...base, session: { ...base.session, model: "gpt live; drop" } },
    { ...base, session: { ...base.session, audio: { output: { voice: "marin" }, input: {} } } },
    { ...base, transport: { type: "websocket", sdp: OFFER } },
    { ...base, transport: { type: "webrtc", sdp: "x".repeat(70 * 1024) } },
  ];
  for (const payload of bodies) assert.equal((await state.open(payload)).status, 400, JSON.stringify(payload).slice(0, 80));
  assert.equal(state.calls.length, 0);
});

test("vendor refusals are reported without echoing the vendor body", async (t) => {
  const state = await setup(t, { reply: () => new Response(`bad key ${KEYS[OWNER]}`, { status: 401 }) });
  const res = await state.open();
  assert.equal(res.status, 502);
  assert.equal(res.json.error.code, "provider_key_rejected");
  assert.ok(!res.text.includes("bad key"));
  noKeyLeak(state, res);
  const odd = await (await setup(t, { reply: () => Response.json({ session: { id: "s" } }) })).open();
  assert.equal(odd.status, 502);
  assert.equal(odd.json.error.code, "provider_error");
});

test("live sessions use the own-key hourly request budget and release slots", async (t) => {
  const byoQuotaStore = createMemoryByoQuotaStore({ now: () => NOW, maxRequestsPerHour: 1 });
  const state = await setup(t, { byoQuotaStore });
  assert.equal((await state.open()).status, 200);
  assert.equal(byoQuotaStore.inspect(OWNER).active, 0);
  const limited = await state.open();
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.code, "request_budget_exceeded");
  assert.equal(state.calls.length, 1);
});
