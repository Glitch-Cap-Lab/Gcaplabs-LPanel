# Headmaster managed configuration

The bridge adopts an agent's immutable external identity before configuring its
owner, workspace, memory bank and memory gateway. The agent must use the
Headmaster runtime family. These routes inherit agent/workspace authorization;
GET needs viewer access and mutations need editor access.

- `GET /api/agents/:id/managed-config` returns `integration_key_names`,
  `desired_revision`, `applied_revision`, and `deployment_status`. No values or
  runtime credentials are returned.
- `PATCH /api/agents/:id/integrations/headmaster` accepts `expected_revision`,
  `owner_uuid`, `workspace_uuid`, `memory_bank_id`, and `memory_gateway_url`.
  Identity must match the adopted binding. The bank is `hermes-u-` followed by
  the owner UUID with underscores replacing hyphens. Gateway URLs must use HTTP
  or HTTPS and contain no credentials, query or fragment.
- `POST /api/agents/:id/managed-config/retry` reapplies saved desired state without
  increasing its revision. An unconfigured agent returns 400.

Changed stale requests return 409. An identical already-applied PATCH is a true
no-op, even when it carries the earlier revision. Duplicate retries are also
no-ops once applied. The existing account provider lock serializes persistence,
full environment reconciliation, restart, readiness, and revision acknowledgement.

The four values are appended to the existing full environment aggregator, after
generic integrations, channels and providers. Generic integrations cannot inject
reserved Headmaster values. Persistence read errors fail closed. The managed
name allowlist includes the four names for this runtime family, including the
Kubernetes reconciliation path. Other runtime families retain their existing
allowlist.

Application failure returns HTTP 200 with `deployment_status: "failed"` and an
unacknowledged desired revision. A successful call must return an explicit
non-staged sync result after readiness; an empty, skipped, failed or merely staged
result is not success. If auth reconciliation quarantined and stopped the runtime,
retry uses the existing safe offline-stage/start/readiness lifecycle. An agent
stopped by its user is not automatically started. `pending` is retryable after an
interrupted API process, so it cannot strand the bridge in an in-progress state.

## Model provider: the Headmaster relay, never operator keys

A Headmaster-managed Hermes agent (external namespace `headmaster`) gets one
built-in model provider named `headmaster`, with two fixed tiers: Lite and Pro
(`headmaster-lite`, `headmaster-pro`; default Lite). It
registers as a `providers.headmaster` entry with `discover_models: false`, so a
fresh Cloud model picker shows exactly those two rows.

- Nora never copies operator provider keys, provider base-url overrides or a
  persisted `NORA_HERMES_MODEL_CONFIG_B64` into these containers. Both
  pipelines (`authSync.ts` and the provisioner `worker.ts`) build the model
  block from `agent-runtime/lib/headmasterInference.ts` for managed agents and
  ignore operator and persisted config.
- The container gets `HEADMASTER_INFERENCE_KEY`, an HMAC-SHA256 of its own
  `API_SERVER_KEY` (label `headmaster-inference-v1`), and
  `HEADMASTER_INFERENCE_BASE_URL` (default `https://inference.gcaplabs.com/v1`,
  https only). `config.yaml` refers to the key as `${HEADMASTER_INFERENCE_KEY}`.
- Admission recognizes that key on the account inference host, resolves it to the
  owner with `POST /api/integrations/headmaster/runtime-identity` and
  `runtime_key_kind: "inference"`, checks entitlement, and signs the relay
  assertion. The relay maps a tier id to the account's assigned model and holds
  the only operator key.
- The adopt route stamps the managed model block onto a Hermes runtime. A model
  the user picks from another provider persists until the next resync; keeping it
  across resyncs belongs to the own-keys step.

## Validation and deployment

Run the backend typecheck and the `headmasterConfig`, `authSync`, `agents`,
`hermesUi`, `headmasterRuntimeIdentity`, `llmProviders` and `openapi` Jest suites on Linux Node 24. The auth-sync suite
executes `/bin/sh` and therefore needs Linux.

`backend-api/scripts/headmaster-managed-config-live.ts` is a fixture-only harness.
It requires `DB_NAME=hm_managed_config_test`, a fresh disposable PostgreSQL
database, a disposable Redis service, `NORA_AGENT_NETWORK=hm-managed-config-test`,
Docker access, and `HEADMASTER_TEST_IMAGE` pointing at a cached real runtime image.
Use an isolated Docker daemon; do not give it production database credentials.
It generates synthetic credentials in memory, makes no inference calls, applies
and replays migrations, then exercises the authenticated routes, actual restart,
process environment preservation, no-op replay, provider rotation, and recovery
from a stopped auth-quarantined state. Process environment is inspected as the
runtime service user because Docker root without ptrace capability cannot read
that user's `/proc/*/environ`. Only assertions/pass markers are printed. Runtime
containers are stopped and retained, never deleted.

The seven new columns use append-only startup migrations, mirrored in
`db_schema.sql`. Release only from a merged commit after live fixture validation.
Production migration and Nora deployment require separate owner approval; an
a merge to `main` does not authorize deployment. Kubernetes live acceptance requires a
Kubernetes fixture and remains distinct from unit coverage of its allowlist.

## Persistent data-storage allocation

`HEADMASTER_STORAGE_ALLOCATION_BYTES` is a **New**, nonsecret reserved input in
this existing managed environment family. It transports the canonical
`agents.disk_gb * 1024**3` allocation to `headmaster.storage.allocation_bytes`
in UTF-8 `/opt/data/config.yaml`. The previous upstream filesystem sample
reports shared host capacity on ordinary Docker volumes; it cannot describe
the bot's own allocated budget.

Only positive safe integer GiB values from the selected control-plane row are
accepted; the resulting byte count must also be a safe integer. Adoption uses
its existing immutable-identity `RETURNING *` row, not request storage fields.
Creation and full managed environment reconciliation reserve and overwrite or
clear the bootstrap input. A missing/invalid stored value removes stale YAML
allocation metadata; it does not retain an imported/customer allocation.
Bootstrap and adoption preserve other configuration and never stamp a selected
profile's separate allocation. No new database column, route or store is added.

This is an allocated **persistent data-storage budget**, not an enforced Docker
quota. The existing Hermes volume `nora_hermes_home_<agentId>` mounts at
`/opt/data`: it includes workspace, all profiles, and persistent HOME data,
downloads and user caches below that mount. It excludes `/tmp`, `/dev/shm`, the
image and any writable container layer outside the mount. Core must report an
unknown budget when metadata or a complete measurement is unavailable, with no
host filesystem fallback. This change does not enable automatic chat deletion.

The Cloud image's matching `050-headmaster-storage-budget` hook is in the webapp
runtime recipe. Both writers accept the same integer contract; an old runtime
must receive the updated image/bootstrap or the existing adoption stamp before
its budget can be reported. No live backfill is performed by this change.
