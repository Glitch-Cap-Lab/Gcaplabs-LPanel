// Run by the paired pytest fixture against actual pinned Core HTTP handlers.
const assert = require("node:assert/strict");
const { inspectChat, resolveChat } = require("../hermesChatRecovery.ts");
const core = `http://127.0.0.1:${process.env.T14_CORE_PORT}`;
const calls = [];
async function fetchApi(agent, path, options = {}) {
  calls.push({ path, method: options.method || "GET" });
  const response = await fetch(core + path, {
    method: options.method || "GET",
    headers: {
      Authorization: "Bearer receipt-lookup-api-key-long-enough",
      ...options.headers,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  return { ok: response.ok, status: response.status, data: await response.json() };
}
(async () => {
  const identity = {
    ownerId: "synthetic-operator",
    requestId: "c7427a31-cef5-4d6c-8041-6f943733a91e",
    sessionId: "chat-owned",
    profile: null,
  };
  const response = await fetchApi({}, "/v1/chat/completions", {
    method: "POST",
    headers: { "Idempotency-Key": identity.requestId, "X-Hermes-Session-Id": identity.sessionId },
    body: { messages: [{ role: "user", content: "once from LP" }] },
  });
  assert.equal(response.status, 200); // Drop every returned response ID and receipt.
  const recovered = await inspectChat({}, identity, fetchApi);
  assert.equal(recovered.receipt.status, "terminal");
  assert.equal(recovered.output, "saved answer");
  assert.equal(recovered.historyAvailable, true);
  assert.equal(recovered.receipt.ref.session_id, identity.sessionId);
  await assert.rejects(inspectChat({}, { ...identity, sessionId: "foreign-session" }, fetchApi));
  await fetch(core + "/fixture/unknown", { method: "POST" });
  const unknownId = {
    ...identity,
    requestId: "46b09436-de77-42c1-a711-1b923ca02843",
    sessionId: "unknown-chain",
  };
  const unknown = await inspectChat({}, unknownId, fetchApi);
  assert.equal(unknown.receipt.status, "unknown");
  const before = calls.length;
  await assert.rejects(
    resolveChat(
      {},
      unknownId,
      { ...unknown.receipt, execution_generation: unknown.receipt.execution_generation + 1 },
      fetchApi,
    ),
  );
  assert.equal(
    calls.slice(before).some((c) => c.method === "POST"),
    false,
  );
  let lost = false;
  await assert.rejects(
    resolveChat({}, unknownId, unknown.receipt, async (...args) => {
      const result = await fetchApi(...args);
      if (args[1].endsWith("/resolve-unknown")) {
        lost = true;
        throw new Error("lost resolution ACK");
      }
      return result;
    }),
  );
  assert.equal(lost, true);
  const settled = await resolveChat({}, unknownId, unknown.receipt, fetchApi);
  assert.equal(settled.receipt.status, "terminal");
  assert.equal(settled.receipt.outcome, "interrupted");
  assert.equal(calls.filter((c) => c.path === "/v1/chat/completions").length, 1);
  assert.equal(calls.filter((c) => c.path.endsWith("/resolve-unknown")).length, 1);
  console.log(
    JSON.stringify({
      chain: "actual LP recovery adapter -> actual Core217+223 HTTP handlers",
      terminalBeforeAck: true,
      history: true,
      foreignSessionDenied: true,
      staleGenerationDenied: true,
      unknownLostResolveAckRecovered: true,
      inputPosts: 1,
      resolvePosts: 1,
    }),
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
