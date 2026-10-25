// Wallet store for the managed-inference relay. The wallet lives in Headmaster
// Supabase (public.wallets and wallet_ledger, site migration
// 20261023090000_headmaster_wallets.sql); the relay reserves an estimate before
// the provider call and settles the real cost after it, over PostgREST with the
// same server-only credential the assignments use. A failed call is never
// cached: reserve failures deny; a settle failure is logged and, with a retry queue, retried.
import { validateSupabaseOrigin } from "./assignments.mjs";

export const WALLET_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 16_384;
const RPC = "/rest/v1/rpc/";

function walletError(code) {
  return Object.assign(new Error(code), { code });
}

export function createWalletStore({
  supabaseUrl,
  serviceRoleKey,
  fetchImpl = fetch,
  timeoutMs = WALLET_TIMEOUT_MS,
  retryQueue = null, // { push(string), pop() } -> string | null; see createRedisSettleQueue
} = {}) {
  let base = null;
  try {
    base = validateSupabaseOrigin(supabaseUrl);
  } catch {
    base = null;
  }
  const key = String(serviceRoleKey ?? "").trim();
  const configured = Boolean(base && key) && typeof fetchImpl === "function";

  async function call(fn, body) {
    if (!configured) throw walletError("wallet_unavailable");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(walletError("wallet_unavailable")), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(`${base}${RPC}${fn}`, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          apikey: key,
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response || !response.ok) throw walletError("wallet_unavailable");
      const text = await response.text();
      if (text.length > MAX_BODY_BYTES) throw walletError("wallet_unavailable");
      const rows = JSON.parse(text);
      if (!Array.isArray(rows) || rows.length !== 1) throw walletError("wallet_unavailable");
      return rows[0];
    } catch (error) {
      throw error?.code === "wallet_unavailable" ? error : walletError("wallet_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }

  async function settleOnce({ ownerId, requestId, actualMicroUsd, detail = {} }) {
    await call("headmaster_wallet_settle_owner", {
      p_owner_id: ownerId,
      p_request_id: requestId,
      p_actual_micro_usd: actualMicroUsd,
      p_detail: detail,
    });
  }

  async function enqueueSettle(args) {
    try {
      await retryQueue?.push(JSON.stringify(args));
    } catch {
      // The caller's log line is the record when the queue is unreachable too.
    }
  }

  return {
    configured,
    // -> { allowed, reason, balanceMicroUsd, freeMicroUsd }
    async reserve({ ownerId, requestId, amountMicroUsd, monthlyGrantMicroUsd = 0 }) {
      const row = await call("headmaster_wallet_reserve_owner", {
        p_owner_id: ownerId,
        p_request_id: requestId,
        p_amount_micro_usd: amountMicroUsd,
        p_monthly_grant_micro_usd: monthlyGrantMicroUsd,
      });
      return {
        allowed: row.allowed === true,
        reason: row.reason ?? null,
        balanceMicroUsd: Number(row.balance_micro_usd),
        freeMicroUsd: Number(row.free_micro_usd),
      };
    },
    // Releases the hold and charges actualMicroUsd (0 releases only).
    // A failed settle is queued for a later retry (when a retry queue is wired) and still
    // throws, so the caller logs it as before. Settling a request twice charges once.
    async settle(args) {
      try {
        await settleOnce(args);
      } catch (error) {
        await enqueueSettle(args);
        throw error;
      }
    },
    // Retries up to `limit` queued settles; one that fails again goes back on the queue.
    // -> { retried, failed }
    async retryFailedSettles(limit = 50) {
      let retried = 0;
      let failed = 0;
      for (let i = 0; i < limit; i += 1) {
        let raw;
        try {
          raw = await retryQueue?.pop();
        } catch {
          break;
        }
        if (!raw) break;
        let args;
        try {
          args = JSON.parse(raw);
        } catch {
          continue;
        }
        try {
          await settleOnce(args);
          retried += 1;
        } catch {
          failed += 1;
          await enqueueSettle(args);
          // Wallet unreachable: stop here rather than cycle the whole queue.
          break;
        }
      }
      return { retried, failed };
    },
  };
}

// Failed settles wait in a Redis list (bounded) until retryFailedSettles runs.
const SETTLE_RETRY_KEY = "headmaster-inference:wallet:settle-retry";
const SETTLE_RETRY_MAX = 5_000;

export function createRedisSettleQueue(redis, { key = SETTLE_RETRY_KEY, max = SETTLE_RETRY_MAX } = {}) {
  if (!redis || typeof redis.lpush !== "function") throw new Error("settle_queue_invalid");
  return {
    async push(value) {
      await redis.lpush(key, value);
      await redis.ltrim(key, 0, max - 1);
    },
    pop: () => redis.rpop(key),
  };
}

// Charged price: provider cost times a markup in basis points (10000 = at cost).
export function withMarkup(microUsd, markupBps) {
  return Math.ceil((microUsd * markupBps) / 10_000);
}

const MAX_MARKUP_BPS = 100_000;

function requiredMarkupBps(env, name) {
  const raw = String(env[name] ?? "").trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${name}_required`);
  const bps = Number.parseInt(raw, 10);
  // Below 10000 would sell under provider cost.
  if (bps < 10_000 || bps > MAX_MARKUP_BPS) throw new Error(`${name}_invalid`);
  return bps;
}

// The wallet is always on and both markups are mandatory: there is no at-cost default.
export function walletConfigFromEnv(env) {
  const mode = String(env.HEADMASTER_INFERENCE_WALLET ?? "on").trim().toLowerCase();
  if (mode !== "on") throw new Error("HEADMASTER_INFERENCE_WALLET_must_be_on");
  return {
    walletMode: "on",
    walletMarkupBps: requiredMarkupBps(env, "HEADMASTER_INFERENCE_WALLET_MARKUP_BPS"),
    walletOtherMarkupBps: requiredMarkupBps(env, "HEADMASTER_INFERENCE_WALLET_OTHER_MARKUP_BPS"),
  };
}
