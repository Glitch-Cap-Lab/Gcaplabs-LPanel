# Headmaster compatibility notes

## Core 1.2 session authority

The operator chat preserves Core's structured 409 conflicts and 503 restart or
storage refusals, showing plain messages while retaining the input. An accepted
queued message or an execution with an uncertain outcome must not be resent
automatically; check the conversation before another attempt. Retry guidance
from Core is retained. Returned session IDs remain opaque and are echoed to the
same operator chat.

The embedded dashboard serves the Core image's own client and forwards mutation
bodies and query parameters unchanged, including the owning profile and mutation
fences. LPanel does not introduce another session store or schema migration.
Runtime replacement preserves the existing state volume. A pre-upgrade snapshot,
image canary, and rollback rehearsal remain owner release steps: reverting the
image alone does not undo Core's upgraded state or ledger delete guard.

Status: N0 source adoption in progress; no Headmaster Nora image has been released as a tagged Nora release. Production runs operator-built images described under "Production state (30 September 2026)".

## Source and runtime pins

- Nora upstream base: `40322503991fb9216d91e888a3834ea33b85d4a4` (checkout base for this fork branch).
- Existing owner-fork `master` observed on 2026-09-23: `4b49eba6080af79ea810faa7609c7bfe67381fcc`.
- Upstream `master` observed on 2026-09-23: `358b1beeaf683f76d488b113adbdfc59c52d6779`.
- Supported Hermes runtime pin: `nousresearch/hermes-agent:v2026.9.21`, version `0.21.4`, observed image digest `sha256:6bece0644e29a347e5ae17db43c36938c86f171c6f5e0cef18aa2075d331f3a3`.
- Nora fixture used the exact upstream base. Its API applied 244 upstream migrations to its disposable database. N0 adds no Nora database migration, and no production migration was applied for N0.

The four carried source changes are in `workers/provisioner/backends/docker.ts`, `workers/provisioner/backends/hermes.ts`, `workers/provisioner/healthChecks.ts`, and `workers/provisioner/worker.ts`. Focused tests are in `backend-api/__tests__/provisioning.test.ts` and `backend-api/__tests__/provisionerProviderSelection.test.ts`.

## Reviewed runtime contracts

- `NORA_AGENT_NETWORK` selects the agent network; Nora creates it if it does not yet exist. The current network behavior is preserved. A runtime's membership in the agent bridge does not make the runtime a complete security sandbox: Nora API and worker services may also be attached to that network.
- Hermes dashboard startup is supervised by the pinned image's s6 service through `HERMES_DASHBOARD=1`; the provisioner no longer starts a detached dashboard process in the container command.
- `AWS_EC2_METADATA_DISABLED=true` prevents implicit AWS instance-metadata credential discovery. Explicitly configured credentials remain supported.
- `HERMES_DISABLE_LAZY_INSTALLS=1` and `HERMES_NONINTERACTIVE=1` are set for the runtime. The pinned Hermes implementation can still install optional packages into an explicitly configured `HERMES_LAZY_INSTALL_TARGET`; the flag protects the image virtual environment, not every writable target.
- Hermes readiness uses the extended bounded retry window; OpenClaw readiness remains unchanged. At maximum configured timeout and interval values, a Hermes wait can take roughly ten minutes. The Nora job timeout must remain longer than this window.
- On successful destroy, the provisioner clears the persisted container name along with the existing cleanup state.
- Nested health errors expose error code/address/port only; they do not include credentials.

## Deployed-image comparison and provenance

Read-only inspection of the currently running Nora worker image found no OCI source-revision label and no source bind mount. Its image digest is `sha256:2a8473ce7f5d3886d9395f5b457ca2f1769dad60d2abac31be8d45b6e8b7ada1`. The Nora API image digest is `sha256:20394ce66e4e56469d5c6f36b5a50acd627c5d27d4d64365618f0a3b5981be98`; it has a read-only `/opt/nora` source mount.

The four intended provisioner source files in the running worker image were normalized and compared with the adopted local patch. Their individual SHA-256 values match:

| File | SHA-256 |
|---|---|
| `workers/provisioner/backends/docker.ts` | `f36b4d8e76dcc0162bf6d390956a91f90e1e471c6f02e7b193be1c33cd034957` |
| `workers/provisioner/backends/hermes.ts` | `072612c7789ce8939818b210bb2cd88d461f69a9c2e04cb248a03edbe1243812` |
| `workers/provisioner/healthChecks.ts` | `af3b97ab6ca6e415aa8431883b9733ad14733f81b27019c2bb5999a47ad28dae` |
| `workers/provisioner/worker.ts` | `249c601cbbca5d5bad98343d443a24b06d6f5da8d1918b65f5a2afb12c177490` |

This comparison confirms those files match, but it does not identify the complete source revision or prove the API and worker images came from one source commit. N0 acceptance still requires building both candidate images from the same committed revision, recording their image digests and OCI revision labels, then exercising the patched image in the disposable Nora environment.

## Rollback references

The production images observed on 2026-09-23, before any N0 release, are recorded in `headmaster-build-manifest.json`. No production Nora image, container, source tree, database, or runtime was changed for N0. The worker and API rollback digests are references only; no rollback action has been performed.

## Production state (30 September 2026)

- Cloud runtimes and Nora's default runtime image (`HERMES_DOCKER_IMAGE`) are `nora-headmaster-memory:1de5b492`, built from HeadmasterCore main `1de5b492c0905b7e31b20e6e8e70b1fe01da8ad5`. The Headmaster bridge's `HERMES_RUNTIME_IMAGE` must stay equal to it (the bridge fails closed otherwise).
- The worker runs `headmaster-nora/worker-provisioner:a318c1e7e6bb`, built from this repository's `a318c1e7e6bbd7d52917b9a5fedd118a5a66d9be`. The API container stays on `headmaster-nora/backend-api:1bae078ad99d`, so API and worker are not from one commit. See `headmaster-build-manifest.json`, `production_2026_09_30`.
- Fixed bug: from commit 180edd9 until `a318c1e`, the worker's agent SELECT omitted the four `headmaster_*` columns, so `headmasterEnv(agentRow)` returned nothing and new runtimes started without `HEADMASTER_OWNER_ID`, `HEADMASTER_WORKSPACE_ID`, `HEADMASTER_MEMORY_BANK_ID` and `HEADMASTER_MEMORY_GATEWAY_URL`. The memory bootstrap reads only the container's Docker environment, so those runtimes had no Hindsight memory. `HEADMASTER_AGENT_COLUMNS` in `backend-api/headmasterConfig.ts` now drives the SELECT, and `headmasterConfig.test.ts` fails if the two drift apart.
- Verified 30 September 2026 on one recreated test account: four variables present, Hindsight configured, a chat retain created the owner's bank and schema. Still outstanding: a first-time sign-up that goes through the fixed worker without a manual redeploy.

## Open evidence

### Memory gateway first-start contract (27 September 2026)

`POST /agents/deploy` accepts matching `external_identity` and
`headmaster_integration_config` together for the Headmaster runtime family.
It validates and persists both in the agent INSERT before queueing provisioning.
Partial, mismatched, or non-private gateway configuration is rejected. The worker
passes the four server-managed `HEADMASTER_*` fields to the Docker adapter, which
includes only those nonsecret fields in the container environment. Provider
credentials remain in managed secret storage. This supplies the memory bootstrap
with immutable metadata on its first start, before a later integration PATCH.

- The provenance of the original incident comments from 2026-09-19 could not be independently reproduced from the available source/log evidence; keep those claims unverified until reproduced.
- Disposable-agent provision/use/stop/restart/remove acceptance, including neighbor and volume preservation, remains outstanding.
- Candidate API/worker builds from one committed revision, OCI source-revision labels, actual candidate digests, and full manifest provenance remain outstanding.
- The worker test script now registers the repository's installed `tsx` loader, and its two worker-loader tests normalize Windows path separators before matching the worker module. This prevents the real worker from escaping the test stubs on Windows. The complete worker-provisioner suite passed in a clean Linux WSL copy on Node `v24.21.0`: 58 tests passed, followed by `npm run typecheck`. Running the complete suite directly on Windows still cannot pass its Linux process-group cases (`/bin/sh` and `/proc` are required); use the Linux CI-compatible result for the full suite.
