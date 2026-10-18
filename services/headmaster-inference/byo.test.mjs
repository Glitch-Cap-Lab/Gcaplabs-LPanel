import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { ASSERTION_AUDIENCE, sha256, signAssertion, verifyAssertion } from "./assertion.mjs";
import { createProviderKeyResolver } from "./byo.mjs";
import { createInferenceService } from "./lib.mjs";
import { createMemoryByoQuotaStore, createMemoryQuotaStore } from "./quota.mjs";
import { encryptProviderKey } from "./provider-key-crypto.mjs";

const ASSERTION_SECRET = "s".repeat(48);
const KEY_SECRET = "k".repeat(48);
const OWNER = "11111111-1111-4111-8111-111111111111";
const NOW = 1_800_000_000_000;
const SUPABASE = "https://headmaster.supabase.example";
const USER_KEY = "sk-user-own-key-SECRET-9876";

function token({ method, path, body = Buffer.alloc(0), extra = {}, owner = OWNER }) {
  const iat = Math.floor(NOW / 1000);
  return signAssertion(
    {
      v: extra.byo_provider === undefined ? 1 : 2,
      aud: ASSERTION_AUDIENCE,
      sub: owner,
      authorization_revision: "3",
      method,
      path,
      body_sha256: sha256(body),
      request_id: randomUUID(),
      nonce: randomBytes(16).toString("base64url"),
      iat,
      exp: iat + 20,
      ...extra,
    },
    ASSERTION_SECRET,
  );
}

function setup(t, { rows, secret = KEY_SECRET, providerResponses } = {}) {
  const ciphertext = encryptProviderKey({
    secret: KEY_SECRET,
    ownerId: OWNER,
    provider: "openai",
    apiKey: USER_KEY,
  });
  const state = {
    ciphertext,
    rows: rows ?? [{ owner_id: OWNER, provider: "openai", ciphertext, revision: 1 }],
    supabaseCalls: 0,
    providerCalls: [],
    clock: NOW,
    logs: [],
    assignmentCalls: 0,
    providerLookups: 0,
  };
  const fetchImpl = async (url, init) => {
    const href = String(url);
    if (href.startsWith(SUPABASE)) {
      state.supabaseCalls += 1;
      state.lastSupabaseUrl = href;
      return new Response(JSON.stringify(state.rows), { status: 200 });
    }
    state.providerCalls.push({ url: href, init });
    const next = providerResponses?.shift();
    if (next) return next;
    if (href.endsWith("/models"))
      return new Response(
        JSON.stringify({
          data: [{ id: "gpt-x" }, { id: "bad id!" }, { id: "gpt-x" }, { id: "o9/mini" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const body = JSON.parse(init.body);
    if (body.stream)
      return new Response(
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    return new Response(
      JSON.stringify({ id: "c1", usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };
  const logger = {
    info: (...a) => state.logs.push(a),
    warn: (...a) => state.logs.push(a),
    error: (...a) => state.logs.push(a),
  };
  const resolveOwnKey = createProviderKeyResolver({
    supabaseUrl: SUPABASE,
    serviceRoleKey: "service-role-key",
    secret,
    fetchImpl,
    now: () => state.clock,
    logger,
  });
  const operatorQuota = createMemoryQuotaStore({ now: () => NOW });
  const byoQuotaStore = createMemoryByoQuotaStore({ now: () => NOW });
  const service = createInferenceService({
    assertionSecret: ASSERTION_SECRET,
    resolveAssignment: async () => {
      state.assignmentCalls += 1;
      throw new Error("must not be read for byo");
    },
    resolveProvider: async () => {
      state.providerLookups += 1;
      throw new Error("must not be read for byo");
    },
    quotaStore: operatorQuota,
    resolveOwnKey,
    byoQuotaStore,
    fetchImpl,
    now: () => NOW,
    logger,
  });
  service.server.listen(0, "127.0.0.1");
  return once(service.server, "listening").then(() => {
    t.after(() => new Promise((resolve) => service.server.close(resolve)));
    const origin = `http://127.0.0.1:${service.server.address().port}`;
    const models = (extra = { byo_provider: "openai" }) =>
      fetch(`${origin}/v1/models`, {
        headers: {
          "x-headmaster-inference-assertion": token({ method: "GET", path: "/v1/models", extra }),
        },
      });
    const chat = (payload, extra = { byo_provider: "openai" }) => {
      const body = Buffer.from(JSON.stringify(payload));
      return fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-headmaster-inference-assertion": token({
            method: "POST",
            path: "/v1/chat/completions",
            body,
            extra,
          }),
        },
      });
    };
    return { state, models, chat, operatorQuota, byoQuotaStore, service };
  });
}

const CHAT = { model: "gpt-anything-v2", messages: [{ role: "user", content: "hello" }] };

test("byo models: lists provider ids with the user's key, OpenAI format, filtered", async (t) => {
  const { state, models } = await setup(t);
  const res = await models();
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(
    json.data.map((m) => m.id),
    ["gpt-x", "o9/mini"],
  );
  assert.equal(json.object, "list");
  assert.equal(state.providerCalls[0].url, "https://api.openai.com/v1/models");
  assert.equal(state.providerCalls[0].init.headers.authorization, `Bearer ${USER_KEY}`);
  assert.equal(state.assignmentCalls + state.providerLookups, 0);
});

test("byo models: capped at 500 ids", async (t) => {
  const many = { data: Array.from({ length: 900 }, (_, i) => ({ id: `m-${i}` })) };
  const { models } = await setup(t, {
    providerResponses: [new Response(JSON.stringify(many), { status: 200 })],
  });
  assert.equal((await (await models()).json()).data.length, 500);
});

test("byo chat: forwards to the fixed endpoint with the user's key; non-catalogue model allowed", async (t) => {
  const { state, chat } = await setup(t);
  const res = await chat(CHAT);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).id, "c1");
  const call = state.providerCalls[0];
  assert.equal(call.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(call.init.headers.authorization, `Bearer ${USER_KEY}`);
  assert.equal(JSON.parse(call.init.body).max_completion_tokens, 1024);
  assert.equal(state.assignmentCalls + state.providerLookups, 0);
});

test("byo anthropic: fixed OpenAI-compatible endpoint, user's key in both auth headers", async (t) => {
  const ciphertext = encryptProviderKey({ secret: KEY_SECRET, ownerId: OWNER, provider: "anthropic", apiKey: USER_KEY });
  const { state, chat, models } = await setup(t, {
    rows: [{ owner_id: OWNER, provider: "anthropic", ciphertext, revision: 1 }],
  });
  assert.equal((await chat(CHAT, { byo_provider: "anthropic" })).status, 200);
  assert.equal((await models({ byo_provider: "anthropic" })).status, 200);
  const [c, m] = state.providerCalls;
  assert.equal(c.url, "https://api.anthropic.com/v1/chat/completions");
  assert.equal(m.url, "https://api.anthropic.com/v1/models");
  for (const call of [c, m]) {
    assert.equal(call.init.headers.authorization, `Bearer ${USER_KEY}`);
    assert.equal(call.init.headers["x-api-key"], USER_KEY);
  }
  assert.ok(!JSON.stringify(state.logs).includes(USER_KEY));
});

test("byo gemini: own-key chat goes to Gemini's OpenAI-compatible endpoint with the user's key", async (t) => {
  const ciphertext = encryptProviderKey({ secret: KEY_SECRET, ownerId: OWNER, provider: "gemini", apiKey: USER_KEY });
  const { state, chat } = await setup(t, {
    rows: [{ owner_id: OWNER, provider: "gemini", ciphertext, revision: 1 }],
  });
  assert.equal((await chat({ ...CHAT, model: "gemini-2.5-flash" }, { byo_provider: "gemini" })).status, 200);
  const [c] = state.providerCalls;
  assert.equal(c.url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  assert.equal(c.init.headers.authorization, `Bearer ${USER_KEY}`);
  assert.equal(JSON.parse(c.init.body).model, "gemini-2.5-flash");
  assert.equal(state.assignmentCalls + state.providerLookups, 0);
  assert.ok(!JSON.stringify(state.logs).includes(USER_KEY));
});

test("byo chat: streams SSE unchanged", async (t) => {
  const { chat } = await setup(t);
  const res = await chat({ ...CHAT, stream: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /"content":"hi"/);
  assert.match(text, /\[DONE\]/);
});

test("byo chat: model id regex, client authority fields, token cap enforced", async (t) => {
  const { chat, state } = await setup(t);
  for (const model of ["bad model", "a".repeat(129), "x;rm", "a b"]) {
    const res = await chat({ ...CHAT, model });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "model_not_allowed");
  }
  assert.equal((await chat({ ...CHAT, provider: "groq" })).status, 400);
  assert.equal((await chat({ ...CHAT, max_tokens: 999_999 })).status, 400);
  assert.equal((await chat({ ...CHAT, model: "openai/gpt-4o:free@x+y" })).status, 200);
  assert.equal(state.providerCalls.length, 1);
});

test("unknown or malformed byo_provider claim is rejected 400 without any lookup", async (t) => {
  const { models, chat, state } = await setup(t);
  for (const claim of ["cohere", "custom", 7, null, "", "__proto__", "constructor"]) {
    // Non-string claims fail assertion verification (401); unknown strings are 400.
    const expected = typeof claim === "string" ? 400 : 401;
    assert.equal((await models({ byo_provider: claim })).status, expected);
    assert.equal((await chat(CHAT, { byo_provider: claim })).status, expected);
  }
  assert.equal(state.supabaseCalls, 0);
  assert.equal(state.providerCalls.length, 0);
});

test("missing or invalid secret: 503 own_key_unavailable, operator path still boots and answers", async (t) => {
  for (const secret of [null, "short"]) {
    const { models, chat, state } = await setup(t, { secret });
    for (const res of [await models(), await chat(CHAT)]) {
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error.code, "own_key_unavailable");
    }
    assert.equal(state.providerCalls.length, 0);
    assert.equal(state.supabaseCalls, 0);
  }
  // No byo dependencies at all: still 503, never an operator fallback.
  const service = createInferenceService({
    assertionSecret: ASSERTION_SECRET,
    resolveAssignment: async () => {
      throw new Error("must not run");
    },
    resolveProvider: async () => {
      throw new Error("must not run");
    },
    quotaStore: createMemoryQuotaStore({ now: () => NOW }),
    now: () => NOW,
  });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  t.after(() => new Promise((resolve) => service.server.close(resolve)));
  const res = await fetch(`http://127.0.0.1:${service.server.address().port}/v1/models`, {
    headers: {
      "x-headmaster-inference-assertion": token({
        method: "GET",
        path: "/v1/models",
        extra: { byo_provider: "openai" },
      }),
    },
  });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "own_key_unavailable");
});

test("missing key row: 404 provider_key_missing, nothing forwarded, nothing cached", async (t) => {
  const { state, models } = await setup(t, { rows: [] });
  for (let i = 0; i < 2; i += 1) {
    const res = await models();
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "provider_key_missing");
  }
  assert.equal(state.supabaseCalls, 2);
  assert.equal(state.providerCalls.length, 0);
});

test("decrypt failure, wrong-owner row, and malformed rows fail closed as 503", async (t) => {
  const bad = [
    [{ owner_id: OWNER, provider: "openai", ciphertext: "v1.AAAA.AAAA.AAAA", revision: 1 }],
    [
      {
        owner_id: "22222222-2222-4222-8222-222222222222",
        provider: "openai",
        ciphertext: "x",
        revision: 1,
      },
    ],
    [{ owner_id: OWNER, provider: "openai", revision: 1 }],
    [{}, {}],
  ];
  for (const rows of bad) {
    const { models, state } = await setup(t, { rows });
    const res = await models();
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, "own_key_unavailable");
    assert.equal(state.providerCalls.length, 0);
  }
});

test("row encrypted for another owner or provider does not decrypt", async (t) => {
  const stolen = encryptProviderKey({
    secret: KEY_SECRET,
    ownerId: "22222222-2222-4222-8222-222222222222",
    provider: "openai",
    apiKey: "sk-other-users-key",
  });
  const { models, state } = await setup(t, {
    rows: [{ owner_id: OWNER, provider: "openai", ciphertext: stolen, revision: 1 }],
  });
  assert.equal((await models()).status, 503);
  assert.equal(state.providerCalls.length, 0);
});

test("provider 401/403 maps to own_key_rejected without relaying the provider body", async (t) => {
  for (const status of [401, 403]) {
    const leak = `Incorrect API key provided: ${USER_KEY}`;
    const { models, chat } = await setup(t, {
      providerResponses: [
        new Response(JSON.stringify({ error: { message: leak } }), { status }),
        new Response(JSON.stringify({ error: { message: leak } }), { status }),
      ],
    });
    for (const res of [await models(), await chat(CHAT)]) {
      const text = await res.text();
      assert.equal(res.status, 400);
      assert.equal(JSON.parse(text).error.code, "own_key_rejected");
      assert.ok(!text.includes(USER_KEY) && !text.includes("Incorrect"));
    }
  }
});

test("other provider errors use the sanitized operator mapping", async (t) => {
  const { chat } = await setup(t, {
    providerResponses: [
      new Response("secret detail", { status: 429, headers: { "retry-after": "7" } }),
    ],
  });
  const res = await chat(CHAT);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "7");
  assert.equal((await res.json()).error.code, "provider_rate_limited");
});

test("byo never touches operator quota counters or the operator provider path", async (t) => {
  const { chat, models, operatorQuota, byoQuotaStore, state } = await setup(t);
  await models();
  await chat(CHAT);
  await (await chat({ ...CHAT, stream: true })).text();
  assert.deepEqual(operatorQuota.inspect(OWNER), {
    active: 0,
    reserved: 0,
    used: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });
  assert.equal(byoQuotaStore.inspect(OWNER).used, 0);
  assert.equal(state.assignmentCalls + state.providerLookups, 0);
});

test("byo has its own request-rate and concurrency limits", async (t) => {
  const { chat, service, byoQuotaStore, operatorQuota } = await setup(t);
  // Exhaust the byo hourly cap directly on the byo store.
  for (let i = 0; i < 600; i += 1) {
    await byoQuotaStore.acquire({ ownerId: OWNER, requestId: `r${i}`, reserveOutputTokens: 0 });
    await byoQuotaStore.finish({ ownerId: OWNER, requestId: `r${i}` });
  }
  const res = await chat(CHAT);
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.code, "request_budget_exceeded");
  // Operator budget for the same owner is untouched.
  assert.equal(
    (await operatorQuota.acquire({ ownerId: OWNER, requestId: "op", reserveOutputTokens: 10 }))
      .allowed,
    true,
  );
  assert.ok(service);
});

test("byo concurrency cap releases slots after each request", async (t) => {
  const { chat, byoQuotaStore } = await setup(t);
  for (let i = 0; i < 5; i += 1) assert.equal((await chat(CHAT)).status, 200);
  assert.equal(byoQuotaStore.inspect(OWNER).active, 0);
});

test("logs never contain the key, the ciphertext, or request bodies", async (t) => {
  const { chat, models, state } = await setup(t, {
    providerResponses: [new Response("x", { status: 401 }), new Response("x", { status: 500 })],
  });
  await models();
  await chat({ ...CHAT, messages: [{ role: "user", content: "PRIVATE-PROMPT-TEXT" }] });
  await chat(CHAT);
  await setup(t, {
    rows: [{ owner_id: OWNER, provider: "openai", ciphertext: "v1.bad.bad.bad", revision: 1 }],
  }).then(async (other) => {
    await other.models();
    state.logs.push(...other.state.logs);
  });
  const dump = JSON.stringify(state.logs);
  assert.ok(state.logs.length > 0);
  assert.ok(!dump.includes(USER_KEY));
  assert.ok(!dump.includes(state.ciphertext));
  assert.ok(!dump.includes("PRIVATE-PROMPT-TEXT"));
  assert.ok(!dump.includes("service-role-key"));
});

test("key cache: hits within 30 s, expires after, a deleted row stops working", async (t) => {
  const { models, state } = await setup(t);
  assert.equal((await models()).status, 200);
  assert.equal((await models()).status, 200);
  assert.equal(state.supabaseCalls, 1);
  state.clock += 29_000;
  assert.equal((await models()).status, 200);
  assert.equal(state.supabaseCalls, 1);
  state.rows = [];
  state.clock += 2_000;
  const res = await models();
  assert.equal(res.status, 404);
  assert.equal(state.supabaseCalls, 2);
  assert.equal(state.providerCalls.length, 3);
});

test("lookup failures are not cached", async (t) => {
  const { models, state } = await setup(t);
  const good = state.rows;
  state.rows = { not: "an array" };
  assert.equal((await models()).status, 503);
  state.rows = good;
  assert.equal((await models()).status, 200);
});

test("resolver reads only the single (owner, provider) row with the service credential", async (t) => {
  const { models, state } = await setup(t);
  await models();
  assert.match(
    state.lastSupabaseUrl,
    /headmaster_user_provider_keys\?owner_id=eq\.[0-9a-f-]+&provider=eq\.openai&limit=2/,
  );
});

test("operator requests (no byo claim) still use assignments and never the byo path", async (t) => {
  let assignments = 0;
  const service = createInferenceService({
    assertionSecret: ASSERTION_SECRET,
    resolveAssignment: async () => {
      assignments += 1;
      return { noraUserId: OWNER, providerId: OWNER, provider: "openai" };
    },
    resolveProvider: async () => ({
      id: OWNER,
      provider: "openai",
      apiKey: "operator-key",
      models: ["gpt-5.5"],
    }),
    quotaStore: createMemoryQuotaStore({ now: () => NOW }),
    resolveOwnKey: async () => {
      throw new Error("byo resolver must not run");
    },
    byoQuotaStore: createMemoryByoQuotaStore({ now: () => NOW }),
    now: () => NOW,
  });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  t.after(() => new Promise((resolve) => service.server.close(resolve)));
  const res = await fetch(`http://127.0.0.1:${service.server.address().port}/v1/models`, {
    headers: { "x-headmaster-inference-assertion": token({ method: "GET", path: "/v1/models" }) },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(
    (await res.json()).data.map((m) => m.id),
    ["gpt-5.5"],
  );
  assert.equal(assignments, 1);
});

test("assertion versions: v2 needs byo_provider, v1 must not carry it", () => {
  const base = { aud: ASSERTION_AUDIENCE, sub: OWNER, authorization_revision: "3", method: "GET", path: "/v1/models", body_sha256: sha256(Buffer.alloc(0)), request_id: randomUUID(), nonce: randomBytes(16).toString("base64url"), iat: Math.floor(NOW / 1000), exp: Math.floor(NOW / 1000) + 20 };
  const check = (claims) => verifyAssertion(signAssertion(claims, ASSERTION_SECRET), { secret: ASSERTION_SECRET, method: "GET", path: "/v1/models", body: Buffer.alloc(0), now: () => NOW });
  assert.ok(check({ ...base, v: 1 }));
  assert.ok(check({ ...base, v: 2, byo_provider: "openai" }));
  assert.equal(check({ ...base, v: 1, byo_provider: "openai" }), null);
  assert.equal(check({ ...base, v: 2 }), null);
});

test("requests for a missing or unreadable key never spend the byo request budget", async (t) => {
  const missing = await setup(t, { rows: [] });
  for (let i = 0; i < 610; i += 1) {
    const res = await missing.chat(CHAT);
    assert.equal(res.status, 404, `request ${i}`);
    await res.text();
  }
  assert.equal(missing.byoQuotaStore.inspect(OWNER).active, 0);
  // The key is then stored: the account is not rate limited by the earlier 404s
  // (the hourly cap is 600, so this would be a 429 if they had counted).
  missing.state.rows = [
    { owner_id: OWNER, provider: "openai", ciphertext: missing.state.ciphertext, revision: 1 },
  ];
  missing.state.clock += 60_000;
  const after = await missing.chat(CHAT);
  assert.equal(after.status, 200);
  await after.text();

  const unreadable = await setup(t, {
    rows: [{ owner_id: OWNER, provider: "openai", ciphertext: "v1.AAAA.AAAA.AAAA", revision: 1 }],
  });
  for (let i = 0; i < 610; i += 1) {
    const res = await unreadable.chat(CHAT);
    assert.equal(res.status, 503);
    await res.text();
  }
  unreadable.state.rows = [
    { owner_id: OWNER, provider: "openai", ciphertext: unreadable.state.ciphertext, revision: 2 },
  ];
  unreadable.state.clock += 60_000;
  assert.equal((await unreadable.chat(CHAT)).status, 200);
});
