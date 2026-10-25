// @ts-nocheck
// The relay is a separate non-agent process. It imports only Nora's existing
// provider resolver/storage code; it does not import runtime or Docker code.
const path = require("node:path");
const Module = require("node:module");

const serviceNodeModules = path.resolve(__dirname, "node_modules");
process.env.NODE_PATH = [process.env.NODE_PATH, serviceNodeModules]
  .filter(Boolean)
  .join(path.delimiter);
Module._initPaths();

const { resolveInferenceProvider } = require("../../backend-api/llmProviders.ts");
const db = require("../../backend-api/db.ts");
const { createRedisClient } = require("../../backend-api/lib/connectionConfig.ts");
const IORedis = require("ioredis");
const { resolveAssignmentConfiguration } = require("./assignments.mjs");
const { createRedisReplayStore } = require("./assertion.mjs");
const { createRedisQuotaStore, createRedisByoQuotaStore } = require("./quota.mjs");
const { createProviderKeyResolver } = require("./byo.mjs");
const { createInferenceService } = require("./lib.mjs");
const { createWalletStore, createRedisSettleQueue, walletConfigFromEnv } = require("./wallet.mjs");
const { transcriptionConfigFromEnv } = require("./transcription.mjs");
const { speechConfigFromEnv } = require("./speech.mjs");
const { tierModelsFromEnv, priceTableFromEnv } = require("./policy.mjs");

function positiveInt(value, fallback, max) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function usdToMicro(value, fallbackUsd) {
  const parsed = Number.parseFloat(String(value ?? ""));
  const usd = Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackUsd;
  return Math.round(Math.min(usd, 1_000_000) * 1_000_000);
}

function requiredSecret() {
  const secret = String(process.env.HEADMASTER_INFERENCE_ASSERTION_SECRET || "");
  if (Buffer.byteLength(secret) < 32) throw new Error("assertion_secret_invalid");
  return secret;
}

async function main() {
  // Durable assignments come from Headmaster Supabase; the env map remains a
  // LEGACY compatibility source and is only parsed when it is selected.
  const assignments = resolveAssignmentConfiguration(process.env, { logger: console });
  if (assignments.warning) console.warn(assignments.warning);
  const assignmentLookup =
    assignments.mode === "supabase"
      ? { resolveAssignment: assignments.resolveAssignment }
      : { accountProviderMap: assignments.accountProviderMap };

  const redis = createRedisClient(IORedis, process.env, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: false,
  });
  redis.on("error", (error) => {
    console.warn("headmaster-inference redis connection unavailable", {
      code: error?.code || "redis_error",
    });
  });
  // enableOfflineQueue:false makes commands issued before the connection is
  // READY reject immediately ("Stream isn't writeable..."), so the boot probe
  // must not race the initial connect. Wait for readiness (bounded) first.
  if (redis.status !== "ready") {
    await new Promise((resolve, reject) => {
      const onReady = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timer);
        redis.removeListener("ready", onReady);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("redis_connect_timeout"));
      }, 15_000);
      redis.once("ready", onReady);
    });
  }
  await redis.ping();
  await db.query("SELECT 1");

  // Always on; throws without both markups. See wallet.mjs.
  const walletConfig = walletConfigFromEnv(process.env);
  const walletStore = createWalletStore({
    supabaseUrl: process.env.HEADMASTER_INFERENCE_SUPABASE_URL,
    serviceRoleKey: process.env.HEADMASTER_INFERENCE_SUPABASE_SERVICE_ROLE_KEY,
    retryQueue: createRedisSettleQueue(redis),
  });
  if (!walletStore.configured)
    throw new Error("wallet_not_configured");
  // BL13: a settle that failed (wallet briefly unreachable) is retried every minute.
  const settleRetryTimer = setInterval(() => {
    walletStore
      .retryFailedSettles()
      .then((out: { retried: number; failed: number }) => {
        if (out.retried || out.failed)
          console.warn("headmaster-inference wallet settle retry", out);
      })
      .catch(() => undefined);
  }, 60_000);
  settleRetryTimer.unref();
  const quotaStore = createRedisQuotaStore(redis, {
    maxConcurrentPerAccount: positiveInt(process.env.HEADMASTER_INFERENCE_MAX_CONCURRENT, 3, 100),
    maxRequestsPerHour: positiveInt(
      process.env.HEADMASTER_INFERENCE_REQUESTS_PER_HOUR,
      120,
      100_000,
    ),
    maxCompletionTokensPerDay: positiveInt(
      process.env.HEADMASTER_INFERENCE_OUTPUT_TOKENS_PER_DAY,
      120_000,
      100_000_000,
    ),
    // Per-account monthly spend cap in USD (UTC calendar month), stored in micro-USD.
    // With the wallet on it replaces this cap, so the Redis one is lifted.
    maxMicroUsdPerMonth:
      1_000_000 * 1_000_000,
  });
  // Personal provider keys. Always constructed (never throws): with an unset or
  // short HEADMASTER_PROVIDER_KEY_SECRET, or without the Headmaster Supabase
  // credentials, byo requests answer 503 own_key_unavailable and the operator
  // path is unaffected. Uses the same Supabase credentials as the assignments.
  const providerKeySecret = String(process.env.HEADMASTER_PROVIDER_KEY_SECRET || "");
  const resolveOwnKey = createProviderKeyResolver({
    supabaseUrl: process.env.HEADMASTER_INFERENCE_SUPABASE_URL,
    serviceRoleKey: process.env.HEADMASTER_INFERENCE_SUPABASE_SERVICE_ROLE_KEY,
    secret: providerKeySecret,
    logger: console,
  });
  if (Buffer.byteLength(providerKeySecret) < 32)
    console.warn(
      "HEADMASTER_PROVIDER_KEY_SECRET is unset or shorter than 32 bytes; personal provider keys are disabled",
    );
  const byoQuotaStore = createRedisByoQuotaStore(redis, {
    maxConcurrentPerAccount: positiveInt(
      process.env.HEADMASTER_INFERENCE_BYO_MAX_CONCURRENT,
      3,
      100,
    ),
    maxRequestsPerHour: positiveInt(
      process.env.HEADMASTER_INFERENCE_BYO_REQUESTS_PER_HOUR,
      600,
      100_000,
    ),
  });
  const service = createInferenceService({
    resolveOwnKey,
    byoQuotaStore,
    assertionSecret: requiredSecret(),
    ...assignmentLookup,
    resolveProvider: (noraUserId, providerId) =>
      resolveInferenceProvider(noraUserId, providerId, db),
    quotaStore,
    walletStore,
    ...walletConfig,
    transcription: transcriptionConfigFromEnv(process.env),
    speech: speechConfigFromEnv(process.env),
    walletMonthlyGrantMicroUsd: usdToMicro(process.env.HEADMASTER_INFERENCE_USD_PER_MONTH, 2),
    replayStore: createRedisReplayStore(redis),
    maxRequestBytes: positiveInt(
      process.env.HEADMASTER_INFERENCE_MAX_REQUEST_BYTES,
      36 * 1024 * 1024,
      36 * 1024 * 1024,
    ),
    maxCompletionTokens: positiveInt(
      process.env.HEADMASTER_INFERENCE_MAX_COMPLETION_TOKENS,
      4096,
      32_768,
    ),
    defaultCompletionTokens: positiveInt(
      process.env.HEADMASTER_INFERENCE_DEFAULT_COMPLETION_TOKENS,
      1024,
      32_768,
    ),
    tierModels: tierModelsFromEnv(process.env),
    priceTable: priceTableFromEnv(process.env),
    requestTimeoutMs: positiveInt(process.env.HEADMASTER_INFERENCE_TIMEOUT_MS, 120_000, 600_000),
    logger: console,
  });
  const listen = process.env.HEADMASTER_INFERENCE_LISTEN || "0.0.0.0:8781";
  const splitAt = listen.lastIndexOf(":");
  const host = listen.slice(0, splitAt);
  const port = Number(listen.slice(splitAt + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("listen_address_invalid");

  service.server.listen(port, host, () => {
    console.log(`headmaster-inference listening on ${host}:${port}`, {
      assignmentSource: assignments.mode,
    });
  });
  const shutdown = () => {
    service.server.close(() => {
      void Promise.allSettled([redis.quit(), db.end()]).finally(() => process.exit(0));
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((error) => {
  console.error("headmaster-inference startup failed", {
    code: error?.code || error?.message || "startup_failed",
  });
  process.exit(1);
});
