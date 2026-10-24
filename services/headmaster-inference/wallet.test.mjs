import assert from "node:assert/strict";
import test from "node:test";
import { createWalletStore, walletConfigFromEnv, withMarkup } from "./wallet.mjs";

const OWNER = "11111111-1111-4111-8111-111111111111";

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const out = handler(url, JSON.parse(init.body));
    return { ok: out.ok !== false, text: async () => JSON.stringify(out.rows ?? []) };
  };
  return { fetchImpl, calls };
}

test("reserve calls the owner RPC with the service key and maps the row", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({
    rows: [{ allowed: false, reason: "insufficient_credit", balance_micro_usd: "250", free_micro_usd: "250" }],
  }));
  const store = createWalletStore({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service-key",
    fetchImpl,
  });
  const hold = await store.reserve({ ownerId: OWNER, requestId: "r1", amountMicroUsd: 900, monthlyGrantMicroUsd: 2_000_000 });
  assert.deepEqual(hold, { allowed: false, reason: "insufficient_credit", balanceMicroUsd: 250, freeMicroUsd: 250 });
  assert.equal(calls[0].url, "https://project.supabase.co/rest/v1/rpc/headmaster_wallet_reserve_owner");
  assert.equal(calls[0].init.headers.authorization, "Bearer service-key");
  assert.equal(calls[0].init.redirect, "error");
  assert.deepEqual(calls[0].body, {
    p_owner_id: OWNER,
    p_request_id: "r1",
    p_amount_micro_usd: 900,
    p_monthly_grant_micro_usd: 2_000_000,
  });
});

test("settle posts the actual cost; an HTTP failure or odd shape is wallet_unavailable", async () => {
  const ok = fakeFetch(() => ({ rows: [{ settled: true, balance_micro_usd: 1 }] }));
  const store = createWalletStore({ supabaseUrl: "https://project.supabase.co", serviceRoleKey: "k", fetchImpl: ok.fetchImpl });
  await store.settle({ ownerId: OWNER, requestId: "r1", actualMicroUsd: 400 });
  assert.equal(ok.calls[0].body.p_actual_micro_usd, 400);

  for (const handler of [() => ({ ok: false }), () => ({ rows: [] }), () => ({ rows: [{}, {}] })]) {
    const bad = createWalletStore({ supabaseUrl: "https://project.supabase.co", serviceRoleKey: "k", fetchImpl: fakeFetch(handler).fetchImpl });
    await assert.rejects(bad.reserve({ ownerId: OWNER, requestId: "r", amountMicroUsd: 1 }), { code: "wallet_unavailable" });
  }
});

test("without a valid origin and key the store is not configured and refuses", async () => {
  const store = createWalletStore({ supabaseUrl: "http://example.test", serviceRoleKey: "" });
  assert.equal(store.configured, false);
  await assert.rejects(store.reserve({ ownerId: OWNER, requestId: "r", amountMicroUsd: 1 }), { code: "wallet_unavailable" });
});

test("markup is in basis points and rounds up", () => {
  assert.equal(withMarkup(1000, 10_000), 1000);
  assert.equal(withMarkup(1000, 12_500), 1250);
  assert.equal(withMarkup(3, 12_500), 4);
});

test("wallet config needs both markups and refuses shadow, off and below-cost values", () => {
  const ok = {
    HEADMASTER_INFERENCE_WALLET_MARKUP_BPS: "12500",
    HEADMASTER_INFERENCE_WALLET_OTHER_MARKUP_BPS: "11000",
  };
  assert.deepEqual(walletConfigFromEnv(ok), { walletMode: "on", walletMarkupBps: 12500, walletOtherMarkupBps: 11000 });
  assert.equal(walletConfigFromEnv({ ...ok, HEADMASTER_INFERENCE_WALLET: "on" }).walletMode, "on");
  for (const bad of [
    {},
    { HEADMASTER_INFERENCE_WALLET_MARKUP_BPS: "12500" },
    { HEADMASTER_INFERENCE_WALLET_OTHER_MARKUP_BPS: "11000" },
    { ...ok, HEADMASTER_INFERENCE_WALLET: "shadow" },
    { ...ok, HEADMASTER_INFERENCE_WALLET: "off" },
    { ...ok, HEADMASTER_INFERENCE_WALLET_OTHER_MARKUP_BPS: "9000" },
    { ...ok, HEADMASTER_INFERENCE_WALLET_MARKUP_BPS: "abc" },
    { ...ok, HEADMASTER_INFERENCE_WALLET_MARKUP_BPS: "100001" },
  ])
    assert.throws(() => walletConfigFromEnv(bad));
});
