# Protected runtime release

`runtime-release.ts` is the maintained operator-checkout entry point for the
local Docker release controller in `workers/provisioner/protectedRuntimeRelease.ts`.
The existing deployments worker runs the same controller only for explicitly
produced `protected_release` jobs, before generic runtime replacement. Ordinary
deployment jobs retain their existing behavior.

This source slice commits **LP state only**. Its healthy result is
`external_metadata_pending`, with `external_metadata_confirmed: false` and
`publication_blocked: true`. It does not update the account service's binding or
claim successful fleet publication. A complete supported release additionally
requires owner-side preparation of the original account binding before enqueue,
authenticated fresh LP status, exact binding finalization/replay, and admission
drain. Those cross-service gates are not provided by this command yet.

## Packaging and invocation

Use an authorized operator checkout on Node 24 with the repository's unchanged
`backend-api` and `workers/provisioner` lockfile dependencies already available.
The checkout must have the existing database/Redis/Docker service configuration.
Do not put credentials in the manifest, arguments, output, or source. The commands
below describe future operator execution; source tests use synthetic adapters.

From the repository root:

```sh
node --import ./workers/provisioner/node_modules/tsx/dist/loader.mjs scripts/headmaster/runtime-release.ts --manifest /protected/release.json --dry-run
node --import ./workers/provisioner/node_modules/tsx/dist/loader.mjs scripts/headmaster/runtime-release.ts --manifest /protected/release.json --enqueue
node --import ./workers/provisioner/node_modules/tsx/dist/loader.mjs scripts/headmaster/runtime-release.ts --manifest /protected/release.json --status
node --import ./workers/provisioner/node_modules/tsx/dist/loader.mjs scripts/headmaster/runtime-release.ts --manifest /protected/release.json --recover
```

The operator script is not shipped inside the provisioner image. Both existing
worker Dockerfiles copy `workers/provisioner/`, so the controller, archive module,
state adapter, and worker branch are shipped in their actual maintained paths.
No new service, Python installation, queue, database table, or route is required.

`--dry-run` reads identities, image metadata, user ownership, install size and
capacity; it does not stop, write, queue, pull, or create. `--enqueue` captures the
existing replacement tuple under the existing per-agent advisory lock and
publishes one attempt to the existing deployments queue. Its stable job ID is
`protected-release-<release_id>`. An exact repeat returns current status rather
than applying again. `--recover` is explicit, validates owner/current identity
before enqueue, and creates a separate recovery job for the same immutable
operation. It never replays the candidate's application execution.

Roll out the protected consumer before activating this command: drain/upgrade
older deployment workers and inspect existing queued work before operator use.
Protected jobs deliberately carry `replace_existing_runtime: false`; they never
grant an old generic worker permission to destroy a retained runtime. The typed
new worker separately validates the exact prior runtime tuple. A pinned main
worker receiving such a job refuses it before destroy/create and may leave the
agent in `error`. Status reports this exact original job as
`failed_before_receipt`, with publication blocked. Explicit `--recover` checks
the immutable owner/runtime and fresh Docker state before enqueueing a recovery
that resumes the exact old runtime; it does not apply the candidate again.

Protected operations have a 15-minute total budget, shortened to leave two
minutes before the existing agent lock's hold deadline. A shorter configured
lease refuses the operation when that margin is unavailable. Docker RPCs and
exec probes have 60-second bounds; archive transfer/parsing has a 15-minute
bound also limited by the total budget. Cancellation aborts actual HTTP requests,
destroys tar/exec/upload streams, and prevents further mutations. Lock loss
aborts the operation; LP CAS and finalization use the same PostgreSQL session
that owns the agent lock. It captures the actual owned `pg.Query` and sends the
pinned client's PostgreSQL CancelRequest using that session's private PID/secret
before closing the original socket. The auxiliary cancel socket is bounded to
five seconds, uses no administrator SQL/role grant and never logs session secrets.
Socket close alone is insufficient to stop a PostgreSQL statement. Cancellation
cannot undo a statement that committed before it arrived; an uncertain result
always requires fresh inspection/recovery. Private helper stop has a separate
maximum five-second cleanup bound.
An uncertain Docker mutation or journal ACK requires fresh explicit recovery,
without automatic old start or a second candidate create.

Queue journalling and the operator command reuse the existing BullMQ backend,
queue and Lua/key contracts through operation-owned duplicate connections.
Deadline cancellation disconnects only those sockets, with reconnect/offline
queueing disabled; shared worker connections are never disconnected. Real Redis
transport behavior remains unqualified here because the local fixture environment
has no existing Redis server; no installation or shared instance was used.

## Immutable input

The closed manifest format is `headmaster-protected-runtime-release/v1`.
`release_id` is SHA-256 of the canonical JSON manifest, including every target
field. A changed target requires a different manifest and does not authorize
recovery of an earlier operation. Only one local Docker target is supported.

| Field | Required meaning |
| --- | --- |
| `sources.core`, `sources.webapp`, `sources.lpanel` | Exact 40-character source commits |
| `image.id` | Exact already-local new Docker content ID, `sha256:` plus 64 hex characters |
| `image.contract_sha256`, `image.dependency_sha256` | Expected bytes of `/opt/hermes/headmaster/contract/desktop-contract.json` and `/opt/hermes/uv.lock` |
| `image.uid`, `image.gid` | Both `10000` |
| `targets[0].agent_id`, `owner_id` | LP agent UUID and its actual LP operator/user UUID |
| `targets[0].account_id`, `workspace_id` | Distinct external Headmaster owner and workspace UUIDs |
| `container_id`, `container_name`, `image_id` | Observed old Docker content ID, exact name and old image content ID |
| `image_binding` | Expected old LP `agents.image` value; this does not prove the account service binding |
| `env_sha256` | SHA-256 of canonical sorted complete Docker `Config.Env`; no environment values are included |
| `volume`, `status` | Exact writable named data volume and expected `running` or `warning` LP status |
| `runtime` | Exact stored `container_id`, `container_name`, nullable `host`, `backend_type: docker`, `runtime_family: hermes`, `deploy_target: docker`, `execution_target_id: docker`, `sandbox_profile: standard` |
| `env_delta.set` | Empty object or only nonsecret `HERMES_BOT_DESKTOP: "0"`/`"1"` |

The persisted runtime reference can be a name; `container_id` outside `runtime`
must identify the observed Docker container. New-image source labels must match
the pinned Core and webapp commits. The LP source pin is recorded provenance;
image labels do not independently prove it.

## Safety and recovery

Preflight requires the exact LP/external ownership tuple, old image/name/agent
label/full environment hash, named writable `/opt/data` volume, actual bot
UID/GID 10000, locally present new image and source labels. Another running
writable volume user refuses the operation. Candidate configuration preserves
the old full environment plus the closed nonsecret delta, host configuration,
mounts, network identity, command, user and working directory.

The controller requests the existing Core drain as the bot user, stops the old
container, proves no writable container remains, and archives only `installs`,
optional `config.yaml`, and optional `.env`. It does not snapshot or restore the
chat database. Node/tar-stream validates complete archives before streaming them
into a root-owned `0700` operation directory on the existing volume. Traversal,
special files, dangerous modes, escaping links, hard links to non-files and
symlink ancestors are refused. Legitimate relative package links and a narrow
set of immutable-image interpreter links are preserved. Staged content is
normalized to UID/GID 10000 and reread to verify its complete inventory/hash.

The input bound is 8 GiB aggregate file content: installs may use 8 GiB minus
32 MiB, and each configuration root may use at most 16 MiB. Each root permits
at most 200,000 entries. Preflight install `du` must fit the install bound; private
worker staging needs at least twice that size plus 1 GiB free for configuration,
tar overhead and headroom. File content streams through exclusive private disk
files with backpressure, rather than whole-archive memory buffers. Transient
spool directories are removed on normal success/failure, and exact operation
spools are removed during explicit recovery after identity/no-writer proof.
The deliberate in-volume rollback archive and failed candidate tree remain.
Historical real-install evidence records 84,866 entries but no byte count;
actual payload size and disk headroom remain deployment qualification gates.

The old container is renamed and retained. A candidate is labelled with the
immutable release/LP owner, recorded before start, checked for actual bot UID and
contract/dependency hashes while stopped, then started and checked again with
existing runtime/gateway readiness before being committed
through the existing guarded LP finalizer. Only this operation's deployment ID
can be finalized or compensated; historical deployment rows remain unchanged.

On failure, the candidate stops before restoration. A one-shot filesystem
process uses the exact retained old image and its already-available Python
interpreter with `-I -S` and fixed `os.rename`/directory-`fsync` code. It has no network or
gateway, a read-only image filesystem, only the exact data volume, root UID with
only `DAC_OVERRIDE`/`FOWNER`, and no shell. This adds no Python dependency to the
Node worker. Its working directory is `/`; every inherited image environment
key is overridden, dynamic-loader/Python hooks are neutralized, image healthchecks
are disabled, and the created helper's image/environment/argv/mounts are inspected
before start. Failed installs/configuration are retained before each verified
old root is restored; old start happens only after restoration and exact LP CAS.
Partial moves, lost create/start acknowledgements and restored-name restarts
are reconciled from server-owned receipts. An unprovable restore leaves the
old runtime stopped and requires explicit recovery. Maintenance containers are
retained; cleanup requires a separate scoped owner action.
Private helper image/create/inspect/attach/start/wait calls have deadlines and
transport cancellation; uncertain wait cleanup has a separate maximum five-second
stop budget. A nonresponsive helper cannot make its cleanup wait hold the caller
indefinitely. The fixed receipt process also limits stdin waiting to 60 seconds.

## Status contract

`protectedReleaseStatus.ts:readProtectedReleaseStatus` is shared by the command
and a future authenticated read adapter. Callers must authorize the LP owner and
hold the existing agent provision lock. It accepts the server-owned original job,
not a caller-supplied receipt, and returns:

- `release_id`, immutable `manifest`, `phase`, `job_id`, `queue_state`, `receipt`;
- fresh `observed` LP agent/owner/account/workspace/container/image/status and
  separately observed retained/candidate Docker IDs, names, image IDs, running states;
- `external_metadata_confirmed: false`, `publication_blocked: true`.

Receipt phases are `validated`, `stopped`, `staged`, `old_retained`,
`candidate_created`, `candidate_healthy`, `external_metadata_pending`, `restored`,
`rolled_back`, and `recovery_required`. Status can additionally return
`not_queued`, `queued`, or `failed_before_receipt`. Queue completion alone is not
release completion. LP/external binding drift refuses status rather than blessing
a historical receipt. Volume receipts are protected from the bot UID and survive
Redis acknowledgement loss; the initial validated receipt is saved in existing
job metadata before stop. Full Redis durability and infrastructure loss are not
proved by local fixtures.

Receipt bytes are bounded to 64 KiB and sent through a helper's Docker stdin;
they are never tar-uploaded through a path beneath the bot-owned volume root.
The fixed publisher opens the volume root and operation stage with directory
file descriptors and `O_NOFOLLOW`, checks root ownership/`0700` and the existing
root-owned `0600` canonical receipt's operation ID, then creates a `0600` temporary
file with `O_EXCL` relative to the held directory. It validates input hash/identity,
fsyncs the file, atomically replaces the canonical receipt, fsyncs the stage and
its parent, and checks the named stage still has the held device/inode before ACK.
Stage creation is permitted only while the old runtime is stopped, no candidate
exists, and no writers remain. Later private metadata publication can run while
the exact candidate runs. Only exact operation temporary receipt files are cleaned.

The bot can rename a root-owned child beneath its own parent; `0700` alone does
not prevent that. Descriptor-relative writes prevent such a rename/symlink race
from redirecting a root write or exposing retained archives. Stage substitution
refuses success and may require restoring the expected directory name before
recovery. Readers use only canonical root-owned receipt JSON with the exact
operation ID, and refuse an unsafe or missing stage after any publication. Queue
receipt fallback is permitted only for initial `validated` metadata before a
retained container or candidate exists; published phases require the canonical
volume receipt. Interrupted input or a lost
publication ACK leaves the complete old or new canonical JSON. Real Docker and
host-power-loss durability still require separate qualification.

## Scoped verification

```sh
cd workers/provisioner
node --import ./node_modules/tsx/dist/loader.mjs --test protectedRelease.test.js protectedReleaseTransport.test.js deploymentLifecycle.test.js
npm run typecheck
cd ../../backend-api
npx jest __tests__/agentProvisionLock.test.ts __tests__/provisionerProviderSelection.test.ts --runInBand --forceExit
npm run typecheck
cd ..
node --test scripts/headmaster/branding.test.mjs
```

The fixtures execute the maintained command/controller/state/worker paths with
fake Docker/query adapters and real tar/filesystem archives. They include bounded
64 MiB streaming and actual child-process death after stop, stage, create,
mid-restore, old-name restoration, old start, and before/after atomic receipt
publication. Windows archive ownership is
modelled, not an actual Linux UID proof. Real Docker, image packaging, s6 init,
native/client readiness, admission drain, account binding finalization, full
fleet publication and live rollback remain separate acceptance gates.

The transport fixture additionally uses the actual pinned Dockerode/docker-modem
against a synthetic loopback HTTP server, proving stalled inspect/create/exec,
partial tar read and backpressured upload sockets close on cancellation. It opens
no Docker socket and creates no runtime. The mixed-worker check loads the whole
worker source from main commit `b022f0c66e253a4727e0944aa45504164b2eb747` under
the existing Jest service mocks; this Git object must be available locally.

For the fixed filesystem programs themselves, the optional local POSIX fixture
uses the exact exported production program strings. On Linux with local root
(only a synthetic temporary tree, no Docker/service/network):

```sh
cd workers/provisioner
node --import tsx -e 'process.stdout.write(JSON.stringify(require("./protectedReleaseDocker").maintenancePrograms))' > /tmp/headmaster-release-programs.json
python3 -I -S protectedReleasePython.fixture.py /tmp/headmaster-release-programs.json
```

It checks real root/UID10000 ownership, nofollow/hash/mode gates, Python startup
isolation, rename/fsync, process exits immediately before/after the actual replace
syscall leaving complete old/new canonical JSON, and a deterministic barrier where UID10000
renames the stage and inserts an outside symlink after the helper holds its fd.
The outside file remains unchanged, retained bytes stay unreadable to UID10000,
and the named-inode check refuses ACK. The barrier is only in the test harness;
the maintained helper exposes no test hook.
