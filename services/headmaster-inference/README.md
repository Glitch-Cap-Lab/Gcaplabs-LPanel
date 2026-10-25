# Headmaster managed inference relay (S1)

This is a provider relay, not an agent runtime. It accepts only the private
Headmaster assertion contract, the OpenAI-compatible `GET /v1/models` and
`POST /v1/chat/completions` operations, and the own-key realtime voice token
route `POST /v1/realtime/session` (see "Realtime voice sessions" below). It never receives a prompt from Nora's
cloud Hermes runtime and never runs tools. The container has no Docker socket,
Docker CLI, runtime API, or agent execution dependencies. Build it with the Nora
repository root as context:

```sh
docker build -f services/headmaster-inference/Dockerfile -t headmaster-inference:<commit> .
```

Run it only on a private service network shared with admission. Do not publish
port 8781 to the host or internet. Give its DB role `SELECT` only on the
existing `llm_providers` rows/columns required by the resolver and its Redis
ACL only on the `headmaster-inference:*` key prefix. It requires the existing
Nora `ENCRYPTION_KEY` to decrypt provider rows; it creates no provider table,
vault, or credential catalog.

## Tests and CI

Use Node 24 from the repository's `.nvmrc`, then run from this directory:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

`.github/workflows/inference-relay.yml` runs this deterministic suite for each
relevant ready PR head, including pushes after a label was already applied.
Changes to the relay, its copied backend/shared modules, Node version, or workflow
start the check. Draft PRs wait until ready; manual dispatch remains available.
CI leaves provider credentials and Redis unset and disables the live probe flag.
Real provider and Redis probes remain separately opt-in. This package has no
standalone typecheck script or TypeScript project; backend/provisioner typechecks
remain in the Backend workflow.

## Trusted mapping and secrets

Assignments are resolved at request time from Headmaster's Supabase project;
the relay holds no assignment copy and no provider secret.
`public.headmaster_inference_assignments` (migration
`20260924110000_headmaster_inference_assignments`) maps an owner
(`auth.users.id`) to a Nora user UUID and an existing `llm_providers` row UUID,
plus `enabled` and a monotonic `revision`. The table is reference-only: it
stores identifiers, never secrets. Provider keys stay encrypted in Nora
(`ENCRYPTION_KEY`) and are decrypted only by `resolveInferenceProvider` for the
referenced row; the relay does not scan users or enumerate provider keys.

`HEADMASTER_INFERENCE_ASSIGNMENT_SOURCE` selects the assignment source:

- `auto` (default): Supabase when both `HEADMASTER_INFERENCE_SUPABASE_URL` and
  `HEADMASTER_INFERENCE_SUPABASE_SERVICE_ROLE_KEY` are set, otherwise the
  legacy env map.
- `supabase`: durable Supabase assignments only; required before removing the
  env map.
- `env`: the LEGACY `HEADMASTER_INFERENCE_ACCOUNT_MAP` compatibility mode; an
  explicit selection logs a LEGACY-mode warning at startup.

Required private settings:

- `HEADMASTER_INFERENCE_ASSERTION_SECRET`: at least 32 random bytes, shared
  only with admission.
- Existing Nora Postgres connection settings plus `ENCRYPTION_KEY`; use a
  dedicated read-only DB principal, not the backend operator's write role.
- Existing Redis connection settings; use a dedicated ACL/user restricted to
  this service's key prefix.
- `HEADMASTER_INFERENCE_SUPABASE_URL`: the Headmaster project origin
  (`https://<ref>.supabase.co`; no credentials, path, or query).
- `HEADMASTER_INFERENCE_SUPABASE_SERVICE_ROLE_KEY`: server-only credential used
  for the single-row assignment read (and, by the migration script only, the
  admin RPC). Never ship it to clients.
- `HEADMASTER_INFERENCE_ASSIGNMENT_TTL_MS`: optional assignment cache lifetime
  in milliseconds, default 30000, clamped to 1000..300000.

Default assignment (Lite/Pro for every approved account): set both
`HEADMASTER_INFERENCE_DEFAULT_NORA_USER_ID` (the operator's Nora user UUID) and
`HEADMASTER_INFERENCE_DEFAULT_PROVIDER_ID` (the `llm_providers` row UUID that
backs the tiers), or neither. When set, an owner with no assignment row resolves
to that pair, so a newly approved account can chat on the Headmaster tiers with no
admin step. Admission signs a relay assertion only for an approved account, so
this does not open the relay to anyone else. A row still wins over the default, an
explicitly disabled row (`enabled = false`) still denies, and a lookup failure never
falls back to the default. An owner served by the default may use the `headmaster-lite` and `headmaster-pro` tiers (Lite stays the default selection; other model ids get 400); a row of their own unlocks the rest. Each use is logged as `default assignment used` with the owner id and a running count, nothing else. Admission checks entitlement and the runtime before it signs anything, so a revoked account or runtime is refused even with no row (covered by a webapp admission test). Leaving both unset keeps the old rule that absence of a
row denies.

TTL and revocation semantics:

- The relay caches the last successful assignment read per owner for at most
  the TTL (default 30 seconds), so replacement, revocation
  (`enabled = false`), and reapproval take effect within that bounded window.
  An entry is never served beyond its TTL and a failed lookup is never cached.
- A revoked assignment is logged distinctly server-side
  (`headmaster-inference assignment revoked`) so an operator can tell a
  disabled owner apart from one who never had an assignment.
- Absence of a row denies access (`provider_mapping_unavailable`); assignment
  rows are never auto-created per auth user (unless the default assignment above is configured, which applies to a missing row without creating one). Any lookup failure (network,
  non-2xx, malformed or duplicate rows, timeout) also denies — no stale or
  negative fallback is served.
- The lookup deadline (`HEADMASTER_INFERENCE_ASSIGNMENT_TIMEOUT_MS`, default
  10s) stays active through response body consumption, not just until headers
  arrive — a connection that stalls mid-body fails closed within the deadline
  instead of hanging. The body is also read through a capped streaming reader
  (64 KiB) rather than buffered unconditionally, so an oversized or runaway
  response body cannot be used to exhaust relay memory.
- The Supabase tables are read-only to `service_role`; every mutation goes
  through the admin-gated, revision-fenced
  `headmaster_admin_set_inference_assignment` RPC, which appends an audit row to
  `headmaster_inference_assignment_events` and returns `created` / `changed` /
  `unchanged` / `revision_conflict` / `actor_not_admin` / `owner_not_found`.

Least access: use a dedicated Supabase credential for the relay where the
project supports one, keep it in the relay's secret store rather than in image
config, and treat it as read-only in operational practice — the relay itself
only ever issues one bounded `SELECT` (at most two rows, to detect an ambiguous
row) and never writes. Rotate the credential if the relay host is compromised.

Legacy env map: `HEADMASTER_INFERENCE_ACCOUNT_MAP` is a server-only JSON object
keyed by the Headmaster Supabase owner UUID. Each value is `{ "noraUserId":
"<Nora UUID>", "providerId": "<existing llm_providers UUID>", "provider":
"openai" }`, with an optional narrower `models` array. This bootstrap policy is
never accepted from a request and is only consulted when the assignment source
is `env`. Accounts without a mapping fail closed with
`provider_mapping_unavailable`.

### Migrating from the env map

1. Apply `20260924110000_headmaster_inference_assignments` in Headmaster
   Supabase.
2. While the running relay still reads `HEADMASTER_INFERENCE_ACCOUNT_MAP`, run
   `node services/headmaster-inference/scripts/migrate-account-map.mjs --actor
   <admin-auth-users-uuid>` with `HEADMASTER_INFERENCE_SUPABASE_URL` and
   `HEADMASTER_INFERENCE_SUPABASE_SERVICE_ROLE_KEY` set (or pass `--map-file`).
   The script validates the map, writes revision-fenced rows with
   `change_source='env_map_migration'`, and is idempotent: already-migrated
   accounts report `unchanged` without a revision bump. `--dry-run` prints the
   planned writes.
3. Deploy the relay with `HEADMASTER_INFERENCE_ASSIGNMENT_SOURCE=supabase` (or
   `auto`) and verify that a migrated account succeeds while an account without
   a row is denied with `provider_mapping_unavailable`.
4. Remove `HEADMASTER_INFERENCE_ACCOUNT_MAP` from the relay environment.

### Rollback

- Redeploy the previous relay image, or set
  `HEADMASTER_INFERENCE_ASSIGNMENT_SOURCE=env` and restore
  `HEADMASTER_INFERENCE_ACCOUNT_MAP`. Migrated rows stay inert until a Supabase
  source is used again; no rollback migration is required.
- To cut an account off immediately, disable or replace its assignment through
  the admin RPC (audited); the relay honors it within the bounded TTL window.

The assertion is `base64url(JSON claims).base64url(HMAC-SHA256(encoded claims))`.
Claims are version 1 with `aud=headmaster-inference`, `sub=<Headmaster owner
UUID>`, decimal `authorization_revision`, uppercase HTTP method, exact path,
SHA-256 body digest, request UUID, random nonce, `iat`, and `exp` (20 seconds).
The relay validates all claims and consumes each nonce once. Admission strips
caller-supplied identity/assertion headers and signs only after authenticating
the bearer token and checking current account entitlement.

## Personal provider keys (byo)

A user can store their own key for one of the relay's fixed-endpoint providers
(openai, groq, mistral, deepseek, xai, moonshot, zai, nvidia, openrouter, plus
anthropic and gemini, which are personal-key only and have no operator
coverage). The list is `PROVIDER_ENDPOINTS` in `policy.mjs`.
Admission stores it AES-256-GCM encrypted in
`public.headmaster_user_provider_keys` and forwards use through this relay with
the same signed assertion plus an extra claim `byo_provider: <provider>`.

- `HEADMASTER_PROVIDER_KEY_SECRET`: at least 32 bytes, the same value admission
  encrypts with (`provider-key-crypto.mjs` is a byte-identical copy). If unset
  or too short the relay still boots and the operator path is unaffected, but
  every byo request answers `503 own_key_unavailable`. It uses the same
  `HEADMASTER_INFERENCE_SUPABASE_URL` / `_SERVICE_ROLE_KEY` as assignments (the
  key table grants `service_role` only).
- A verified `byo_provider` claim skips the assignment lookup and operator
  provider row entirely. An unknown provider is `400 byo_provider_invalid`; a
  missing key row is `404 provider_key_missing`; lookup or decrypt problems are
  `503 own_key_unavailable`. A byo request never falls back to an operator key.
- The ciphertext row is read with a bounded, deadline-limited single-row
  select and cached for at most 30 s (misses and failures are never cached), so
  a deleted or replaced key stops working within 30 s.
- `GET /v1/models` fetches the provider's `/models` with the user's key and
  returns at most 500 OpenAI-format ids. `POST /v1/chat/completions` goes to the
  provider's fixed allowlisted endpoint (never a client URL) with any model id
  matching `^[A-Za-z0-9._:/@+-]{1,128}$` (the tested-model catalogue does not
  apply); token caps, body size, response size, streaming and timeouts are the
  operator path's.
- Provider 401/403 becomes `400 own_key_rejected`; other provider errors use the
  same sanitized mapping as the operator path. Provider error bodies are never
  relayed.
- Limits are separate from the operator budgets (distinct Redis prefix
  `headmaster-inference-byo`, no token accounting):
  `HEADMASTER_INFERENCE_BYO_MAX_CONCURRENT` (default 3) and
  `HEADMASTER_INFERENCE_BYO_REQUESTS_PER_HOUR` (default 600).
- Never logged: the key, the ciphertext, the service credential, request or
  response bodies. Logs carry request id, provider, model id and error codes
  only.

## Realtime voice sessions (own keys)

`POST /v1/realtime/session` (`realtime.mjs`) mints a short-lived voice session
token from the user's own stored key. The relay does not proxy the realtime
WebSocket; it returns only the provider's ephemeral token, and the raw key never
leaves the relay.

- Own keys only: the assertion must carry `byo_provider`. Without it the answer
  is `400 realtime_requires_own_key`. Supported providers are `openai`, `xai`
  and `gemini`; any other is `400 realtime_provider_unsupported`.
- The body may contain only `model` and `ttl_seconds`; any other field is
  `400 realtime_field_forbidden`. The lifetime is clamped to 10 to 600 seconds
  (default 600), and the response reports `ttl_seconds` and `ttl_clamped`.
- Each mint takes one slot of the own-key hourly request budget, like own-key
  chat. Personal keys do not count against the Headmaster monthly cap.
- A provider token whose expiry is later than requested is refused
  (`502 provider_token_ttl_invalid`). Logs carry owner id and provider only.

## Model names

Clients may name a Headmaster tier (`headmaster-lite`, `headmaster-pro`; Max was
removed). The relay maps each tier to a backend model from config:

- `HEADMASTER_INFERENCE_TIER_LITE_MODEL`, default `deepseek/deepseek-v4.1-flash`
  (DeepSeek V4.1 Flash on OpenRouter).
- `HEADMASTER_INFERENCE_TIER_PRO_MODEL`, default `xiaomi/mimo-v2.6-pro`
  (MiMo V2.6 Pro on OpenRouter).

A tier resolves to its mapped model only when the account is allowed it;
otherwise it falls back to the account's first allowed model, so a tier never
widens the allowlist and an account with no allowed model gets
`model_not_allowed`. `GET /v1/models` reports the resolution per account in
`headmaster_tiers`. The tier list lives in `policy.mjs`,
`agent-runtime/lib/headmasterInference.ts` and the desktop's
`headmaster-trial-provider.ts`; keep them equal.

Monthly allowance: `HEADMASTER_INFERENCE_USD_PER_MONTH` (default 2.00) caps
spend per account per UTC calendar month on the operator-funded path. Each
response is charged OpenRouter's reported `usage.cost`; when a response has no
cost, tokens x the price in `HEADMASTER_INFERENCE_PRICES_JSON`
(`{"<model>":{"prompt":<USD per 1M>,"completion":<USD per 1M>}}`, defaulting to
OpenRouter's published prices for the Lite and Pro models). A model with no
entry in that table is refused before any provider call (503
`model_price_unknown`), so nothing is charged $0. At admission the relay
reserves an estimated cost (request bytes / 4 as prompt tokens plus the full
output reservation, at the table price) against the month; settlement releases
the reservation and adds the actual cost. Concurrent requests therefore cannot
together pass the cap. Past it the relay answers 429 `monthly_budget_exceeded`
("You have used this month's Headmaster allowance. It resets on the 1st of next
month (UTC)."). Personal-key traffic is not counted.

## Wallet billing

The wallet is always on: the relay charges every managed request to the paying
organization's wallet (Headmaster Supabase, site migration
`20261023090000_headmaster_wallets.sql`). `HEADMASTER_INFERENCE_WALLET`, if set,
must be `on`; `off` and `shadow` are gone. An empty wallet answers 402
`insufficient_credit`, a switched-off organization 403 `organization_suspended`,
an unreachable wallet 503 `quota_unavailable`. A personal wallet is topped up to
`HEADMASTER_INFERENCE_USD_PER_MONTH` once per UTC month, so the free allowance
stays $2. Per-account concurrency, hourly request and daily token limits still
apply from Redis.

Both markups are required and the relay refuses to start without them (no at-cost
default; values below `10000` or above `100000` are refused too):

- `HEADMASTER_INFERENCE_WALLET_MARKUP_BPS=12500` multiplies the provider cost of
  the Headmaster tiers (Lite and Pro) before it is held and charged: cost plus 25%.
- `HEADMASTER_INFERENCE_WALLET_OTHER_MARKUP_BPS=11000` does the same for every other
  model and the speech-to-text route: cost plus 10%.

The wallet uses the same `HEADMASTER_INFERENCE_SUPABASE_URL` and service-role key
as the assignments; startup fails without them. Personal-key traffic is never
charged.

## Speech (managed STT and TTS)

Cloud runtimes use their stock `stt.openai` and `tts.openai` providers pointed at the account
inference host. Admission forwards `POST /v1/audio/transcriptions` and `POST /v1/audio/speech` here
under the same signed assertion as chat; personal-key (byo) assertions are refused on both.

- Transcription (`transcription.mjs`): `HEADMASTER_STT_API_KEY` turns it on; `HEADMASTER_STT_BASE_URL`
  (default Groq), `HEADMASTER_STT_MODEL`, `HEADMASTER_STT_USD_PER_HOUR`. Held from the upload size,
  settled on the measured audio seconds.
  Munsit: with `HEADMASTER_MUNSIT_API_KEY` set, a request whose `model` is `munsit` (the runtime's
  own `stt.openai.model`, so the person picks the engine the upstream way) goes to Munsit
  (`HEADMASTER_MUNSIT_BASE_URL`, default `https://api.munsit.com/api/v1`, `x-api-key` auth,
  `HEADMASTER_MUNSIT_MODEL`, `HEADMASTER_MUNSIT_USD_PER_HOUR`, default 0). Any other model goes to
  the default engine. `HEADMASTER_MUNSIT_LANGUAGES` (comma list, empty by default) can also send
  chosen languages there; a language never limits the engine a person picks.
- Speech (`speech.mjs`): `HEADMASTER_TTS_BASE_URL` turns it on, for example the private Kokoro
  container at `http://headmaster-kokoro:8880/v1`. Plain http is accepted only for a compose service
  name or a private address. `HEADMASTER_TTS_MODEL` (default `kokoro`), `HEADMASTER_TTS_VOICE`
  (default `af_heart`, used when the request names no valid voice), `HEADMASTER_TTS_API_KEY` for a
  hosted server, `HEADMASTER_TTS_USD_PER_MILLION_CHARS` (default 0: no wallet hold). Only the text,
  voice, format and speed reach the server; the model is always the operator's. Any voice the
  server knows passes through, so every Kokoro voice (all its languages) is selectable.
  Munsit (Arabic): with `HEADMASTER_MUNSIT_API_KEY` set (the dictation key; `HEADMASTER_MUNSIT_BASE_URL`
  is shared too), a request whose `model` is `munsit` (the runtime's own `tts.openai.model`) goes to
  Munsit's `/text-to-speech/{model}` with the voice as its `voice_id`. Settings: `HEADMASTER_MUNSIT_TTS_MODEL`
  (default `faseeh-v1-preview`), `HEADMASTER_MUNSIT_TTS_VOICE` (default `ar-najdi-male-2`, used when the
  request names no valid voice), `HEADMASTER_MUNSIT_TTS_STABILITY` (0 to 1, default 0.5) and
  `HEADMASTER_MUNSIT_TTS_USD_PER_MILLION_CHARS` (default 0: no wallet hold). Munsit answers WAV whatever
  format the runtime asked for, and speed is held to its 0.7 to 1.2 range. The route exists when either engine is
  configured; without the speech server, any other model is refused.

Both are charged at the other-model markup when priced.

## Limits and behavior

- Only allowlisted provider/model pairs are returned. The allowed models are
  intersected with Nora's existing provider metadata and optional per-account
  policy list. Unimplemented provider protocols fail closed.
- Model requests are sent directly to their fixed HTTPS provider endpoint;
  client-selected provider IDs, endpoint URLs, redirects, and custom hosts are
  not accepted. Provider keys are sent only as upstream bearer auth.
- Messages, multimodal payloads, tool declarations/calls, reasoning parameters,
  stream usage options, and other OpenAI-compatible request fields are relayed
  without tool execution. No fallback model or retry is performed.
- Provider SSE bytes are streamed without buffering; disconnect/timeout aborts
  the upstream request. Both admission and relay bound incoming header/body
  receipt to 120 seconds. Request bodies are capped at 36 MiB, provider responses
  at 32 MiB, completion output at 4096 tokens by default, and request time at
  120 seconds by default.
- Redis enforces per-account in-flight requests, hourly request count, and a
  daily completion-token budget using reservations. Provider usage is recorded
  as token counts only; prompts and completions are not logged. When a provider
  omits usage, the reserved output limit is charged conservatively.
- The **code default** for the hourly request budget
  (`HEADMASTER_INFERENCE_REQUESTS_PER_HOUR`, `server.ts`) is **120 requests/hour**
  per account. The **production value** is set separately in the deployed
  `inference.env` file on the relay host and may differ from the code default;
  read it from the running container by variable name only (never print the
  full env dump), e.g. `docker inspect headmaster-inference --format
  '{{range .Config.Env}}{{println .}}{{end}}' | grep REQUESTS_PER_HOUR`.
- A quota-exhausted request fails with HTTP 429 and a stable `error.code`:
  `request_budget_exceeded` (hourly request count) or
  `completion_budget_exceeded` (daily completion-token budget). These are the
  exact names the Headmaster desktop client's trial-limit banner matches on;
  a test in `lib.test.mjs` pins them.
- Provider failures are mapped to stable safe error codes; provider response
  bodies are not returned on errors. Client cancellation is not retried.

Initial protocol coverage is limited to the current Nora OpenAI-compatible
catalog entries for OpenAI, Groq, Mistral, DeepSeek, xAI, Moonshot, Z.AI, and
NVIDIA, later extended with OpenRouter. On the operator-funded path, Anthropic,
Gemini, Cohere, custom URLs, Microsoft Foundry, Ollama, OAuth-only providers,
and the Nora demo stub are intentionally unavailable until individually adapted
and tested. Anthropic and Gemini are available for personal keys only (see
"Personal provider keys"). This does not claim the pinned Hermes
0.21.4 desktop client is integrated; that requires the D4 loopback adapter.

## B2-A integration required before deployment

Status: historical gate. The relay is in production (on 19 October 2026 it
runs `headmaster-inference:b022f0c`). The checklist below records the
conditions set before first deployment; it is not a statement of current gaps.

Admission must use Supabase Auth to resolve the bearer token to `auth.users.id`,
then read `headmaster_account_entitlements(owner_id, entitlement,
authorization_revision)` on every new request. Only `entitlement='approved'`
passes. Missing revision, DB/network failure, or an absent row fails closed.
During a stream admission rechecks that authority at most every 30 seconds and
cancels the relay when entitlement or revision changes. The account identity is
independent of workspace/runtime readiness, so Work inference remains available
when Nora's customer agent is stopped.

B2-A has not landed in the companion site/admission integration at this commit.
The current draft table has only `owner_id`, `entitlement`, and `updated_at`;
its read-only entitlement route and `authorization_revision` migration are still
required. The fixed public admission origin also must be provisioned and returned
by account capabilities/status. Do not deploy this service until those contracts,
the assignment migration above is applied, secret distribution, Redis/DB ACLs,
and TLS/private routing are in place.
