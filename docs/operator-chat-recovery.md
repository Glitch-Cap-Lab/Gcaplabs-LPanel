# Operator chat recovery

The existing agent Chat tab records a client request UUID and session identity before sending input. A queued request, unknown execution, timeout, lost reply, or malformed success stays pending. Its visible sent turn remains in the conversation, and Send and Reset remain disabled. Refresh checks that same request; it never sends input again. A known authentication, authorization, route or validation refusal permits correction.

The checkpoint is one versioned `sessionStorage` metadata record per operator/agent/root API scope. It contains request/session IDs and, once observed, the canonical receipt and run ID. It contains no prompt, history, runtime token or API key. It survives a component remount and same-tab reload; closing the tab or clearing browser storage can lose it. Keep a pending conversation open until settled. This projection creates no server authority or new execution ledger.

Owner/agent/profile changes unmount the old conversation and abort its requests. Runtime status requests also use generations. Before applying an asynchronous chat or recovery result, the component rechecks the authenticated operator. An old account's reply cannot populate the new account's conversation. A refused POST clears its checkpoint; a later failed identity check cannot turn a successful POST into an unsent draft.

## Wire contract and activation

The UI uses only the existing unprefixed root API scope. Named profiles are rejected at this adapter; no profile is guessed from a receipt. The backend returns the operator/agent/root scope in the existing runtime-info response. Existing chat POST callers remain compatible; new operator calls additionally carry `ownerId`, `requestId`, `sessionId`, and `profile: null`. The server verifies the owner before forwarding the original request UUID as `Idempotency-Key` and session as `X-Hermes-Session-Id`.

Recovery requires the canonical Core authority producer from [Core217](https://github.com/mutvayzz-sys/gcaplabs-HeadmasterCore/pull/217) and original-key lookup from [Core223](https://github.com/mutvayzz-sys/gcaplabs-HeadmasterCore/pull/223). The locally qualified composition is `bf9808c28d971b3726a0244e1c39861ee39a4834` (`qualification/1.2-core-recovery`). Frozen upstream U0 and a legacy run-cache payload do not establish this contract. Unsupported lookup stays pending with an error; absence is never interpreted as proof that nothing executed.

- Session-authenticated `GET /api/agents/:id/hermes-ui/chat` requires existing agent editor access and remote-host authorization. It makes authenticated `GET /v1/runs/{encoded-original-request-UUID}?source=chat` with the captured session fence. It sends no GET body, Content-Length or Idempotency-Key header. Only a canonical `hermes.run` plus matching receipt is accepted. Once known, history comes from existing authenticated `/api/sessions/{canonical-session}/messages?limit=100&order=latest`. This is a recent page, not an entire transcript; compression lineage stays Core's responsibility.
- Session-authenticated `POST /api/agents/:id/hermes-ui/chat/resolve` requires the same editor/host access and explicit confirmation. It reloads the original request, matches the exact admission/profile/session/execution generation, and permits only unknown work (or an already terminal exact retry). It calls existing Core `POST /v1/runs/{fresh-server-run-id}/resolve-unknown` with exactly `{admission_id, execution_generation}`. Core's existing API stop permission remains in force. Caller-supplied run IDs are never used. Resolution acknowledgment loss is recovered through lookup, without input replay.

[LP87](https://github.com/mutvayzz-sys/Gcaplabs-LPanel/pull/87), `0cb664b4c56cd768dd352796b0d3481e535de263`, supplies the separately proposed bounded error codes for precise queued/unknown labels. This change does not duplicate its mapping. On current main's stripped errors, ambiguous requests still remain blocked as unconfirmed and canonical refresh supplies their state. Full intended status copy requires the PR87 composition. Source composition and local synthetic tests do not establish deployed runtime or authenticated production acceptance.

## Scoped qualification

Backend route fixtures in `__tests__/agents.test.ts` exercise exact header forwarding, original-key GET, canonical history, exact fenced resolution, lost resolution ACK, queued/started refusal, stale generation, malformed/legacy receipts, unavailable lookup, foreign owner/profile, confirmation and session-only authority. Run:

```text
cd backend-api
npx jest __tests__/agents.test.ts --runInBand -t "operator chat recovery HTTP|proxies Hermes chat requests" --forceExit --silent
npm run typecheck
cd ../frontend-dashboard
npx tsx --test lib/chatRecovery.test.ts
npm run typecheck
```

`backend-api/scripts/test_lpanel_chat_core_chain.py` is a pytest fixture for a disposable export of the pinned Core composition. Copy it to that export's `tests/gateway/test_t14_lpanel_chain.py`, set `T14_NODE_FIXTURE` to the absolute path of `backend-api/scripts/qualify-chat-core-chain.cjs`, and run that one pytest file. It drives the actual LP recovery adapter against actual Core HTTP handlers with a synthetic API key, authority/store and execution callback: terminal-before-ACK lookup/history, foreign session denial, stale generation, unknown resolution and complete resolve-ACK loss. No real model or resource is used.

The browser fixture imports the actual Chat component. Copy `frontend-dashboard/scripts/chat-recovery-preview.tsx.fixture` to `frontend-dashboard/pages/__chat-recovery-local.tsx` temporarily, then start `npm run dev -- --hostname 127.0.0.1 --port 3139` in the frontend directory. From the repo root:

```text
npx --yes --package @playwright/cli playwright-cli -s=lpanel-chat open http://127.0.0.1:3139/app/__chat-recovery-local
npx --yes --package @playwright/cli playwright-cli -s=lpanel-chat run-code --filename frontend-dashboard/scripts/qualify-chat-recovery.cjs
npx --yes --package @playwright/cli playwright-cli -s=lpanel-chat eval "window.__chatQualification"
```

The last result must contain all seven behavior groups. The script mocks API boundaries and uses real component interactions, checkpoint reads, confirmation, reloads and delayed replies. Screenshots go to a sibling `evidence/lpanel-chat-recovery` directory (create it first). Remove the temporary page and stop the local server/browser afterward; do not ship the fixture page. Next's development HMR warning is separate from product behavior.
