import assert from "node:assert/strict";
import test from "node:test";
import {
  checkpointKey,
  checkedRecovery,
  knownRefusal,
  loadPending,
  pendingLabel,
  savePending,
} from "./chatRecovery";
const scope = { ownerId: "owner-a", agentId: "agent-a", profile: null };
const pending = {
  ...scope,
  version: 1 as const,
  requestId: "c7427a31-cef5-4d6c-8041-6f943733a91e",
  sessionId: "9e563d2c-0ff7-486d-aa77-cb9e24bb8b2d",
  status: "unconfirmed",
};
function storage() {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  } satisfies Storage;
}
test("checkpoint survives remount with exact identity and excludes prompt, transcript and token", () => {
  const s = storage();
  savePending(s, {
    ...pending,
    prompt: "private",
    messages: ["private"],
    token: "secret",
  } as never);
  assert.deepEqual(loadPending(s, scope), pending);
  assert.doesNotMatch(s.getItem(checkpointKey(scope)), /private|secret|prompt|messages|token/);
  assert.equal(loadPending(s, { ...scope, ownerId: "owner-b" }), null);
  assert.equal(loadPending(s, { ...scope, agentId: "agent-b" }), null);
});
test("corrupt or foreign checkpoint does not unlock sending", () => {
  const s = storage();
  s.setItem(checkpointKey(scope), JSON.stringify({ ...pending, ownerId: "foreign" }));
  assert.throws(() => loadPending(s, scope));
  s.setItem(checkpointKey(scope), "{");
  assert.throws(() => loadPending(s, scope));
});
test("only known refusals permit draft correction", () => {
  for (const status of [400, 401, 403, 404, 422]) assert.equal(knownRefusal(status, {}), true);
  for (const status of [0, 409, 500, 502, 503, 504]) assert.equal(knownRefusal(status, {}), false);
  assert.equal(pendingLabel("queued"), "Request queued");
  assert.equal(pendingLabel("unknown"), "Request needs a decision");
});
test("receipt identity cannot switch admission, session or profile on refresh", () => {
  const receipt = {
    admission_id: "admission",
    ref: { profile_id: "root", session_id: "session" },
    sequence: 1,
    authority_epoch: 2,
    execution_generation: 3,
    status: "unknown" as const,
    outcome: null,
  };
  assert.equal(checkedRecovery({ runId: "run", receipt }, receipt).receipt, receipt);
  for (const changed of [
    { ...receipt, admission_id: "foreign" },
    { ...receipt, ref: { ...receipt.ref, profile_id: "foreign" } },
    { ...receipt, ref: { ...receipt.ref, session_id: "foreign" } },
  ])
    assert.throws(() => checkedRecovery({ runId: "run", receipt: changed }, receipt));
  assert.throws(() => checkedRecovery({ runId: "legacy" }));
});
