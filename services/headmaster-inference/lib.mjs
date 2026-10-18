import http from "node:http";
import { createReplayCache, verifyAssertion } from "./assertion.mjs";
import {
  TESTED_MODELS,
  BYO_MODELS_CAP,
  BYO_MODEL_ID,
  allowedModelsForProvider,
  isByoProvider,
  normalizeUsage,
  costMicroUsd,
  prepareByoChatCompletion,
  prepareChatCompletion,
  providerCompletionUrl,
  providerModelsUrl,
  safeProviderError,
  tierAssignments,
  DEFAULT_TIER_MODELS,
} from "./policy.mjs";
import {
  REALTIME_SESSION_PATH,
  isRealtimeProvider,
  mintRealtimeToken,
  prepareRealtimeRequest,
} from "./realtime.mjs";

export const MAX_REQUEST_BYTES = 36 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MODEL_PATH = "/v1/models";
const COMPLETION_PATH = "/v1/chat/completions";
const quietLogger = { info() {}, warn() {}, error() {} };

function sendJson(res, status, body, requestId, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": String(Buffer.byteLength(payload)),
    ...extraHeaders,
    ...(requestId ? { "x-request-id": requestId } : {}),
  });
  res.end(payload);
}

async function readBody(req, cap) {
  const declared = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declared) && declared > cap)
    throw Object.assign(new Error("payload_too_large"), { statusCode: 413 });
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > cap) throw Object.assign(new Error("payload_too_large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function safeError(res, status, code, message, requestId, extraHeaders = {}) {
  return sendJson(
    res,
    status,
    { error: { message, type: "inference_error", code }, request_id: requestId },
    requestId,
    extraHeaders,
  );
}

function jsonUsage(buffer) {
  try {
    const usage = JSON.parse(buffer.toString("utf8"))?.usage;
    return usage && typeof usage === "object" ? normalizeUsage(usage) : null;
  } catch {
    return null;
  }
}

function createSseUsageParser() {
  let pending = "";
  let eventData = [];
  let usage = null;
  const decoder = new TextDecoder();
  const flushEvent = () => {
    if (eventData.length) {
      const data = eventData.join("\n");
      if (data !== "[DONE]") {
        try {
          const parsed = JSON.parse(data);
          if (parsed?.usage && typeof parsed.usage === "object")
            usage = normalizeUsage(parsed.usage);
        } catch {
          /* non-JSON SSE event; forwarded unchanged */
        }
      }
    }
    eventData = [];
  };
  const consumeLine = (line) => {
    if (line === "") return flushEvent();
    if (line.startsWith("data:")) eventData.push(line.slice(5).replace(/^ /, ""));
  };
  return {
    push(chunk) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) consumeLine(line);
      if (pending.length > 1024 * 1024) pending = pending.slice(-1024 * 1024);
    },
    end() {
      pending += decoder.decode();
      if (pending) consumeLine(pending);
      flushEvent();
      return usage;
    },
    get usage() {
      return usage;
    },
  };
}

function waitForDrain(res, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason || new Error("aborted"));
    if (res.destroyed || res.writableEnded) return reject(new Error("downstream_closed"));
    const cleanup = () => {
      res.removeListener("drain", onDrain);
      res.removeListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("downstream_closed"));
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason || new Error("aborted"));
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function copyStreamingResponse(response, res, signal, requestId, maxResponseBytes) {
  const contentType = response.headers.get("content-type") || "text/event-stream; charset=utf-8";
  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-cache, no-store",
    "x-request-id": requestId,
    "x-accel-buffering": "no",
  });
  const parser = createSseUsageParser();
  let sentBytes = 0;
  if (!response.body) {
    res.end();
    return null;
  }
  for await (const chunk of response.body) {
    sentBytes += chunk.byteLength;
    if (sentBytes > maxResponseBytes)
      throw Object.assign(new Error("provider_response_too_large"), {
        code: "provider_response_too_large",
      });
    parser.push(chunk);
    if (!res.write(chunk)) await waitForDrain(res, signal);
  }
  if (!res.writableEnded) res.end();
  return parser.end();
}

async function readProviderResponse(response, cap) {
  const chunks = [];
  let total = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > cap)
        throw Object.assign(new Error("provider_response_too_large"), {
          code: "provider_response_too_large",
        });
      chunks.push(Buffer.from(chunk));
    }
  }
  return Buffer.concat(chunks);
}

function onlyTier(tiers, allowed) {
  if (!allowed) return tiers;
  return Object.fromEntries(Object.entries(tiers).filter(([name]) => allowed.includes(name)));
}

function modelList(models, requestId, tiers = undefined) {
  return {
    object: "list",
    data: models.map((id) => ({ id, object: "model", owned_by: "headmaster" })),
    // Which backing model each Headmaster tier resolves to for this account.
    ...(tiers ? { headmaster_tiers: tiers } : {}),
    request_id: requestId,
  };
}

export function createInferenceService({
  assertionSecret,
  accountProviderMap,
  resolveAssignment,
  resolveProvider,
  quotaStore,
  fetchImpl = fetch,
  now = () => Date.now(),
  logger = quietLogger,
  maxRequestBytes = MAX_REQUEST_BYTES,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  maxCompletionTokens = 4096,
  defaultCompletionTokens = 1024,
  // Tier id -> backend model id (see tierModelsFromEnv in policy.mjs).
  tierModels = DEFAULT_TIER_MODELS,
  // Fallback per-model prices for responses that carry no usage.cost.
  priceTable = {},
  requestTimeoutMs = 120_000,
  replayStore = null,
  // Personal provider keys (optional). Without both, byo requests fail 503
  // own_key_unavailable and the operator path is unaffected.
  resolveOwnKey = null,
  byoQuotaStore = null,
} = {}) {
  if (typeof assertionSecret !== "string" || Buffer.byteLength(assertionSecret) < 32)
    throw new Error("assertion_secret_invalid");
  // Exactly one assignment source is accepted: the legacy env map (wrapped into
  // an async lookup) or a durable async resolveAssignment(ownerId) resolver.
  const hasAccountProviderMap = accountProviderMap !== undefined && accountProviderMap !== null;
  const hasResolveAssignment = resolveAssignment !== undefined && resolveAssignment !== null;
  if (hasAccountProviderMap === hasResolveAssignment)
    throw new Error("inference_service_dependencies_invalid");
  // Settled cost: the reported or table cost; if neither is known, the reserved
  // estimate (never $0 for a request that produced tokens).
  function chargedCost(usage, model, requestId, fallback = 0) {
    const cost = costMicroUsd(usage, model, priceTable);
    if (cost === null && (usage?.promptTokens || usage?.completionTokens)) {
      logger.warn?.("headmaster-inference cost unknown", { requestId, model });
      return fallback;
    }
    return cost ?? 0;
  }
  // Upper-bound estimate held against the monthly cap: prompt tokens approximated
  // as request bytes / 4, plus the full output reservation. null = unknown price.
  function estimatedCostMicroUsd(prepared) {
    const price = priceTable[prepared.body?.model];
    if (!price) return null;
    const promptTokens = Math.ceil(Buffer.byteLength(JSON.stringify(prepared.body)) / 4);
    return Math.ceil(promptTokens * price.prompt + prepared.reserveOutputTokens * price.completion);
  }
  if (hasAccountProviderMap && !(accountProviderMap instanceof Map))
    throw new Error("inference_service_dependencies_invalid");
  if (hasResolveAssignment && typeof resolveAssignment !== "function")
    throw new Error("inference_service_dependencies_invalid");
  if (typeof resolveProvider !== "function" || !quotaStore) {
    throw new Error("inference_service_dependencies_invalid");
  }
  const lookupAssignment = hasAccountProviderMap
    ? async (ownerId) => accountProviderMap.get(ownerId) ?? null
    : resolveAssignment;
  const replay = replayStore || createReplayCache({ now });

  async function handle(req, res) {
    const url = new URL(req.url || "/", "http://inference.internal");
    if (req.method === "GET" && url.pathname === "/healthz" && !url.search) {
      return sendJson(res, 200, { data: { ok: true } });
    }
    if (
      url.search ||
      !(
        (req.method === "GET" && url.pathname === MODEL_PATH) ||
        (req.method === "POST" && url.pathname === COMPLETION_PATH) ||
        (req.method === "POST" && url.pathname === REALTIME_SESSION_PATH)
      )
    ) {
      return safeError(res, 404, "not_found", "Route not found.", null);
    }
    let body;
    try {
      body = await readBody(req, maxRequestBytes);
    } catch (error) {
      return safeError(
        res,
        error.statusCode === 413 ? 413 : 400,
        error.statusCode === 413 ? "payload_too_large" : "body_invalid",
        error.statusCode === 413 ? "Request body is too large." : "Request body could not be read.",
        null,
      );
    }
    if (req.method === "GET" && body.length > 0)
      return safeError(res, 400, "body_not_allowed", "GET requests cannot contain a body.", null);

    const claims = verifyAssertion(req.headers["x-headmaster-inference-assertion"], {
      secret: assertionSecret,
      method: req.method,
      path: url.pathname,
      body,
      now,
    });
    if (!claims)
      return safeError(
        res,
        401,
        "assertion_invalid",
        "Private inference assertion is invalid.",
        null,
      );
    let replayClaimed;
    try {
      replayClaimed = await replay.claim(claims.nonce, claims.exp);
    } catch (error) {
      logger.warn?.("headmaster-inference replay store unavailable", {
        requestId: claims.request_id,
        code: error?.code || "replay_store_unavailable",
      });
      return safeError(
        res,
        503,
        "replay_store_unavailable",
        "Managed inference is temporarily unavailable.",
        claims.request_id,
      );
    }
    if (!replayClaimed)
      return safeError(
        res,
        401,
        "assertion_replayed",
        "Private inference assertion was already used.",
        claims.request_id,
      );
    // A verified byo_provider claim selects the personal-key path. It never
    // reads assignments, operator provider rows, or operator quota counters.
    if (url.pathname === REALTIME_SESSION_PATH) return handleRealtime(res, body, claims);
    if (claims.byo_provider !== undefined) return handleByo(req, res, body, claims);
    let mapping;
    try {
      mapping = await lookupAssignment(claims.sub.toLowerCase());
    } catch (error) {
      logger.warn?.("headmaster-inference assignment lookup failed", {
        requestId: claims.request_id,
        code: error?.code || "assignment_lookup_failed",
      });
      return safeError(
        res,
        503,
        "provider_mapping_unavailable",
        "Managed inference is not configured for this account.",
        claims.request_id,
      );
    }
    if (
      !mapping ||
      typeof mapping !== "object" ||
      Array.isArray(mapping) ||
      typeof mapping.noraUserId !== "string" ||
      typeof mapping.providerId !== "string"
    ) {
      return safeError(
        res,
        503,
        "provider_mapping_unavailable",
        "Managed inference is not configured for this account.",
        claims.request_id,
      );
    }

    let provider;
    try {
      provider = await resolveProvider(mapping.noraUserId, mapping.providerId);
    } catch (error) {
      logger.warn?.("headmaster-inference provider lookup failed", {
        requestId: claims.request_id,
        code: error?.code || "provider_lookup_failed",
      });
      return safeError(
        res,
        503,
        "provider_unavailable",
        "Managed inference is not available.",
        claims.request_id,
      );
    }
    if (
      !provider ||
      provider.id !== mapping.providerId ||
      !provider.apiKey ||
      (mapping.provider !== undefined && provider.provider !== mapping.provider)
    ) {
      return safeError(
        res,
        503,
        "provider_unavailable",
        "Managed inference is not available.",
        claims.request_id,
      );
    }
    // Durable assignments carry no provider protocol and no per-account model
    // list. The existing Nora provider row supplies the protocol; the tested
    // provider/model catalogue still gates which models are exposed.
    if (
      mapping.provider === undefined &&
      !Object.hasOwn(TESTED_MODELS, String(provider.provider || ""))
    ) {
      logger.warn?.("headmaster-inference assignment provider protocol unsupported", {
        requestId: claims.request_id,
      });
      return safeError(
        res,
        503,
        "provider_mapping_unavailable",
        "Managed inference is not configured for this account.",
        claims.request_id,
      );
    }
    const effectiveMapping =
      mapping.provider === undefined ? { ...mapping, provider: provider.provider } : mapping;

    // An owner served by the default assignment (no row of their own) gets the
    // default tiers only (Lite and Pro); a row of their own unlocks other models.
    const tierOnly = Array.isArray(effectiveMapping.tiers) ? effectiveMapping.tiers : null;

    if (req.method === "GET") {
      const models = allowedModelsForProvider(effectiveMapping, provider.models);
      if (models.length === 0)
        return safeError(
          res,
          503,
          "models_unavailable",
          "No compatible models are enabled for this account.",
          claims.request_id,
        );
      return sendJson(
        res,
        200,
        modelList(models, claims.request_id, onlyTier(tierAssignments(effectiveMapping.provider, models, tierModels), tierOnly)),
        claims.request_id,
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      return safeError(
        res,
        400,
        "body_invalid",
        "Request body must be valid JSON.",
        claims.request_id,
      );
    }
    if (tierOnly && !tierOnly.includes(parsed?.model)) {
      return safeError(
        res,
        400,
        "model_not_allowed",
        "This account can use the Headmaster tiers only.",
        claims.request_id,
      );
    }
    const prepared = prepareChatCompletion(parsed, effectiveMapping, provider.models, {
      maxCompletionTokens,
      defaultCompletionTokens,
      tierModels,
    });
    if (prepared.error) {
      return safeError(
        res,
        400,
        prepared.error,
        "The request is not supported by the managed inference contract.",
        claims.request_id,
      );
    }

    let target;
    try {
      target = providerCompletionUrl(provider);
    } catch (error) {
      return safeError(
        res,
        503,
        error?.code || "provider_endpoint_unavailable",
        "The configured provider endpoint is not supported.",
        claims.request_id,
      );
    }
    // Fail closed: a model with no known price cannot be held to the monthly cap.
    const estimatedCost = estimatedCostMicroUsd(prepared);
    if (estimatedCost === null) {
      logger.warn?.("headmaster-inference model price unknown", {
        requestId: claims.request_id,
        model: prepared.body?.model,
      });
      return safeError(
        res,
        503,
        "model_price_unknown",
        "This model is not available on the Headmaster allowance right now.",
        claims.request_id,
      );
    }
    const reservation = await quotaStore
      .acquire({
        ownerId: claims.sub,
        requestId: claims.request_id,
        reserveOutputTokens: prepared.reserveOutputTokens,
        reserveMicroUsd: estimatedCost,
      })
      .catch((error) => {
        logger.error?.("headmaster-inference quota lookup failed", {
          requestId: claims.request_id,
          code: error?.code || "quota_store_unavailable",
        });
        return null;
      });
    if (!reservation)
      return safeError(
        res,
        503,
        "quota_unavailable",
        "Managed inference is temporarily unavailable.",
        claims.request_id,
      );
    if (!reservation.allowed) {
      if (reservation.reason === "monthly_budget")
        return safeError(
          res,
          429,
          "monthly_budget_exceeded",
          "You have used this month's Headmaster allowance. It resets on the 1st of next month (UTC).",
          claims.request_id,
        );
      const code =
        reservation.reason === "concurrency"
          ? "too_many_concurrent_requests"
          : reservation.reason === "token_budget"
            ? "completion_budget_exceeded"
            : "request_budget_exceeded";
      return safeError(
        res,
        429,
        code,
        "This account has reached its managed inference limit.",
        claims.request_id,
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () =>
        controller.abort(
          Object.assign(new Error("provider_timeout"), { code: "provider_timeout" }),
        ),
      requestTimeoutMs,
    );
    timeout.unref?.();
    const onAborted = () => controller.abort(new Error("client_cancelled"));
    const onClose = () => {
      if (!res.writableFinished) controller.abort(new Error("client_cancelled"));
    };
    const onSocketClose = () => {
      if (!res.writableFinished) controller.abort(new Error("client_cancelled"));
    };
    req.once("aborted", onAborted);
    req.socket?.once("close", onSocketClose);
    res.once("close", onClose);

    let providerSucceeded = false;
    let observedUsage = null;
    try {
      const upstream = await fetchImpl(target, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${provider.apiKey}`,
          "content-type": "application/json",
          accept: prepared.body.stream === true ? "text/event-stream" : "application/json",
          "x-request-id": claims.request_id,
        },
        body: JSON.stringify(prepared.body),
      });
      if (!upstream.ok) {
        const failure = safeProviderError(upstream.status);
        await upstream.body?.cancel().catch(() => {});
        const retryAfter = upstream.headers.get("retry-after");
        const retryHeaders =
          retryAfter && /^\d{1,6}$/.test(retryAfter) ? { "retry-after": retryAfter } : {};
        return safeError(
          res,
          failure.status,
          failure.code,
          failure.message,
          claims.request_id,
          retryHeaders,
        );
      }
      providerSucceeded = true;
      if (prepared.body.stream === true) {
        observedUsage = await copyStreamingResponse(
          upstream,
          res,
          controller.signal,
          claims.request_id,
          maxResponseBytes,
        );
      } else {
        const responseBody = await readProviderResponse(upstream, maxResponseBytes);
        observedUsage = jsonUsage(responseBody);
        res.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-request-id": claims.request_id,
        });
        res.end(responseBody);
      }
      const loggedUsage = observedUsage || {
        promptTokens: 0,
        completionTokens: prepared.reserveOutputTokens,
      };
      logger.info?.("headmaster-inference completed", {
        requestId: claims.request_id,
        model: parsed.model,
        inputTokens: loggedUsage.promptTokens,
        outputTokens: loggedUsage.completionTokens,
      });
    } catch (error) {
      const disconnected =
        controller.signal.aborted && controller.signal.reason?.message === "client_cancelled";
      if (disconnected) {
        logger.info?.("headmaster-inference cancelled", {
          requestId: claims.request_id,
          model: parsed.model,
        });
      } else if (res.headersSent) {
        res.destroy();
      } else if (controller.signal.aborted || error?.code === "provider_timeout") {
        safeError(res, 504, "provider_timeout", "The model provider timed out.", claims.request_id);
      } else if (error?.code === "provider_response_too_large") {
        safeError(
          res,
          502,
          "provider_response_too_large",
          "The model provider returned an oversized response.",
          claims.request_id,
        );
      } else {
        logger.warn?.("headmaster-inference provider request failed", {
          requestId: claims.request_id,
          code: error?.code || "provider_unavailable",
        });
        safeError(
          res,
          503,
          "provider_unavailable",
          "The model provider is temporarily unavailable.",
          claims.request_id,
        );
      }
    } finally {
      clearTimeout(timeout);
      req.removeListener("aborted", onAborted);
      req.socket?.removeListener("close", onSocketClose);
      res.removeListener("close", onClose);
      const usage =
        observedUsage ||
        (providerSucceeded
          ? {
              promptTokens: 0,
              completionTokens: prepared.reserveOutputTokens,
              totalTokens: prepared.reserveOutputTokens,
            }
          : { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      await quotaStore
        .finish({
          ownerId: claims.sub,
          requestId: claims.request_id,
          quotaDay: reservation.day,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          costMicroUsd: chargedCost(usage, prepared.body?.model, claims.request_id, estimatedCost),
        })
        .catch((error) =>
          logger.error?.("headmaster-inference usage accounting failed", {
            requestId: claims.request_id,
            code: error?.code || "quota_store_unavailable",
          }),
        );
    }
  }

  function byoModelList(ids, provider, requestId) {
    return {
      object: "list",
      data: ids.map((id) => ({ id, object: "model", owned_by: provider })),
      request_id: requestId,
    };
  }

  function byoModelIds(buffer) {
    let parsed;
    try {
      parsed = JSON.parse(buffer.toString("utf8"));
    } catch {
      return null;
    }
    const entries = Array.isArray(parsed?.data) ? parsed.data : null;
    if (!entries) return null;
    const ids = [];
    const seen = new Set();
    for (const entry of entries) {
      const id = typeof entry === "string" ? entry : entry?.id;
      if (typeof id !== "string" || !BYO_MODEL_ID.test(id) || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= BYO_MODELS_CAP) break;
    }
    return ids;
  }

  function byoFailure(res, upstreamStatus, requestId, retryAfter) {
    // Provider error bodies are never relayed (they can echo request detail).
    if (upstreamStatus === 401 || upstreamStatus === 403)
      return safeError(
        res,
        400,
        "own_key_rejected",
        "The model provider rejected your API key.",
        requestId,
      );
    const failure = safeProviderError(upstreamStatus);
    const retryHeaders =
      retryAfter && /^\d{1,6}$/.test(retryAfter) ? { "retry-after": retryAfter } : {};
    return safeError(res, failure.status, failure.code, failure.message, requestId, retryHeaders);
  }

  // Realtime voice session tokens: personal keys only (a v2 assertion naming the
  // provider). Never reads assignments, operator keys, or quota counters.
  async function handleRealtime(res, body, claims) {
    const requestId = claims.request_id;
    const provider = claims.byo_provider;
    if (provider === undefined)
      return safeError(
        res,
        400,
        "realtime_requires_own_key",
        "Realtime sessions need your own API key.",
        requestId,
      );
    if (!isRealtimeProvider(provider))
      return safeError(
        res,
        400,
        "realtime_provider_unsupported",
        "Realtime sessions are not supported for this provider.",
        requestId,
      );
    const request = prepareRealtimeRequest(body);
    if (request.error)
      return safeError(res, 400, request.error, "The realtime session request is invalid.", requestId);
    if (typeof resolveOwnKey !== "function")
      return safeError(res, 503, "own_key_unavailable", "Your API key is temporarily unavailable.", requestId);
    const ownerId = claims.sub.toLowerCase();
    let apiKey;
    try {
      apiKey = await resolveOwnKey(ownerId, provider);
    } catch (error) {
      logger.warn?.("headmaster-inference own key unavailable", {
        requestId,
        provider,
        code: error?.code || "own_key_unavailable",
      });
      return safeError(res, 503, "own_key_unavailable", "Your API key is temporarily unavailable.", requestId);
    }
    if (typeof apiKey !== "string" || !apiKey)
      return safeError(res, 404, "provider_key_missing", "No API key is stored for this provider.", requestId);
    let session;
    try {
      session = await mintRealtimeToken({
        provider,
        apiKey,
        model: request.model,
        ttl: request.ttl,
        fetchImpl,
        now,
      });
    } catch (error) {
      logger.warn?.("headmaster-inference realtime session failed", {
        requestId,
        provider,
        code: error?.code || "provider_error",
      });
      return safeError(
        res,
        error?.status === 429 ? 429 : error?.status === 400 ? 400 : 502,
        error?.code || "provider_error",
        "The provider could not start a realtime session.",
        requestId,
      );
    }
    logger.info?.("headmaster-inference realtime session minted", { ownerId, provider });
    return sendJson(res, 200, { provider, ...session, request_id: requestId }, requestId);
  }

  async function handleByo(req, res, body, claims) {
    const requestId = claims.request_id;
    const provider = claims.byo_provider;
    if (!isByoProvider(provider))
      return safeError(res, 400, "byo_provider_invalid", "Provider is not supported.", requestId);
    if (typeof resolveOwnKey !== "function" || !byoQuotaStore)
      return safeError(
        res,
        503,
        "own_key_unavailable",
        "Your API key is temporarily unavailable.",
        requestId,
      );
    const isModels = req.method === "GET";
    let parsed = null;
    let prepared = null;
    let target;
    try {
      target = isModels ? providerModelsUrl(provider) : providerCompletionUrl({ provider });
    } catch {
      return safeError(
        res,
        503,
        "provider_endpoint_unavailable",
        "The provider endpoint is not supported.",
        requestId,
      );
    }
    if (!isModels) {
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        return safeError(res, 400, "body_invalid", "Request body must be valid JSON.", requestId);
      }
      prepared = prepareByoChatCompletion(parsed, provider, {
        maxCompletionTokens,
        defaultCompletionTokens,
      });
      if (prepared.error)
        return safeError(
          res,
          400,
          prepared.error,
          "The request is not supported by the inference contract.",
          requestId,
        );
    }
    // Resolve the key before taking a quota slot: a request for a provider with
    // no stored key (or while the store is unavailable) must not spend the
    // account's hourly budget or a concurrency slot.
    let apiKey;
    try {
      apiKey = await resolveOwnKey(claims.sub.toLowerCase(), provider);
    } catch (error) {
      logger.warn?.("headmaster-inference own key unavailable", {
        requestId,
        provider,
        code: error?.code || "own_key_unavailable",
      });
      return safeError(
        res,
        503,
        "own_key_unavailable",
        "Your API key is temporarily unavailable.",
        requestId,
      );
    }
    if (typeof apiKey !== "string" || !apiKey)
      return safeError(
        res,
        404,
        "provider_key_missing",
        "No API key is stored for this provider.",
        requestId,
      );
    const reservation = await byoQuotaStore
      .acquire({ ownerId: claims.sub, requestId, reserveOutputTokens: 0 })
      .catch((error) => {
        logger.error?.("headmaster-inference own key quota lookup failed", {
          requestId,
          code: error?.code || "quota_store_unavailable",
        });
        return null;
      });
    if (!reservation)
      return safeError(
        res,
        503,
        "quota_unavailable",
        "Managed inference is temporarily unavailable.",
        requestId,
      );
    if (!reservation.allowed)
      return safeError(
        res,
        429,
        reservation.reason === "concurrency"
          ? "too_many_concurrent_requests"
          : "request_budget_exceeded",
        "This account has reached its request limit.",
        requestId,
      );

    const controller = new AbortController();
    const timeout = setTimeout(
      () =>
        controller.abort(
          Object.assign(new Error("provider_timeout"), { code: "provider_timeout" }),
        ),
      requestTimeoutMs,
    );
    timeout.unref?.();
    const onAborted = () => controller.abort(new Error("client_cancelled"));
    const onClose = () => {
      if (!res.writableFinished) controller.abort(new Error("client_cancelled"));
    };
    req.once("aborted", onAborted);
    req.socket?.once("close", onClose);
    res.once("close", onClose);
    try {
      const streaming = !isModels && prepared.body.stream === true;
      const upstream = await fetchImpl(target, {
        method: isModels ? "GET" : "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          // Anthropic's /v1/models only accepts its native key header.
          ...(provider === "anthropic" ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : {}),
          accept: streaming ? "text/event-stream" : "application/json",
          "x-request-id": requestId,
          ...(isModels ? {} : { "content-type": "application/json" }),
        },
        ...(isModels ? {} : { body: JSON.stringify(prepared.body) }),
      });
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {});
        return byoFailure(res, upstream.status, requestId, upstream.headers.get("retry-after"));
      }
      if (isModels) {
        const ids = byoModelIds(await readProviderResponse(upstream, maxResponseBytes));
        if (!ids)
          return safeError(
            res,
            502,
            "provider_error",
            "The model provider returned an unexpected response.",
            requestId,
          );
        return sendJson(res, 200, byoModelList(ids, provider, requestId), requestId);
      }
      if (streaming) {
        await copyStreamingResponse(upstream, res, controller.signal, requestId, maxResponseBytes);
      } else {
        const responseBody = await readProviderResponse(upstream, maxResponseBytes);
        res.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-request-id": requestId,
        });
        res.end(responseBody);
      }
      logger.info?.("headmaster-inference own key completed", {
        requestId,
        provider,
        model: parsed?.model,
      });
    } catch (error) {
      const disconnected =
        controller.signal.aborted && controller.signal.reason?.message === "client_cancelled";
      if (disconnected) {
        logger.info?.("headmaster-inference own key cancelled", { requestId, provider });
      } else if (res.headersSent) {
        res.destroy();
      } else if (controller.signal.aborted || error?.code === "provider_timeout") {
        safeError(res, 504, "provider_timeout", "The model provider timed out.", requestId);
      } else if (error?.code === "provider_response_too_large") {
        safeError(
          res,
          502,
          "provider_response_too_large",
          "The model provider returned an oversized response.",
          requestId,
        );
      } else {
        logger.warn?.("headmaster-inference own key provider request failed", {
          requestId,
          provider,
          code: error?.code || "provider_unavailable",
        });
        safeError(
          res,
          503,
          "provider_unavailable",
          "The model provider is temporarily unavailable.",
          requestId,
        );
      }
    } finally {
      clearTimeout(timeout);
      req.removeListener("aborted", onAborted);
      req.socket?.removeListener("close", onClose);
      res.removeListener("close", onClose);
      await byoQuotaStore
        .finish({
          ownerId: claims.sub,
          requestId,
          quotaDay: reservation.day,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        })
        .catch((error) =>
          logger.error?.("headmaster-inference own key accounting failed", {
            requestId,
            code: error?.code || "quota_store_unavailable",
          }),
        );
    }
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error) => {
      logger.error?.("headmaster-inference request failed", {
        code: error?.code || "request_failed",
      });
      if (!res.headersSent)
        safeError(res, 500, "inference_error", "Managed inference failed.", null);
      else res.destroy();
    });
  });
  // Bound the time spent receiving request headers/body before handle() can
  // start the provider timeout. This also protects the relay from slow uploads.
  server.requestTimeout = 120_000;
  return { server, handle, replay };
}
