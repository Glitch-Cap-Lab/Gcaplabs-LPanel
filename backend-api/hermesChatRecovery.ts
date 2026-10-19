// @ts-nocheck
// The HTTP producer is Core217 + original-key lookup223. This adapter never
// resends input and never treats a legacy run-cache response as a receipt.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (s, max = 500) =>
  typeof s === "string" && s.length > 0 && s.length <= max && !/[\x00-\x1f\x7f]/.test(s);
const fail = (code = "chat_recovery_unavailable", statusCode = 409) =>
  Object.assign(new Error(code), { code, statusCode });
function chatIdentity(input, ownerId) {
  if (input?.ownerId !== ownerId) throw fail("chat_owner_changed", 403);
  if (
    !UUID.test(input?.requestId || "") ||
    !text(input?.sessionId, 200) ||
    /[/\\?#]/.test(input.sessionId) ||
    input.profile != null
  )
    throw fail("chat_identity_invalid", 400);
  return { ownerId, requestId: input.requestId, sessionId: input.sessionId, profile: null };
}
function canonicalRun(data, previous = null) {
  const r = data?.receipt;
  if (
    data?.object !== "hermes.run" ||
    !text(data.run_id) ||
    !text(data.session_id, 200) ||
    !text(data.admission_id) ||
    !r ||
    !text(r.admission_id) ||
    !text(r.ref?.profile_id, 200) ||
    r.ref?.session_id !== data.session_id ||
    r.admission_id !== data.admission_id ||
    r.execution_generation !== data.execution_generation ||
    !["queued", "started", "unknown", "terminal"].includes(r.status) ||
    !Number.isSafeInteger(r.authority_epoch) ||
    r.authority_epoch < 0 ||
    !Number.isSafeInteger(r.sequence) ||
    r.sequence < 0 ||
    !(
      r.execution_generation === null ||
      (Number.isSafeInteger(r.execution_generation) && r.execution_generation > 0)
    ) ||
    (r.status === "unknown" && !r.execution_generation) ||
    ![
      "queued",
      "running",
      "waiting_for_approval",
      "unknown",
      "completed",
      "failed",
      "cancelled",
    ].includes(data.status) ||
    (previous &&
      (r.admission_id !== previous.admission_id ||
        r.ref.profile_id !== previous.ref?.profile_id ||
        r.ref.session_id !== previous.ref?.session_id))
  )
    throw fail("chat_receipt_mismatch");
  if (
    (r.status === "queued" && data.status !== "queued") ||
    (r.status === "started" && !["running", "waiting_for_approval"].includes(data.status)) ||
    (r.status === "unknown" && data.status !== "unknown") ||
    (r.status === "terminal" && !["completed", "failed", "cancelled"].includes(data.status))
  )
    throw fail("chat_receipt_mismatch");
  return {
    runId: data.run_id,
    status: data.status,
    output: typeof data.output === "string" ? data.output : "",
    receipt: {
      admission_id: r.admission_id,
      ref: { profile_id: r.ref.profile_id, session_id: r.ref.session_id },
      sequence: r.sequence,
      authority_epoch: r.authority_epoch,
      execution_generation: r.execution_generation,
      status: r.status,
      outcome: r.outcome ?? null,
    },
  };
}
async function lookupChat(agent, identity, fetchApi) {
  const response = await fetchApi(
    agent,
    `/v1/runs/${encodeURIComponent(identity.requestId)}?source=chat`,
    {
      method: "GET",
      timeoutMs: 15000,
      headers: { "X-Hermes-Session-Id": identity.sessionId },
    },
  );
  if (!response.ok) throw fail("chat_recovery_unavailable", response.status === 503 ? 503 : 409);
  return canonicalRun(response.data);
}
async function historyFor(agent, run, fetchApi) {
  const result = await fetchApi(
    agent,
    `/api/sessions/${encodeURIComponent(run.receipt.ref.session_id)}/messages?limit=100&order=latest`,
    { method: "GET", timeoutMs: 15000 },
  );
  // Core may resolve a compression alias; its authenticated session handler owns
  // that lineage. Do not guess message matches or claim a partial page is complete.
  if (
    !result.ok ||
    result.data?.object !== "list" ||
    !text(result.data?.session_id, 200) ||
    !Array.isArray(result.data?.data)
  )
    throw fail("chat_history_unavailable");
  return result.data.data
    .filter((m) => ["user", "assistant"].includes(m?.role) && typeof m.content === "string")
    .map((m) => ({
      id: m.id ?? m.message_id ?? null,
      role: m.role,
      content: m.content,
      createdAt: typeof m.timestamp === "number" ? new Date(m.timestamp * 1000).toISOString() : m.timestamp ?? m.created_at ?? null,
    }));
}
async function inspectChat(agent, identity, fetchApi) {
  const run = await lookupChat(agent, identity, fetchApi);
  try {
    return { ...run, history: await historyFor(agent, run, fetchApi), historyAvailable: true };
  } catch {
    return { ...run, history: null, historyAvailable: false };
  }
}
async function resolveChat(agent, identity, expected, fetchApi) {
  if (
    !expected ||
    !text(expected.admission_id) ||
    !text(expected.ref?.profile_id, 200) ||
    !text(expected.ref?.session_id, 200) ||
    !Number.isSafeInteger(expected.execution_generation) ||
    expected.execution_generation < 1
  )
    throw fail("chat_resolution_invalid", 400);
  const current = await lookupChat(agent, identity, fetchApi);
  const r = current.receipt;
  if (
    r.admission_id !== expected.admission_id ||
    r.ref.profile_id !== expected.ref.profile_id ||
    r.ref.session_id !== expected.ref.session_id ||
    r.execution_generation !== expected.execution_generation
  )
    throw fail("chat_receipt_mismatch");
  if (r.status === "terminal") return current;
  if (r.status !== "unknown") throw fail("chat_not_unknown");
  const response = await fetchApi(
    agent,
    `/v1/runs/${encodeURIComponent(current.runId)}/resolve-unknown`,
    {
      method: "POST",
      timeoutMs: 15000,
      body: { admission_id: r.admission_id, execution_generation: r.execution_generation },
    },
  );
  if (!response.ok || response.data?.run_id !== current.runId)
    throw fail("chat_resolution_refused", response.status === 503 ? 503 : 409);
  const settled = response.data;
  if (
    settled.admission_id !== r.admission_id ||
    settled.ref?.session_id !== r.ref.session_id ||
    settled.ref?.profile_id !== r.ref.profile_id ||
    settled.execution_generation !== r.execution_generation ||
    settled.status !== "terminal" ||
    settled.outcome !== "interrupted" ||
    !Number.isSafeInteger(settled.authority_epoch) ||
    settled.authority_epoch < r.authority_epoch
  )
    throw fail("chat_receipt_mismatch");
  return {
    ...current,
    status: "cancelled",
    receipt: {
      ...r,
      status: settled.status,
      outcome: settled.outcome,
      authority_epoch: settled.authority_epoch,
    },
  };
}
module.exports = { chatIdentity, canonicalRun, inspectChat, resolveChat };
