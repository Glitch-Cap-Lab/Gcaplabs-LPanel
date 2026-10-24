import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import {
  ASSERTION_AUDIENCE,
  createReplayCache,
  createRedisReplayStore,
  sha256,
  signAssertion,
  verifyAssertion,
} from "./assertion.mjs";
import { createInferenceService } from "./lib.mjs";
import { createMemoryQuotaStore, createRedisQuotaStore } from "./quota.mjs";
import {
  HEADMASTER_TIER_MODELS,
  openRouterModelId,
  tierAssignments,
  tierModelsFromEnv,
  priceTableFromEnv,
  costMicroUsd,
  resolveTierModel,
  DEFAULT_TIER_MODELS,
  parseAccountProviderMap,
  providerCompletionUrl,
} from "./policy.mjs";

const SECRET = "s".repeat(48);
const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const NORA_USER_A = "33333333-3333-4333-8333-333333333333";
const PROVIDER_A = "44444444-4444-4444-8444-444444444444";
const NOW = 1_800_000_000_000;

function makeToken({ method, path, body = Buffer.alloc(0), owner = OWNER_A, revision = "7" }) {
  const iat = Math.floor(NOW / 1000);
  return signAssertion(
    {
      v: 1,
      aud: ASSERTION_AUDIENCE,
      sub: owner,
      authorization_revision: revision,
      method,
      path,
      body_sha256: sha256(body),
      request_id: randomUUID(),
      nonce: randomBytes(16).toString("base64url"),
      iat,
      exp: iat + 20,
    },
    SECRET,
  );
}

function policyMap(owner = OWNER_A, provider = "openai", providerId = PROVIDER_A) {
  return new Map([[owner, { noraUserId: NORA_USER_A, providerId, provider, models: ["gpt-5.5"] }]]);
}

function provider() {
  return {
    id: PROVIDER_A,
    provider: "openai",
    apiKey: "provider-key-never-return-this",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-5.5", "gpt-5.5-pro"],
  };
}

// Every model the fixtures route to has a (tiny) known price: the relay fails
// closed on a model with no price.
const TEST_PRICES = Object.freeze({
  ...priceTableFromEnv({}),
  "gpt-5.5": { prompt: 0.001, completion: 0.001 },
  "gpt-5.5-pro": { prompt: 0.001, completion: 0.001 },
});

async function startService(t, overrides = {}) {
  const quota = overrides.quotaStore || createMemoryQuotaStore({ now: () => NOW });
  const service = createInferenceService({
    assertionSecret: SECRET,
    accountProviderMap: policyMap(),
    resolveProvider: async () => provider(),
    quotaStore: quota,
    now: () => NOW,
    logger: { info() {}, warn() {}, error() {} },
    priceTable: TEST_PRICES,
    ...overrides,
  });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  const origin = `http://127.0.0.1:${service.server.address().port}`;
  t.after(() => new Promise((resolve) => service.server.close(resolve)));
  return { ...service, origin, quota };
}

async function getModels(origin, token) {
  return fetch(`${origin}/v1/models`, { headers: { "x-headmaster-inference-assertion": token } });
}

async function postCompletion(origin, body, token, signal) {
  return fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-headmaster-inference-assertion": token },
    body,
    signal,
  });
}

// Real Redis coverage: skipped unless REDIS_URL points at a running server.
async function openRedisQuota(t, options = {}) {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  const { default: Redis } = await import("ioredis");
  const redis = new Redis(url, { maxRetriesPerRequest: 1 });
  t.after(() => redis.quit());
  const prefix = "headmaster-inference-test";
  const ownerId = randomUUID();
  return {
    redis,
    ownerId,
    key: (suffix) => `${prefix}:${ownerId}:${suffix}`,
    quota: createRedisQuotaStore(redis, { prefix, ...options }),
  };
}

test("assertions bind audience, owner, revision, method, exact path, body and short expiry", () => {
  const payload = Buffer.from('{"model":"gpt-5.5"}');
  const token = makeToken({ method: "POST", path: "/v1/chat/completions", body: payload });
  const claims = verifyAssertion(token, {
    secret: SECRET,
    method: "POST",
    path: "/v1/chat/completions",
    body: payload,
    now: () => NOW,
  });
  assert.equal(claims.sub, OWNER_A);
  assert.equal(claims.authorization_revision, "7");
  assert.equal(
    verifyAssertion(token, {
      secret: SECRET,
      method: "GET",
      path: "/v1/chat/completions",
      body: payload,
      now: () => NOW,
    }),
    null,
  );
  assert.equal(
    verifyAssertion(token, {
      secret: SECRET,
      method: "POST",
      path: "/v1/chat/completions",
      body: Buffer.from("{}"),
      now: () => NOW,
    }),
    null,
  );
  assert.equal(
    verifyAssertion(token, {
      secret: "x".repeat(48),
      method: "POST",
      path: "/v1/chat/completions",
      body: payload,
      now: () => NOW,
    }),
    null,
  );
  assert.equal(
    verifyAssertion(token, {
      secret: SECRET,
      method: "POST",
      path: "/v1/chat/completions",
      body: payload,
      now: () => NOW + 21_000,
    }),
    null,
  );

  const replay = createReplayCache({ now: () => NOW });
  assert.equal(replay.claim(claims.nonce, claims.exp), true);
  assert.equal(replay.claim(claims.nonce, claims.exp), false);
});

test("trusted account map validates identities and narrows model access", () => {
  const map = parseAccountProviderMap(
    JSON.stringify({
      [OWNER_A]: {
        noraUserId: NORA_USER_A,
        providerId: PROVIDER_A,
        provider: "openai",
        models: ["gpt-5.5"],
      },
    }),
  );
  assert.deepEqual(map.get(OWNER_A), {
    noraUserId: NORA_USER_A,
    providerId: PROVIDER_A,
    provider: "openai",
    models: ["gpt-5.5"],
  });
  assert.throws(() =>
    parseAccountProviderMap(
      JSON.stringify({
        [OWNER_A]: {
          noraUserId: NORA_USER_A,
          providerId: PROVIDER_A,
          provider: "openai",
          models: ["claude-sonnet-4-5"],
        },
      }),
    ),
  );
  assert.throws(() =>
    parseAccountProviderMap(
      JSON.stringify({
        [OWNER_A]: {
          noraUserId: NORA_USER_A,
          providerId: PROVIDER_A,
          provider: "openai",
          extra: "client-controlled",
        },
      }),
    ),
  );
  const ownerWithLetters = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert.throws(() =>
    parseAccountProviderMap(
      JSON.stringify({
        [ownerWithLetters]: { noraUserId: NORA_USER_A, providerId: PROVIDER_A, provider: "openai" },
        [ownerWithLetters.toUpperCase()]: {
          noraUserId: NORA_USER_A,
          providerId: PROVIDER_A,
          provider: "openai",
        },
      }),
    ),
  );
  assert.throws(() =>
    parseAccountProviderMap(
      JSON.stringify({
        [OWNER_A]: { noraUserId: NORA_USER_A, providerId: "not-a-uuid", provider: "openai" },
      }),
    ),
  );
  assert.throws(() =>
    providerCompletionUrl({ provider: "openai", baseUrl: "http://127.0.0.1:8080/v1" }),
  );
  assert.throws(() =>
    providerCompletionUrl({ provider: "openai", baseUrl: "https://api.openai.com:8443/v1" }),
  );
  assert.throws(() =>
    providerCompletionUrl({ provider: "openai", baseUrl: "https://evil.example/v1" }),
  );
});

test("models are owner-scoped and chat streams tool-call frames and usage unchanged", async (t) => {
  const upstreamCalls = [];
  const encoder = new TextEncoder();
  const upstreamFrames = [
    'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{}"}}]},"finish_reason":null}]}\n\n',
    'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":13,"completion_tokens":2,"total_tokens":15}}\n\n',
    "data: [DONE]\n\n",
  ];
  const fetchImpl = async (url, options) => {
    upstreamCalls.push({ url: String(url), options, parsed: JSON.parse(options.body) });
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const frame of upstreamFrames) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  const f = await startService(t, { fetchImpl });

  const modelsToken = makeToken({ method: "GET", path: "/v1/models" });
  const modelsResponse = await getModels(f.origin, modelsToken);
  assert.equal(modelsResponse.status, 200);
  const models = await modelsResponse.json();
  assert.deepEqual(
    models.data.map((row) => row.id),
    ["gpt-5.5"],
  );
  assert.equal(JSON.stringify(models).includes(PROVIDER_A), false);
  assert.equal(JSON.stringify(models).includes("provider-key-never-return-this"), false);

  const request = {
    model: "gpt-5.5",
    stream: true,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "inspect this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
        ],
      },
    ],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
    reasoning_effort: "medium",
    stream_options: { include_usage: true },
  };
  const body = Buffer.from(JSON.stringify(request));
  const token = makeToken({ method: "POST", path: "/v1/chat/completions", body });
  const response = await postCompletion(f.origin, body, token);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const raw = await response.text();
  assert.equal(raw, upstreamFrames.join(""));
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].url, "https://api.openai.com/v1/chat/completions");
  assert.equal(
    upstreamCalls[0].options.headers.authorization,
    "Bearer provider-key-never-return-this",
  );
  assert.deepEqual(upstreamCalls[0].parsed.messages, request.messages);
  assert.deepEqual(upstreamCalls[0].parsed.tools, request.tools);
  assert.equal(upstreamCalls[0].parsed.reasoning_effort, "medium");
  assert.deepEqual(upstreamCalls[0].parsed.stream_options, { include_usage: true });
  assert.equal(upstreamCalls[0].parsed.max_completion_tokens, 1024);
  assert.equal(f.quota.inspect(OWNER_A).used, 2);
  assert.equal(f.quota.inspect(OWNER_A).usage.promptTokens, 13);
});

test("assertion replay, request-selected provider and unlisted models fail closed", async (t) => {
  const fetchCalls = [];
  const f = await startService(t, {
    fetchImpl: async () => {
      fetchCalls.push(1);
      return new Response("{}");
    },
  });
  const token = makeToken({ method: "GET", path: "/v1/models" });
  assert.equal((await getModels(f.origin, token)).status, 200);
  const replay = await getModels(f.origin, token);
  assert.equal(replay.status, 401);
  assert.equal((await replay.json()).error.code, "assertion_replayed");

  const bodyWithProvider = Buffer.from(
    JSON.stringify({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "x" }],
      provider_id: PROVIDER_A,
    }),
  );
  const providerToken = makeToken({
    method: "POST",
    path: "/v1/chat/completions",
    body: bodyWithProvider,
  });
  const providerResponse = await postCompletion(f.origin, bodyWithProvider, providerToken);
  assert.equal(providerResponse.status, 400);
  assert.equal((await providerResponse.json()).error.code, "client_authority_field_forbidden");

  const unsupported = Buffer.from(
    JSON.stringify({ model: "not-allowlisted", messages: [{ role: "user", content: "x" }] }),
  );
  const unsupportedToken = makeToken({
    method: "POST",
    path: "/v1/chat/completions",
    body: unsupported,
  });
  const unsupportedResponse = await postCompletion(f.origin, unsupported, unsupportedToken);
  assert.equal(unsupportedResponse.status, 400);
  assert.equal((await unsupportedResponse.json()).error.code, "model_not_allowed");
  assert.deepEqual(fetchCalls, []);
});

test("a Headmaster tier id resolves to the account's assigned model before the provider call", async (t) => {
  const upstreamCalls = [];
  const f = await startService(t, {
    fetchImpl: async (url, options) => {
      upstreamCalls.push({ url: String(url), parsed: JSON.parse(options.body) });
      return new Response(
        JSON.stringify({
          id: "c1",
          model: "gpt-5.5",
          choices: [{ message: { role: "assistant", content: "hi" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  for (const tier of ["headmaster-lite", "headmaster-pro"]) {
    const body = Buffer.from(
      JSON.stringify({ model: tier, messages: [{ role: "user", content: "x" }] }),
    );
    const token = makeToken({ method: "POST", path: "/v1/chat/completions", body });
    const response = await postCompletion(f.origin, body, token);
    assert.equal(response.status, 200, tier);
  }
  assert.deepEqual(
    upstreamCalls.map((call) => call.parsed.model),
    ["gpt-5.5", "gpt-5.5"],
  );
  assert.deepEqual(HEADMASTER_TIER_MODELS, ["headmaster-lite", "headmaster-pro"]);
});

test("the model list reports which backing model each tier resolves to, in OpenRouter form", async (t) => {
  const f = await startService(t, {});
  const response = await getModels(f.origin, makeToken({ method: "GET", path: "/v1/models" }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body.headmaster_tiers), HEADMASTER_TIER_MODELS);
  for (const tier of HEADMASTER_TIER_MODELS) {
    assert.deepEqual(body.headmaster_tiers[tier], { model: "gpt-5.5", openrouter_id: "openai/gpt-5.5" });
  }
});

test("tier assignments map providers to OpenRouter ids only when certain, and report nothing without a model", () => {
  assert.equal(openRouterModelId("openai", "gpt-5.5"), "openai/gpt-5.5");
  assert.equal(openRouterModelId("xai", "grok-4"), "x-ai/grok-4");
  assert.equal(openRouterModelId("openrouter", "deepseek/deepseek-v4.1-flash"), "deepseek/deepseek-v4.1-flash");
  assert.equal(openRouterModelId("groq", "llama-3.3-70b-versatile"), null);
  assert.equal(openRouterModelId("openai", ""), null);
  assert.deepEqual(tierAssignments("openai", [])["headmaster-pro"], { model: null, openrouter_id: null });
});

test("a tier id never widens the model allowlist", async (t) => {
  const fetchCalls = [];
  const f = await startService(t, {
    // No model is enabled for this account, so a tier has nothing to resolve to.
    accountProviderMap: new Map([
      [OWNER_A, { noraUserId: NORA_USER_A, providerId: PROVIDER_A, provider: "openai", models: [] }],
    ]),
    fetchImpl: async () => {
      fetchCalls.push(1);
      return new Response("{}");
    },
  });
  const body = Buffer.from(
    JSON.stringify({ model: "headmaster-pro", messages: [{ role: "user", content: "x" }] }),
  );
  const token = makeToken({ method: "POST", path: "/v1/chat/completions", body });
  const response = await postCompletion(f.origin, body, token);
  assert.notEqual(response.status, 200);
  assert.deepEqual(fetchCalls, []);
});

test("replay-store outage fails closed as a temporary service error", async (t) => {
  const fetchCalls = [];
  const f = await startService(t, {
    replayStore: {
      claim: async () => {
        throw Object.assign(new Error("redis offline"), { code: "ECONNREFUSED" });
      },
    },
    fetchImpl: async () => {
      fetchCalls.push(1);
      return new Response("{}");
    },
  });
  const response = await getModels(f.origin, makeToken({ method: "GET", path: "/v1/models" }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "replay_store_unavailable");
  assert.equal(f.server.requestTimeout, 120_000);
  assert.deepEqual(fetchCalls, []);
});

test("provider rate limits expose a safe retry-after without leaking the provider body", async (t) => {
  const f = await startService(t, {
    fetchImpl: async () =>
      new Response("private upstream diagnostic", {
        status: 429,
        headers: { "retry-after": "9", "content-type": "text/plain" },
      }),
  });
  const body = Buffer.from(
    JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "wait" }] }),
  );
  const token = makeToken({ method: "POST", path: "/v1/chat/completions", body });
  const response = await postCompletion(f.origin, body, token);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "9");
  const result = await response.text();
  assert.equal(result.includes("private upstream diagnostic"), false);
  assert.equal(JSON.parse(result).error.code, "provider_rate_limited");
});

test("quota exhaustion maps to the exact Appendix B codes the desktop client expects", async (t) => {
  // The desktop's `trialLimitCodeFrom` (electron/headmaster-service-proxy.ts)
  // only recognizes a 429 with error.code 'request_budget_exceeded' or
  // 'completion_budget_exceeded'. This pins quota.mjs's internal reasons
  // ('request_budget' / 'token_budget') to those exact HTTP-level names so a
  // future rename of either side is caught here instead of live.
  const requestBudgetQuota = createMemoryQuotaStore({
    maxRequestsPerHour: 0,
    maxCompletionTokensPerDay: 1_000,
    now: () => NOW,
  });
  const requestBudgetService = await startService(t, { quotaStore: requestBudgetQuota });
  const body = Buffer.from(
    JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }),
  );
  const requestBudgetResponse = await postCompletion(
    requestBudgetService.origin,
    body,
    makeToken({ method: "POST", path: "/v1/chat/completions", body }),
  );
  assert.equal(requestBudgetResponse.status, 429);
  assert.equal((await requestBudgetResponse.json()).error.code, "request_budget_exceeded");

  const tokenBudgetQuota = createMemoryQuotaStore({
    maxRequestsPerHour: 1_000,
    maxCompletionTokensPerDay: 0,
    now: () => NOW,
  });
  const tokenBudgetService = await startService(t, { quotaStore: tokenBudgetQuota });
  const tokenBudgetResponse = await postCompletion(
    tokenBudgetService.origin,
    body,
    makeToken({ method: "POST", path: "/v1/chat/completions", body }),
  );
  assert.equal(tokenBudgetResponse.status, 429);
  assert.equal((await tokenBudgetResponse.json()).error.code, "completion_budget_exceeded");
});

test("Redis replay store atomically consumes a nonce once across relay instances", async () => {
  const seen = new Set();
  const calls = [];
  const redis = {
    async set(...args) {
      calls.push(args);
      if (seen.has(args[0])) return null;
      seen.add(args[0]);
      return "OK";
    },
  };
  const replay = createRedisReplayStore(redis, { now: () => NOW });
  const nonce = randomBytes(18).toString("base64url");
  const exp = Math.floor(NOW / 1000) + 20;
  assert.equal(await replay.claim(nonce, exp), true);
  assert.equal(await replay.claim(nonce, exp), false);
  assert.deepEqual(calls[0], [`headmaster-inference:replay:${nonce}`, "1", "EX", 20, "NX"]);
});

test("quota reservations isolate accounts and enforce concurrency and daily output budget", async () => {
  const quota = createMemoryQuotaStore({
    maxConcurrentPerAccount: 1,
    maxRequestsPerHour: 10,
    maxCompletionTokensPerDay: 10,
    now: () => NOW,
  });
  assert.deepEqual(
    await quota.acquire({ ownerId: OWNER_A, requestId: "a1", reserveOutputTokens: 8 }),
    { allowed: true, reason: "ok", day: Math.floor(NOW / 86_400_000) },
  );
  assert.deepEqual(
    await quota.acquire({ ownerId: OWNER_A, requestId: "a2", reserveOutputTokens: 1 }),
    { allowed: false, reason: "concurrency" },
  );
  assert.deepEqual(
    await quota.acquire({ ownerId: OWNER_B, requestId: "b1", reserveOutputTokens: 8 }),
    { allowed: true, reason: "ok", day: Math.floor(NOW / 86_400_000) },
  );
  await quota.finish({
    ownerId: OWNER_A,
    requestId: "a1",
    promptTokens: 4,
    completionTokens: 6,
    totalTokens: 10,
  });
  assert.deepEqual(
    await quota.acquire({ ownerId: OWNER_A, requestId: "a3", reserveOutputTokens: 5 }),
    { allowed: false, reason: "token_budget" },
  );
  assert.equal(quota.inspect(OWNER_A).active, 0);
  assert.equal(quota.inspect(OWNER_A).used, 6);
});

test("client abort cancels provider fetch and releases the account reservation", async (t) => {
  let upstreamSignal;
  let resolveCancelled;
  const cancelled = new Promise((resolve) => {
    resolveCancelled = resolve;
  });
  let startedResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  const f = await startService(t, {
    fetchImpl: (_url, options) =>
      new Promise((resolve, reject) => {
        upstreamSignal = options.signal;
        startedResolve();
        options.signal.addEventListener(
          "abort",
          () => {
            resolveCancelled();
            reject(options.signal.reason);
          },
          { once: true },
        );
      }),
  });
  const body = Buffer.from(
    JSON.stringify({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "wait" }],
      max_completion_tokens: 4,
    }),
  );
  const token = makeToken({ method: "POST", path: "/v1/chat/completions", body });
  const abort = new AbortController();
  const request = postCompletion(f.origin, body, token, abort.signal).catch(() => null);
  await started;
  abort.abort();
  await request;
  await Promise.race([
    cancelled,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("upstream cancellation timed out")), 1000),
    ),
  ]);
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(f.quota.inspect(OWNER_A).active, 0);
});

test("duplicate settlement applies usage once and cannot double-spend the daily budget", async () => {
  const day = Math.floor(NOW / 86_400_000);
  const quota = createMemoryQuotaStore({ maxCompletionTokensPerDay: 100, now: () => NOW });
  const settle = {
    ownerId: OWNER_A,
    requestId: "settle-1",
    quotaDay: day,
    promptTokens: 4,
    completionTokens: 6,
    totalTokens: 10,
  };
  assert.deepEqual(
    await quota.acquire({ ownerId: OWNER_A, requestId: "settle-1", reserveOutputTokens: 6 }),
    { allowed: true, reason: "ok", day },
  );
  assert.deepEqual(await quota.finish(settle), [6, 6]);
  assert.deepEqual(await quota.finish(settle), [0, 0]);
  assert.deepEqual(await quota.finish(settle), [0, 0]);
  assert.deepEqual(quota.inspect(OWNER_A), {
    active: 0,
    reserved: 0,
    used: 6,
    usage: { promptTokens: 4, completionTokens: 6, totalTokens: 10 },
  });
  assert.deepEqual(
    await quota.acquire({ ownerId: OWNER_A, requestId: "settle-2", reserveOutputTokens: 94 }),
    { allowed: true, reason: "ok", day },
  );
  assert.deepEqual(
    await quota.acquire({ ownerId: OWNER_A, requestId: "settle-3", reserveOutputTokens: 1 }),
    { allowed: false, reason: "token_budget" },
  );
});

test("a settlement without provider usage charges exactly the conservative reservation", async () => {
  const day = Math.floor(NOW / 86_400_000);
  const quota = createMemoryQuotaStore({ maxCompletionTokensPerDay: 100, now: () => NOW });
  const settle = {
    ownerId: OWNER_A,
    requestId: "stream-1",
    quotaDay: day,
    promptTokens: 0,
    completionTokens: 40,
    totalTokens: 40,
  };
  await quota.acquire({ ownerId: OWNER_A, requestId: "stream-1", reserveOutputTokens: 40 });
  assert.deepEqual(await quota.finish(settle), [40, 40]);
  assert.deepEqual(await quota.finish(settle), [0, 0]);
  assert.deepEqual(quota.inspect(OWNER_A), {
    active: 0,
    reserved: 0,
    used: 40,
    usage: { promptTokens: 0, completionTokens: 40, totalTokens: 40 },
  });
});

test("concurrency survives a midnight boundary and a cross-midnight settlement releases the acquire-day reservation", async () => {
  const boundary = 20_000 * 86_400_000;
  let clock = boundary - 60_000;
  const quota = createMemoryQuotaStore({
    maxConcurrentPerAccount: 1,
    maxCompletionTokensPerDay: 100,
    now: () => clock,
  });
  assert.deepEqual(
    await quota.acquire({ ownerId: OWNER_A, requestId: "pre-midnight", reserveOutputTokens: 80 }),
    { allowed: true, reason: "ok", day: 19_999 },
  );
  clock = boundary + 60_000;
  assert.deepEqual(
    await quota.acquire({ ownerId: OWNER_A, requestId: "post-midnight", reserveOutputTokens: 5 }),
    { allowed: false, reason: "concurrency" },
  );
  assert.deepEqual(
    await quota.finish({
      ownerId: OWNER_A,
      requestId: "pre-midnight",
      quotaDay: 19_999,
      promptTokens: 1,
      completionTokens: 4,
      totalTokens: 5,
    }),
    [80, 4],
  );
  assert.deepEqual(quota.inspect(OWNER_A), {
    active: 0,
    reserved: 0,
    used: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });
  assert.deepEqual(
    await quota.acquire({ ownerId: OWNER_A, requestId: "post-midnight", reserveOutputTokens: 5 }),
    { allowed: true, reason: "ok", day: 20_000 },
  );
  assert.deepEqual(quota.inspect(OWNER_A), {
    active: 1,
    reserved: 5,
    used: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });
});

test("a crashed request is reclaimed after the active timeout without exhausting the budget", async () => {
  const day = Math.floor(NOW / 86_400_000);
  let clock = NOW;
  const quota = createMemoryQuotaStore({
    maxConcurrentPerAccount: 2,
    maxCompletionTokensPerDay: 100,
    now: () => clock,
  });
  assert.deepEqual(
    await quota.acquire({ ownerId: OWNER_A, requestId: "crashed", reserveOutputTokens: 80 }),
    { allowed: true, reason: "ok", day },
  );
  clock = NOW + 16 * 60_000;
  assert.deepEqual(
    await quota.acquire({ ownerId: OWNER_A, requestId: "after-crash", reserveOutputTokens: 80 }),
    { allowed: true, reason: "ok", day },
  );
  assert.deepEqual(quota.inspect(OWNER_A), {
    active: 1,
    reserved: 80,
    used: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });
  assert.deepEqual(
    await quota.acquire({ ownerId: OWNER_A, requestId: "over-budget", reserveOutputTokens: 21 }),
    { allowed: false, reason: "token_budget" },
  );
});

test("a crashed request cannot let a new day exceed the daily token budget", async () => {
  const boundary = 21_000 * 86_400_000;
  let clock = boundary - 30_000;
  const quota = createMemoryQuotaStore({ maxCompletionTokensPerDay: 100, now: () => clock });
  assert.deepEqual(
    await quota.acquire({ ownerId: OWNER_A, requestId: "crashed", reserveOutputTokens: 100 }),
    { allowed: true, reason: "ok", day: 20_999 },
  );
  assert.deepEqual(
    await quota.acquire({ ownerId: OWNER_A, requestId: "same-day-over", reserveOutputTokens: 1 }),
    { allowed: false, reason: "token_budget" },
  );
  clock = boundary + 30_000;
  assert.deepEqual(
    await quota.acquire({ ownerId: OWNER_A, requestId: "new-day", reserveOutputTokens: 100 }),
    { allowed: true, reason: "ok", day: 21_000 },
  );
  assert.deepEqual(
    await quota.acquire({ ownerId: OWNER_A, requestId: "new-day-over", reserveOutputTokens: 1 }),
    { allowed: false, reason: "token_budget" },
  );
  assert.deepEqual(quota.inspect(OWNER_A), {
    active: 2,
    reserved: 100,
    used: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });
  clock = boundary + 900_000;
  assert.deepEqual(
    await quota.acquire({ ownerId: OWNER_A, requestId: "reclaim", reserveOutputTokens: 1 }),
    { allowed: false, reason: "token_budget" },
  );
  assert.deepEqual(quota.inspect(OWNER_A), {
    active: 1,
    reserved: 100,
    used: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });
});

test("Redis quota store settles distinct prompt/completion/total values exactly once", async (t) => {
  const f = await openRedisQuota(t, { maxCompletionTokensPerDay: 100, now: () => NOW });
  if (!f) return t.skip("REDIS_URL is not set");
  const { redis, ownerId, key, quota } = f;
  const day = Math.floor(NOW / 86_400_000);
  const settle = {
    ownerId,
    requestId: "redis-1",
    quotaDay: day,
    promptTokens: 11,
    completionTokens: 22,
    totalTokens: 33,
  };
  assert.deepEqual(
    await quota.acquire({ ownerId, requestId: "redis-1", reserveOutputTokens: 33 }),
    { allowed: true, reason: "ok", day },
  );
  assert.deepEqual(await quota.finish(settle), [33, 22]);
  assert.deepEqual(await redis.hgetall(key(`usage:${day}`)), {
    prompt_tokens: "11",
    completion_tokens: "22",
    total_tokens: "33",
  });
  assert.equal(await redis.get(key(`output:${day}`)), "22");
  assert.equal(await redis.get(key(`reserved:${day}`)), "0");
  assert.equal(await redis.zcard(key("active")), 0);
  assert.deepEqual(await quota.finish(settle), [0, 0]);
  assert.deepEqual(await redis.hgetall(key(`usage:${day}`)), {
    prompt_tokens: "11",
    completion_tokens: "22",
    total_tokens: "33",
  });
  assert.equal(await redis.get(key(`output:${day}`)), "22");
  const remaining = await quota.acquire({ ownerId, requestId: "redis-2", reserveOutputTokens: 78 });
  assert.equal(remaining.allowed, true);
  assert.equal(remaining.reason, "ok");
  const over = await quota.acquire({ ownerId, requestId: "redis-3", reserveOutputTokens: 1 });
  assert.equal(over.allowed, false);
  assert.equal(over.reason, "token_budget");
});

test("Redis quota store keeps concurrency across midnight, releases cross-midnight and reclaims crashed reservations", async (t) => {
  const boundary = 22_000 * 86_400_000;
  let clock = boundary - 60_000;
  const f = await openRedisQuota(t, {
    maxConcurrentPerAccount: 1,
    maxCompletionTokensPerDay: 100,
    activeTimeoutMs: 5 * 60_000,
    now: () => clock,
  });
  if (!f) return t.skip("REDIS_URL is not set");
  const { redis, ownerId, key, quota } = f;

  const pre = await quota.acquire({ ownerId, requestId: "pre-midnight", reserveOutputTokens: 80 });
  assert.equal(pre.allowed, true);
  assert.equal(pre.day, 21_999);
  assert.equal(await redis.zcard(key("active")), 1);

  clock = boundary + 60_000;
  const blocked = await quota.acquire({
    ownerId,
    requestId: "post-midnight",
    reserveOutputTokens: 5,
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "concurrency");

  assert.deepEqual(
    await quota.finish({
      ownerId,
      requestId: "pre-midnight",
      quotaDay: 21_999,
      promptTokens: 1,
      completionTokens: 4,
      totalTokens: 5,
    }),
    [80, 4],
  );
  assert.equal(await redis.zcard(key("active")), 0);
  assert.equal(await redis.get(key("reserved:21999")), "0");
  assert.deepEqual(await redis.hgetall(key("usage:21999")), {
    prompt_tokens: "1",
    completion_tokens: "4",
    total_tokens: "5",
  });
  assert.equal(await redis.get(key("output:22000")), null);

  const post = await quota.acquire({ ownerId, requestId: "post-midnight", reserveOutputTokens: 5 });
  assert.equal(post.allowed, true);
  assert.equal(post.day, 22_000);
  assert.deepEqual(
    await quota.finish({
      ownerId,
      requestId: "post-midnight",
      quotaDay: 22_000,
      promptTokens: 0,
      completionTokens: 5,
      totalTokens: 5,
    }),
    [5, 5],
  );
  assert.equal(await redis.get(key("reserved:22000")), "0");

  clock = boundary + 120_000;
  const crashed = await quota.acquire({ ownerId, requestId: "crashed", reserveOutputTokens: 90 });
  assert.equal(crashed.allowed, true);
  clock = boundary + 120_000 + 330_000;
  const recovered = await quota.acquire({
    ownerId,
    requestId: "recovered",
    reserveOutputTokens: 90,
  });
  assert.equal(recovered.allowed, true);
  assert.equal(await redis.zcard(key("active")), 1);
  assert.equal(await redis.get(key("reserved:22000")), "90");
  assert.equal(await redis.hget(key("reservations:22000"), "crashed"), null);
  assert.equal(await redis.hget(key("reservations:22000"), "recovered"), "90");
  const blockedAgain = await quota.acquire({
    ownerId,
    requestId: "recovered-2",
    reserveOutputTokens: 1,
  });
  assert.equal(blockedAgain.allowed, false);
  assert.equal(blockedAgain.reason, "concurrency");
});

test("durable resolveAssignment form serves mappings without provider or per-account models fields", async (t) => {
  const seen = [];
  const upstreamCalls = [];
  const f = await startService(t, {
    accountProviderMap: undefined,
    resolveAssignment: async (ownerId) => {
      seen.push(ownerId);
      return { noraUserId: NORA_USER_A, providerId: PROVIDER_A };
    },
    fetchImpl: async (url, options) => {
      upstreamCalls.push({ url: String(url), body: JSON.parse(options.body) });
      return new Response('{"id":"c1","choices":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const modelsResponse = await getModels(
    f.origin,
    makeToken({ method: "GET", path: "/v1/models" }),
  );
  assert.equal(modelsResponse.status, 200);
  const models = await modelsResponse.json();
  assert.deepEqual(
    models.data.map((row) => row.id),
    ["gpt-5.5", "gpt-5.5-pro"],
  );
  assert.equal(JSON.stringify(models).includes(PROVIDER_A), false);
  assert.deepEqual(seen, [OWNER_A.toLowerCase()]);

  const body = Buffer.from(
    JSON.stringify({ model: "gpt-5.5-pro", messages: [{ role: "user", content: "hello" }] }),
  );
  const token = makeToken({ method: "POST", path: "/v1/chat/completions", body });
  const response = await postCompletion(f.origin, body, token);
  assert.equal(response.status, 200);
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].url, "https://api.openai.com/v1/chat/completions");
  assert.equal(upstreamCalls[0].body.max_completion_tokens, 1024);
});

test("resolveAssignment failures and missing mappings fail closed as provider_mapping_unavailable", async (t) => {
  const fetchCalls = [];
  const fetchImpl = async () => {
    fetchCalls.push(1);
    return new Response("{}");
  };

  const failing = await startService(t, {
    accountProviderMap: undefined,
    resolveAssignment: async () => {
      throw Object.assign(new Error("supabase unavailable"), { code: "assignment_lookup_failed" });
    },
    fetchImpl,
  });
  const failure = await getModels(failing.origin, makeToken({ method: "GET", path: "/v1/models" }));
  assert.equal(failure.status, 503);
  assert.equal((await failure.json()).error.code, "provider_mapping_unavailable");

  const missing = await startService(t, {
    accountProviderMap: undefined,
    resolveAssignment: async () => null,
    fetchImpl,
  });
  const absent = await getModels(missing.origin, makeToken({ method: "GET", path: "/v1/models" }));
  assert.equal(absent.status, 503);
  assert.equal((await absent.json()).error.code, "provider_mapping_unavailable");
  assert.deepEqual(fetchCalls, []);
});

test("the inference service accepts exactly one assignment source", () => {
  const base = {
    assertionSecret: SECRET,
    resolveProvider: async () => provider(),
    quotaStore: createMemoryQuotaStore({ now: () => NOW }),
  };
  assert.throws(() => createInferenceService(base), /inference_service_dependencies_invalid/);
  assert.throws(
    () =>
      createInferenceService({
        ...base,
        accountProviderMap: policyMap(),
        resolveAssignment: async () => null,
      }),
    /inference_service_dependencies_invalid/,
  );
  assert.throws(
    () => createInferenceService({ ...base, accountProviderMap: "not-a-map" }),
    /inference_service_dependencies_invalid/,
  );
  assert.throws(
    () => createInferenceService({ ...base, resolveAssignment: "not-a-function" }),
    /inference_service_dependencies_invalid/,
  );
  assert.throws(
    () => createInferenceService({ ...base, accountProviderMap: null, resolveAssignment: null }),
    /inference_service_dependencies_invalid/,
  );
});

test("an owner on the default assignment sees and may use Lite and Pro, Lite listed first", async (t) => {
  const upstreamCalls = [];
  const f = await startService(t, {
    accountProviderMap: undefined,
    resolveAssignment: async () => ({
      noraUserId: NORA_USER_A,
      providerId: PROVIDER_A,
      tiers: ["headmaster-lite", "headmaster-pro"],
    }),
    fetchImpl: async (url, options) => {
      upstreamCalls.push(JSON.parse(options.body));
      return new Response('{"id":"c1","choices":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const models = await (
    await getModels(f.origin, makeToken({ method: "GET", path: "/v1/models" }))
  ).json();
  assert.deepEqual(Object.keys(models.headmaster_tiers), ["headmaster-lite", "headmaster-pro"]);

  for (const [model, status] of [
    ["headmaster-max", 400],
    ["gpt-5.5-pro", 400],
    ["headmaster-lite", 200],
    ["headmaster-pro", 200],
  ]) {
    const body = Buffer.from(
      JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    );
    const token = makeToken({ method: "POST", path: "/v1/chat/completions", body });
    assert.equal((await postCompletion(f.origin, body, token)).status, status, model);
  }
  assert.equal(upstreamCalls.length, 2);
});

test("Lite and Pro map to their OpenRouter models from config, with env overrides", () => {
  assert.deepEqual(DEFAULT_TIER_MODELS, {
    "headmaster-lite": "deepseek/deepseek-v4.1-flash",
    "headmaster-pro": "xiaomi/mimo-v2.6-pro",
  });
  assert.deepEqual(tierModelsFromEnv({}), DEFAULT_TIER_MODELS);
  const overridden = tierModelsFromEnv({ HEADMASTER_INFERENCE_TIER_PRO_MODEL: " vendor/other " });
  assert.equal(overridden["headmaster-pro"], "vendor/other");
  assert.equal(overridden["headmaster-lite"], "deepseek/deepseek-v4.1-flash");
  const allowed = ["deepseek/deepseek-v4.1-flash", "xiaomi/mimo-v2.6-pro"];
  assert.equal(resolveTierModel("headmaster-lite", allowed), "deepseek/deepseek-v4.1-flash");
  assert.equal(resolveTierModel("headmaster-pro", allowed), "xiaomi/mimo-v2.6-pro");
  // A mapped model the account is not allowed never widens the allowlist.
  assert.equal(resolveTierModel("headmaster-pro", ["deepseek/deepseek-v4.1-flash"]), "deepseek/deepseek-v4.1-flash");
  // Max is gone: it is no longer a tier, so it is passed through and rejected as a model.
  assert.equal(resolveTierModel("headmaster-max", allowed), "headmaster-max");
  assert.deepEqual(tierAssignments("openrouter", allowed), {
    "headmaster-lite": { model: "deepseek/deepseek-v4.1-flash", openrouter_id: "deepseek/deepseek-v4.1-flash" },
    "headmaster-pro": { model: "xiaomi/mimo-v2.6-pro", openrouter_id: "xiaomi/mimo-v2.6-pro" },
  });
});

function fakeWallet({ allowed = true, reason = null, fail = false } = {}) {
  const calls = { reserve: [], settle: [] };
  return {
    calls,
    configured: true,
    async reserve(args) {
      calls.reserve.push(args);
      if (fail) throw Object.assign(new Error("wallet_unavailable"), { code: "wallet_unavailable" });
      return { allowed, reason, balanceMicroUsd: 0, freeMicroUsd: 0 };
    },
    async settle(args) {
      calls.settle.push(args);
    },
  };
}

async function walletCompletion(t, walletOptions, serviceOptions = {}) {
  const walletStore = fakeWallet(walletOptions);
  const f = await startService(t, { walletStore, ...serviceOptions });
  const body = Buffer.from(
    JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }),
  );
  const response = await postCompletion(
    f.origin,
    body,
    makeToken({ method: "POST", path: "/v1/chat/completions", body }),
  );
  return { response, walletStore, f };
}

test("wallet on: an empty wallet answers 402 insufficient_credit and releases the Redis hold", async (t) => {
  const { response, walletStore } = await walletCompletion(
    t,
    { allowed: false, reason: "insufficient_credit" },
    { walletMode: "on" },
  );
  assert.equal(response.status, 402);
  const error = (await response.json()).error;
  assert.equal(error.code, "insufficient_credit");
  assert.doesNotMatch(error.message, /Hermes|Nous|Nora/i);
  assert.equal(walletStore.calls.settle.length, 0);
});

test("wallet on: a suspended organization answers 403 and an unreachable wallet answers 503", async (t) => {
  const suspended = await walletCompletion(t, { allowed: false, reason: "org_suspended" }, { walletMode: "on" });
  assert.equal(suspended.response.status, 403);
  assert.equal((await suspended.response.json()).error.code, "organization_suspended");
  const down = await walletCompletion(t, { fail: true }, { walletMode: "on" });
  assert.equal(down.response.status, 503);
  assert.equal((await down.response.json()).error.code, "quota_unavailable");
});

test("wallet off: the wallet is never called", async (t) => {
  const { walletStore } = await walletCompletion(t, {}, { walletMode: "off" });
  assert.equal(walletStore.calls.reserve.length, 0);
});

test("the monthly spend cap answers 429 monthly_budget_exceeded in plain Headmaster wording", async (t) => {
  const quota = createMemoryQuotaStore({ maxMicroUsdPerMonth: 0, now: () => NOW });
  const f = await startService(t, { quotaStore: quota });
  const body = Buffer.from(
    JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }),
  );
  const response = await postCompletion(
    f.origin,
    body,
    makeToken({ method: "POST", path: "/v1/chat/completions", body }),
  );
  assert.equal(response.status, 429);
  const error = (await response.json()).error;
  assert.equal(error.code, "monthly_budget_exceeded");
  assert.match(error.message, /this month's Headmaster allowance/);
  assert.doesNotMatch(error.message, /Hermes|Nous|Nora|token/i);
});

test("spend is charged from OpenRouter usage.cost, else from the configured price table", async (t) => {
  assert.equal(costMicroUsd({ promptTokens: 10, completionTokens: 10, costUsd: 0.0123 }, "m"), 12_300);
  const prices = priceTableFromEnv({
    HEADMASTER_INFERENCE_PRICES_JSON: '{"m":{"prompt":0.5,"completion":2},"bad":{"prompt":-1,"completion":1}}',
  });
  assert.deepEqual(Object.keys(prices), ["m"]);
  assert.equal(costMicroUsd({ promptTokens: 1000, completionTokens: 500, costUsd: null }, "m", prices), 1500);
  assert.equal(costMicroUsd({ promptTokens: 1000, completionTokens: 500, costUsd: null }, "other", prices), null);
  assert.deepEqual(priceTableFromEnv({ HEADMASTER_INFERENCE_PRICES_JSON: "not json" }), {});
  assert.deepEqual(Object.keys(priceTableFromEnv({})).sort(), ["deepseek/deepseek-v4.1-flash", "xiaomi/mimo-v2.6-pro"]);

  const quota = createMemoryQuotaStore({ maxMicroUsdPerMonth: 20_000, now: () => NOW });
  const f = await startService(t, {
    quotaStore: quota,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ id: "c", choices: [], usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0.015 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  const body = Buffer.from(
    JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }),
  );
  const send = () =>
    postCompletion(f.origin, body, makeToken({ method: "POST", path: "/v1/chat/completions", body }));
  assert.equal((await send()).status, 200); // $0.015 of $0.02
  assert.equal((await send()).status, 200); // $0.030, now over the cap
  assert.equal((await send()).status, 429);
});

test("monthly spend accumulates across days in the same UTC month and resets next month", async () => {
  let at = Date.UTC(2026, 9, 30, 12);
  const quota = createMemoryQuotaStore({ maxMicroUsdPerMonth: 1_000, now: () => at });
  const first = await quota.acquire({ ownerId: OWNER_A, requestId: "r1", reserveOutputTokens: 1 });
  assert.equal(first.allowed, true);
  await quota.finish({ ownerId: OWNER_A, requestId: "r1", quotaDay: first.day, costMicroUsd: 1_000 });
  at = Date.UTC(2026, 9, 31, 12);
  assert.deepEqual(
    await quota.acquire({ ownerId: OWNER_A, requestId: "r2", reserveOutputTokens: 1 }),
    { allowed: false, reason: "monthly_budget" },
  );
  at = Date.UTC(2026, 10, 1, 1);
  assert.equal((await quota.acquire({ ownerId: OWNER_A, requestId: "r3", reserveOutputTokens: 1 })).allowed, true);
});

test("Redis quota store passes the month key, cap and request cost to its scripts", async () => {
  const calls = [];
  const redis = { async eval(...args) { calls.push(args); return [1, "ok"]; } };
  const quota = createRedisQuotaStore(redis, { maxMicroUsdPerMonth: 777, now: () => Date.UTC(2026, 9, 6) });
  const reservation = await quota.acquire({ ownerId: OWNER_A, requestId: "r1", reserveOutputTokens: 5 });
  await quota.finish({ ownerId: OWNER_A, requestId: "r1", quotaDay: reservation.day, costMicroUsd: 42 });
  assert.equal(calls[0][1], 9);
  assert.equal(calls[0][8], `headmaster-inference:${OWNER_A}:month:2026-10`);
  assert.equal(calls[0][9], `headmaster-inference:${OWNER_A}:month-reserved:2026-10`);
  assert.equal(calls[0][10], `headmaster-inference:${OWNER_A}:month-reservations:2026-10`);
  assert.equal(calls[0].at(-3), 777);
  assert.equal(calls[1][1], 9);
  assert.equal(calls[1][8], `headmaster-inference:${OWNER_A}:month:2026-10`);
  assert.equal(calls[1].at(-1), 42);
  assert.match(calls[1][0], /HGET', KEYS\[9\]/);
  assert.match(calls[0][0], /monthly_budget/);
});

test("two concurrent requests at $1.99 -> one 429", async (t) => {
  // $1.99 of the $2.00 allowance is already settled this month.
  const quota = createMemoryQuotaStore({ now: () => NOW });
  const seed = await quota.acquire({ ownerId: OWNER_A, requestId: "seed", reserveOutputTokens: 0 });
  await quota.finish({ ownerId: OWNER_A, requestId: "seed", quotaDay: seed.day, costMicroUsd: 1_990_000 });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const f = await startService(t, {
    quotaStore: quota,
    // 1024 reserved output tokens x $8/1M = ~$0.008 per request: one fits, two do not.
    priceTable: { "gpt-5.5": { prompt: 0.001, completion: 8 } },
    fetchImpl: async () => {
      await gate;
      return new Response(
        JSON.stringify({ id: "c", choices: [], usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0.001 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const body = Buffer.from(JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }));
  const send = () =>
    postCompletion(f.origin, body, makeToken({ method: "POST", path: "/v1/chat/completions", body }));
  const first = send();
  // Let the first request take its reservation before the second arrives.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = await send();
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.code, "monthly_budget_exceeded");
  release();
  assert.equal((await first).status, 200);
  // Settlement releases the reservation and adds only the actual cost.
  const next = await quota.acquire({ ownerId: OWNER_A, requestId: "after", reserveOutputTokens: 0, reserveMicroUsd: 9_000 });
  assert.equal(next.allowed, true);
});

test("a model with no known price is refused, not charged $0", async (t) => {
  let called = false;
  const f = await startService(t, {
    priceTable: {},
    fetchImpl: async () => {
      called = true;
      return new Response("{}", { status: 200 });
    },
  });
  const body = Buffer.from(JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }));
  const response = await postCompletion(
    f.origin,
    body,
    makeToken({ method: "POST", path: "/v1/chat/completions", body }),
  );
  assert.equal(response.status, 503);
  const error = (await response.json()).error;
  assert.equal(error.code, "model_price_unknown");
  assert.doesNotMatch(error.message, /Hermes|Nous|Nora/i);
  assert.equal(called, false);
  assert.equal(f.quota.inspect(OWNER_A).active, 0);
});

test("wallet markup: a model that is not a Headmaster tier uses its own markup, default at cost", async (t) => {
  const at = async (options) =>
    (await walletCompletion(t, {}, { walletMode: "on", ...options })).walletStore.calls.reserve[0].amountMicroUsd;
  const base = await at({});
  assert.ok(base > 0);
  // The tier markup does not touch a public-priced model.
  assert.equal(await at({ walletMarkupBps: 12_500 }), base);
  // The other-model markup does.
  assert.ok((await at({ walletOtherMarkupBps: 20_000 })) > base);
});
