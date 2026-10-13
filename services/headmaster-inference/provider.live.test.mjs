// Real-endpoint coverage for the managed inference relay's OpenRouter protocol.
//
// Gating and how to run:
//   * `live:` tests need OPENROUTER_API_KEY and call the real
//     https://openrouter.ai/api/v1 endpoint (a few hundred tokens at most):
//       OPENROUTER_API_KEY=... node --test provider.live.test.mjs
//   * The real-endpoint auth-failure probe also runs without a funded key when
//     HEADMASTER_INFERENCE_LIVE=1 is set — it uses a deliberately invalid
//     credential, so nothing is spent.
//   * Parameterize the model under test with HEADMASTER_LIVE_MODEL=<id>.
//   * Everything else in this file is offline relay wiring/policy coverage and
//     always runs, so `node --test *.test.mjs` stays green in CI.
//
// The exact model ids exercised here must stay in sync with
// TESTED_PROVIDER_COVERAGE.openrouter in policy.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { ASSERTION_AUDIENCE, sha256, signAssertion } from "./assertion.mjs";
import { createInferenceService } from "./lib.mjs";
import { createMemoryQuotaStore } from "./quota.mjs";
import { priceTableFromEnv } from "./policy.mjs";
import {
  allowedModelsForProvider,
  parseAccountProviderMap,
  providerCompletionUrl,
  safeProviderError,
  testedProviderModels,
} from "./policy.mjs";

const LIVE_API_KEY = String(process.env.OPENROUTER_API_KEY || "");
const LIVE_SKIP = LIVE_API_KEY ? false : "OPENROUTER_API_KEY is not set";
const AUTH_PROBE_SKIP =
  LIVE_API_KEY || process.env.HEADMASTER_INFERENCE_LIVE === "1"
    ? false
    : "OPENROUTER_API_KEY is not set and HEADMASTER_INFERENCE_LIVE is not 1";

// Model ids exercised against the real endpoint by the `live:` tests.
const LIVE_MODEL = String(process.env.HEADMASTER_LIVE_MODEL || "deepseek/deepseek-v4.1-flash");
const LIVE_MODELS = [LIVE_MODEL];
// A real OpenRouter alias Nora defaults to elsewhere but that the relay
// deliberately withholds until a live test covers it.
const UNTESTED_MODEL = "openrouter/auto";

const SECRET = randomBytes(48).toString("base64url");
const OWNER = "99999999-9999-4999-8999-999999999999";
const NORA_USER = "88888888-8888-4888-8888-888888888888";
const PROVIDER_ID = "77777777-7777-4777-8777-777777777777";

function makeToken({ method, path, body = Buffer.alloc(0), owner = OWNER }) {
  const iat = Math.floor(Date.now() / 1000);
  return signAssertion(
    {
      v: 1,
      aud: ASSERTION_AUDIENCE,
      sub: owner,
      authorization_revision: "1",
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

function accountMap({ models } = {}) {
  return parseAccountProviderMap(
    JSON.stringify({
      [OWNER]: {
        noraUserId: NORA_USER,
        providerId: PROVIDER_ID,
        provider: "openrouter",
        ...(models ? { models } : {}),
      },
    }),
  );
}

function openRouterProvider({ apiKey = LIVE_API_KEY, models = LIVE_MODELS, baseUrl = "" } = {}) {
  return { id: PROVIDER_ID, provider: "openrouter", apiKey, baseUrl, models };
}

async function startService(
  t,
  { provider = openRouterProvider(), map = accountMap(), fetchImpl, ...overrides } = {},
) {
  const quota = createMemoryQuotaStore({ now: () => Date.now() });
  const service = createInferenceService({
    assertionSecret: SECRET,
    accountProviderMap: map,
    resolveProvider: async (noraUserId, providerId) => {
      assert.equal(noraUserId, NORA_USER);
      assert.equal(providerId, PROVIDER_ID);
      return provider;
    },
    quotaStore: quota,
    // The relay refuses unpriced models; price every model this suite routes to.
    priceTable: {
      ...Object.fromEntries(LIVE_MODELS.map((m) => [m, { prompt: 1, completion: 1 }])),
      ...priceTableFromEnv(process.env),
    },
    ...(fetchImpl ? { fetchImpl } : {}),
    requestTimeoutMs: 60_000,
    logger: { info() {}, warn() {}, error() {} },
    ...overrides,
  });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  const origin = `http://127.0.0.1:${service.server.address().port}`;
  t.after(() => new Promise((resolve) => service.server.close(resolve)));
  return { ...service, origin, quota };
}

function postCompletion(origin, body, token, signal) {
  return fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-headmaster-inference-assertion": token },
    body,
    signal,
  });
}

function recordingFetch() {
  const calls = [];
  return {
    calls,
    fetchImpl: (url, options) => {
      calls.push({ url: String(url), options, parsed: JSON.parse(options.body) });
      return globalThis.fetch(url, options);
    },
  };
}

async function waitFor(predicate, { timeoutMs = 15_000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("OpenRouter is an allowlisted OpenAI-compatible protocol at a fixed endpoint", () => {
  const map = accountMap();
  assert.equal(map.get(OWNER).provider, "openrouter");

  // Fixed destination: host/port/scheme drift and client-supplied URLs fail closed.
  assert.equal(
    String(providerCompletionUrl({ provider: "openrouter" })),
    "https://openrouter.ai/api/v1/chat/completions",
  );
  assert.equal(
    String(
      providerCompletionUrl({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1/" }),
    ),
    "https://openrouter.ai/api/v1/chat/completions",
  );
  assert.throws(
    () =>
      providerCompletionUrl({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai.evil.example/api/v1",
      }),
    /allowlisted/,
  );
  assert.throws(
    () => providerCompletionUrl({ provider: "openrouter", baseUrl: "http://openrouter.ai/api/v1" }),
    /allowlisted/,
  );
  assert.throws(
    () =>
      providerCompletionUrl({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai:8443/api/v1",
      }),
    /allowlisted/,
  );

  // Error mapping table the live tests exercise against the real endpoint.
  assert.equal(safeProviderError(401).code, "provider_authentication_failed");
  assert.equal(safeProviderError(401).status, 502);
  assert.equal(safeProviderError(403).code, "provider_authentication_failed");
  assert.equal(safeProviderError(400).code, "provider_request_rejected");
  assert.equal(safeProviderError(404).code, "provider_request_rejected");
  assert.equal(safeProviderError(422).code, "provider_request_rejected");
  assert.equal(safeProviderError(429).code, "provider_rate_limited");
  assert.equal(safeProviderError(402).code, "provider_error");
  assert.equal(safeProviderError(500).code, "provider_error");
  assert.equal(safeProviderError(503).status, 502);
});

test("model lists derive from the assigned provider config filtered by tested coverage", async (t) => {
  // Provider row configures a tested model plus an untested alias; the untested
  // alias is filtered out of both discovery and request admission.
  const configured = [...LIVE_MODELS, UNTESTED_MODEL];
  const provider = openRouterProvider({ apiKey: "unused-hermetic-key", models: configured });
  const { fetchImpl, calls } = recordingFetch();
  const f = await startService(t, { provider, fetchImpl });

  const modelsResponse = await fetch(`${f.origin}/v1/models`, {
    headers: {
      "x-headmaster-inference-assertion": makeToken({ method: "GET", path: "/v1/models" }),
    },
  });
  assert.equal(modelsResponse.status, 200);
  const listed = (await modelsResponse.json()).data.map((row) => row.id);
  assert.deepEqual(listed, LIVE_MODELS);
  assert.equal(JSON.stringify(listed).includes(UNTESTED_MODEL), false);
  assert.equal(calls.length, 0);

  // Per-account narrowing from the trusted assignment still applies.
  const narrowed = accountMap({ models: LIVE_MODELS });
  assert.deepEqual(allowedModelsForProvider(narrowed.get(OWNER), configured), LIVE_MODELS);
  assert.deepEqual(
    allowedModelsForProvider(accountMap().get(OWNER), []),
    testedProviderModels("openrouter"),
  );
  assert.throws(() => accountMap({ models: [UNTESTED_MODEL] }), /invalid model allowlist/);

  // An untested model never reaches the provider.
  const body = Buffer.from(
    JSON.stringify({ model: UNTESTED_MODEL, messages: [{ role: "user", content: "hi" }] }),
  );
  const rejected = await postCompletion(
    f.origin,
    body,
    makeToken({ method: "POST", path: "/v1/chat/completions", body }),
  );
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error.code, "model_not_allowed");
  assert.equal(calls.length, 0);
});

test("relay wiring: fixed endpoint, bearer auth, redirects disabled, OpenAI-compatible body", async (t) => {
  const upstreamBody = JSON.stringify({
    id: "chatcmpl-hermetic",
    object: "chat.completion",
    model: LIVE_MODEL,
    choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  });
  const { fetchImpl, calls } = recordingFetch();
  const f = await startService(t, {
    provider: openRouterProvider({ apiKey: "hermetic-provider-key", models: LIVE_MODELS }),
    fetchImpl: (url, options) => {
      calls.push({ url: String(url), options, parsed: JSON.parse(options.body) });
      return new Response(upstreamBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const body = Buffer.from(
    JSON.stringify({ model: LIVE_MODEL, messages: [{ role: "user", content: "ping" }] }),
  );
  const response = await postCompletion(
    f.origin,
    body,
    makeToken({ method: "POST", path: "/v1/chat/completions", body }),
  );
  assert.equal(response.status, 200);
  const raw = await response.text();
  assert.equal(raw, upstreamBody);
  assert.equal(raw.includes("hermetic-provider-key"), false);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.authorization, "Bearer hermetic-provider-key");
  assert.equal(calls[0].options.headers.accept, "application/json");
  assert.equal(calls[0].parsed.model, LIVE_MODEL);
  // OpenRouter accepts max_tokens, so the relay injects its default there.
  assert.equal(calls[0].parsed.max_tokens, 1024);
  assert.equal(calls[0].parsed.max_completion_tokens, undefined);
  assert.equal(f.quota.inspect(OWNER).usage.promptTokens, 11);
  assert.equal(f.quota.inspect(OWNER).usage.completionTokens, 7);
});

test("unsupported surfaces stay closed", async (t) => {
  const { fetchImpl, calls } = recordingFetch();
  const f = await startService(t, { fetchImpl });
  const responsesPost = await fetch(`${f.origin}/v1/responses`, { method: "POST", body: "{}" });
  assert.equal(responsesPost.status, 404);
  assert.equal((await responsesPost.json()).error.code, "not_found");
  const wrongMethod = await fetch(`${f.origin}/v1/chat/completions`);
  assert.equal(wrongMethod.status, 404);
  const queryString = await fetch(`${f.origin}/v1/models?stream=true`, {
    headers: {
      "x-headmaster-inference-assertion": makeToken({ method: "GET", path: "/v1/models" }),
    },
  });
  assert.equal(queryString.status, 404);
  assert.equal(calls.length, 0);
});

test("live: non-streaming chat completion", { skip: LIVE_SKIP }, async (t) => {
  const { fetchImpl, calls } = recordingFetch();
  const f = await startService(t, { fetchImpl });
  const body = Buffer.from(
    JSON.stringify({
      model: LIVE_MODEL,
      messages: [{ role: "user", content: "Reply with exactly: pong" }],
      max_tokens: 256,
    }),
  );
  const response = await postCompletion(
    f.origin,
    body,
    makeToken({ method: "POST", path: "/v1/chat/completions", body }),
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.object, "chat.completion");
  const message = payload.choices[0].message;
  assert.equal(message.role, "assistant");
  assert.match(message.content.toLowerCase(), /pong/);
  assert.ok(
    payload.usage.prompt_tokens > 0,
    "expected non-zero prompt tokens from the live provider",
  );
  assert.ok(
    payload.usage.completion_tokens > 0,
    "expected non-zero completion tokens from the live provider",
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.authorization, `Bearer ${LIVE_API_KEY}`);
  assert.equal(calls[0].parsed.model, LIVE_MODEL);
  assert.equal(JSON.stringify(payload).includes(LIVE_API_KEY), false);
  assert.ok(f.quota.inspect(OWNER).usage.promptTokens > 0);
});

test("live: streaming SSE passthrough and usage accounting", { skip: LIVE_SKIP }, async (t) => {
  const { fetchImpl, calls } = recordingFetch();
  const f = await startService(t, { fetchImpl });
  // Reasoning-capable models spend part of this budget on reasoning deltas
  // before any content arrives; keep enough headroom for both.
  const maxTokens = 256;
  const body = Buffer.from(
    JSON.stringify({
      model: LIVE_MODEL,
      stream: true,
      max_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: "Count from one to five, separated by spaces, with no other words.",
        },
      ],
      stream_options: { include_usage: true },
    }),
  );
  const response = await postCompletion(
    f.origin,
    body,
    makeToken({ method: "POST", path: "/v1/chat/completions", body }),
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
  assert.equal(response.headers.get("x-accel-buffering"), "no");

  const text = await response.text();
  const frameLines = text.split("\n").filter((line) => line.startsWith("data:"));
  assert.ok(frameLines.length >= 3, `expected several SSE frames, saw ${frameLines.length}`);
  assert.equal(text.trimEnd().endsWith("data: [DONE]"), true);
  const frames = frameLines
    .map((line) => line.slice(5).trim())
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data));
  assert.ok(
    frames.some((frame) => {
      const delta = frame.choices?.[0]?.delta || {};
      const content = typeof delta.content === "string" ? delta.content : "";
      const reasoning = String(delta.reasoning ?? delta.reasoning_content ?? "");
      return content.length > 0 || reasoning.length > 0;
    }),
    "expected at least one streamed delta (content or reasoning)",
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.accept, "text/event-stream");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].parsed.stream, true);

  const usageFrame = frames.filter((frame) => frame.usage).at(-1);
  const inspection = f.quota.inspect(OWNER);
  if (usageFrame) {
    assert.equal(inspection.usage.promptTokens, usageFrame.usage.prompt_tokens);
    assert.equal(inspection.usage.completionTokens, usageFrame.usage.completion_tokens);
  } else {
    // Provider omitted usage: the relay charges the conservative reservation.
    assert.equal(inspection.usage.completionTokens, maxTokens);
  }
  assert.equal(inspection.active, 0);
});

test("live: one tool-call turn is relayed unchanged", { skip: LIVE_SKIP }, async (t) => {
  const { fetchImpl, calls } = recordingFetch();
  const f = await startService(t, { fetchImpl });
  const tools = [
    {
      type: "function",
      function: {
        name: "get_time",
        description: "Return the current time for a timezone.",
        parameters: {
          type: "object",
          properties: { timezone: { type: "string", description: "IANA timezone name, e.g. UTC" } },
          required: ["timezone"],
          additionalProperties: false,
        },
      },
    },
  ];
  const body = Buffer.from(
    JSON.stringify({
      model: LIVE_MODEL,
      messages: [
        {
          role: "user",
          content: "Call the get_time tool for timezone UTC. Do not answer with text.",
        },
      ],
      tools,
      tool_choice: "auto",
      max_tokens: 128,
    }),
  );
  const response = await postCompletion(
    f.origin,
    body,
    makeToken({ method: "POST", path: "/v1/chat/completions", body }),
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  const choice = payload.choices[0];
  assert.equal(choice.finish_reason, "tool_calls");
  const call = choice.message.tool_calls?.[0];
  assert.ok(call, "expected the model to emit a tool call");
  assert.equal(call.type, "function");
  assert.equal(call.function.name, "get_time");
  const args = JSON.parse(call.function.arguments);
  assert.equal(args.timezone, "UTC");

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].parsed.tools, tools);
  assert.equal(calls[0].parsed.tool_choice, "auto");
});

test(
  "live: client cancellation aborts the upstream stream without retry",
  { skip: LIVE_SKIP },
  async (t) => {
    let upstreamSignal = null;
    const { fetchImpl: record, calls } = recordingFetch();
    const f = await startService(t, {
      fetchImpl: (url, options) => {
        upstreamSignal = options.signal;
        return record(url, options);
      },
    });
    const body = Buffer.from(
      JSON.stringify({
        model: LIVE_MODEL,
        stream: true,
        max_tokens: 400,
        messages: [
          {
            role: "user",
            content:
              "Write a long, detailed essay about the history of rivers. Keep writing for many paragraphs.",
          },
        ],
      }),
    );
    const abort = new AbortController();
    const response = await postCompletion(
      f.origin,
      body,
      makeToken({ method: "POST", path: "/v1/chat/completions", body }),
      abort.signal,
    );
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false, "expected the first stream chunk before cancelling");
    abort.abort();
    await reader.cancel().catch(() => {});

    await waitFor(() => upstreamSignal?.aborted === true, { label: "upstream abort propagation" });
    await waitFor(() => f.quota.inspect(OWNER).active === 0, { label: "reservation release" });
    assert.equal(calls.length, 1, "client cancellation must not be retried");
    assert.equal(f.quota.inspect(OWNER).active, 0);
    assert.ok(
      f.quota.inspect(OWNER).usage.completionTokens > 0,
      "cancelled stream still settles conservatively",
    );
  },
);

test(
  "live: invalid provider credential maps to a safe authentication error",
  { skip: AUTH_PROBE_SKIP },
  async (t) => {
    const { fetchImpl, calls } = recordingFetch();
    const f = await startService(t, {
      provider: openRouterProvider({ apiKey: "sk-or-v1-deliberately-invalid-relay-probe" }),
      fetchImpl,
    });
    const body = Buffer.from(
      JSON.stringify({
        model: LIVE_MODEL,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8,
      }),
    );
    const response = await postCompletion(
      f.origin,
      body,
      makeToken({ method: "POST", path: "/v1/chat/completions", body }),
    );
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.error.code, "provider_authentication_failed");
    const raw = JSON.stringify(payload);
    // The provider's own error body (e.g. OpenRouter's `User not found.`) never
    // reaches the client.
    assert.equal(/user not found/i.test(raw), false);
    assert.equal(raw.includes("sk-or-v1-deliberately-invalid-relay-probe"), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
  },
);
