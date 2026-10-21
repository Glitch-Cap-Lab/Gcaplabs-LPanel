export type ChatScope = { ownerId: string; agentId: string; profile: null };
export type ChatReceipt = {
  admission_id: string;
  ref: { profile_id: string; session_id: string };
  sequence: number;
  authority_epoch: number;
  execution_generation: number | null;
  status: "queued" | "started" | "unknown" | "terminal";
  outcome: string | null;
};
export type PendingChat = ChatScope & {
  version: 1;
  requestId: string;
  sessionId: string;
  status: string;
  runId?: string;
  receipt?: ChatReceipt;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function scopeKey(scope: ChatScope) {
  return JSON.stringify([scope.ownerId, scope.agentId, scope.profile]);
}
export function checkpointKey(scope: ChatScope) {
  return `headmaster-chat-pending-v1:${scopeKey(scope)}`;
}
// A projection for this browser tab, never execution authority. Only metadata
// is serialized; prompt, transcript and credentials stay out of storage.
export function savePending(storage: Storage, pending: PendingChat) {
  const { ownerId, agentId, profile, requestId, sessionId, status, runId, receipt } = pending;
  storage.setItem(
    checkpointKey(pending),
    JSON.stringify({
      version: 1,
      ownerId,
      agentId,
      profile,
      requestId,
      sessionId,
      status,
      runId,
      receipt,
    }),
  );
}
export function loadPending(storage: Storage, scope: ChatScope): PendingChat | null {
  const raw = storage.getItem(checkpointKey(scope));
  if (!raw) return null;
  const p = JSON.parse(raw);
  if (
    p?.version !== 1 ||
    scopeKey(p) !== scopeKey(scope) ||
    !uuid.test(p.requestId) ||
    typeof p.sessionId !== "string" ||
    !p.sessionId ||
    p.sessionId.length > 200 ||
    /[\x00-\x1f\x7f/\\?#]/.test(p.sessionId) ||
    typeof p.status !== "string"
  )
    throw new Error(
      "The saved request identity could not be read. Keep this tab open and contact support.",
    );
  return p;
}
export function sameReceipt(a: ChatReceipt, b: ChatReceipt) {
  return (
    a.admission_id === b.admission_id &&
    a.ref.profile_id === b.ref.profile_id &&
    a.ref.session_id === b.ref.session_id
  );
}
export function checkedRecovery(data, previous?: ChatReceipt) {
  const r = data?.receipt;
  if (
    !r ||
    !["queued", "started", "unknown", "terminal"].includes(r.status) ||
    typeof r.admission_id !== "string" ||
    typeof r.ref?.profile_id !== "string" ||
    typeof r.ref?.session_id !== "string" ||
    !Number.isSafeInteger(r.authority_epoch) ||
    !Number.isSafeInteger(r.sequence) ||
    !(
      r.execution_generation === null ||
      (Number.isSafeInteger(r.execution_generation) && r.execution_generation > 0)
    ) ||
    typeof data.runId !== "string" ||
    (previous && !sameReceipt(previous, r))
  )
    throw new Error(
      "The runtime returned a different request identity. Refresh again before continuing.",
    );
  return data;
}
export function knownRefusal(status: number, data): boolean {
  return data?.dispatched === false || [400, 401, 403, 404, 422].includes(status);
}
export function pendingLabel(status: string) {
  return status === "queued"
    ? "Request queued"
    : status === "unknown"
      ? "Request needs a decision"
      : status === "running" || status === "started"
        ? "Request still running"
        : "Request status unconfirmed";
}
