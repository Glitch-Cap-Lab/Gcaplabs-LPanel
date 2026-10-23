// Wallet store for the managed-inference relay. The wallet lives in Headmaster
// Supabase (public.wallets and wallet_ledger, site migration
// 20261023090000_headmaster_wallets.sql); the relay reserves an estimate before
// the provider call and settles the real cost after it, over PostgREST with the
// same server-only credential the assignments use. A failed call is never
// retried or cached: reserve failures deny, settle failures are logged.
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
    async settle({ ownerId, requestId, actualMicroUsd, detail = {} }) {
      await call("headmaster_wallet_settle_owner", {
        p_owner_id: ownerId,
        p_request_id: requestId,
        p_actual_micro_usd: actualMicroUsd,
        p_detail: detail,
      });
    },
  };
}

// Charged price: provider cost times a markup in basis points (10000 = at cost).
export function withMarkup(microUsd, markupBps) {
  return Math.ceil((microUsd * markupBps) / 10_000);
}
