# LPanel

LPanel is the Headmaster control plane. It provisions, monitors and operates the Cloud runtimes that run each Headmaster account's bot, and it holds the operator and admin screens for the people who run the service.

Customers never open LPanel. They use the desktop app, the web chat or the iOS app; those talk to their runtime through the admission service (in the `gcaplabs-webapp` repository), and the Headmaster site asks LPanel to create, move and delete the runtimes behind them.

LPanel is reachable only inside the Headmaster admin, at `headmaster.gcaplabs.com/admin`. It has no public address of its own.

## What it does for Headmaster

- **Runtimes.** Deploys, starts, stops, redeploys and deletes one Core runtime per account on Docker, and records each runtime's identity so the bridge and admission can find it.
- **Protected releases.** The maintained [operator release/recovery command](scripts/headmaster/README.md) retains the old local runtime and verifies scoped archives; account binding finalization and publication remain explicit separate gates.
- **Managed config.** The Headmaster bridge pushes an account's owner, workspace, memory bank and memory gateway into its runtime; see [docs/headmaster-managed-config.md](docs/headmaster-managed-config.md).
- **Embedded console.** The admin page loads LPanel's operator and admin screens in a frame with one sign-in. The frame policy, the launch exchange and session revocation are in [docs/headmaster-integration.md](docs/headmaster-integration.md).
- **Inference relay.** `services/headmaster-inference` is the provider relay behind the Lite and Pro tiers, with the monthly dollar cap per account. See its README.
- **Account deletion.** The deletion endpoints remove an account's runtime, memory bank and relay usage; the admin tab is the audit view.
- **Monitoring.** Per-runtime telemetry, logs, a terminal into the container and fleet-wide alerts.

Names: the product and every screen say LPanel or Headmaster control plane. The older name of the project this was built from survives only in internal identifiers (container, network and database names, API key prefixes, package names) and in the licence notices. Do not add it to anything a person reads.

## Layout

```
nginx
├── /           frontend-marketing   public pages and sign-in (Next.js)
├── /app        frontend-dashboard   operator workspace (Next.js)
├── /admin      admin-dashboard      platform admin (Next.js)
└── /api        backend-api          Express API
                  ├── PostgreSQL     state: users, agents, deployments, audit
                  ├── Redis + BullMQ queue for deployments, backups, alerts
                  └── workers/provisioner   Docker adapter (Kubernetes and Proxmox adapters exist, not used for Headmaster)
```

| Path | What it is |
|---|---|
| `backend-api/` | The API, persistence, auth, queue wiring, monitoring and the gateway proxy. |
| `workers/provisioner/` | The provisioning worker. Its `backends/` folder is shared with `backend-api` through a compose mount. |
| `workers/backup/` | Managed backups. |
| `agent-runtime/` | Runtime contracts shared by the API and the worker (read-only mount). |
| `frontend-dashboard/`, `admin-dashboard/`, `frontend-marketing/` | The three Next.js apps. |
| `services/headmaster-inference/` | The inference relay. |
| `cli/`, `mcp-server/` | Command-line client and MCP server for the public REST API. |
| `e2e/` | Playwright and smoke tests. |
| `infra/`, `docs/` | nginx templates, Helm chart, compose overlays; documentation sources. |

Two zones touch more than one service: `agent-runtime/` and `workers/provisioner/backends/`. Check both consumers when you edit them. [CLAUDE.md](CLAUDE.md) has the details, the compose mounts and the subtree owners.

## Run it

```sh
cp .env.example .env              # fill the required secrets; production refuses to boot without them
docker compose up -d              # full stack, nginx on :8080
docker compose logs -f backend-api
```

Tests, for exactly what you changed:

```sh
cd backend-api && npx jest path/to/file   # API
cd admin-dashboard && npm run test:helpers && npm run typecheck
node --test scripts/headmaster/branding.test.mjs   # frame policy and handshake behaviour
```

The embedded console only loads when the dashboards are built with `NEXT_PUBLIC_HEADMASTER_PARENT_ORIGIN=https://headmaster.gcaplabs.com`. That is a build argument, not a runtime variable: change it and rebuild the two dashboards.

## Working here

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the fix workflow, the brand rules and the pull request format. Rolling out a change to the servers is a production step: it needs the owner's one-line approval naming the step.

## Licence

LPanel is derived from the open-source Nora platform and stays under the Apache License 2.0. Keep [LICENSE](LICENSE) and [NOTICE](NOTICE) as they are; they carry the required attribution.
