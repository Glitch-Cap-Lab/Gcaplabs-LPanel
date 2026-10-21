# Headmaster admin integration (Nora-rebranding)

This integration lets the signed-in Headmaster **Admin Panel** embed Nora's real
operator (`/app`) and platform-admin (`/admin`) surfaces inside one
Headmaster-hosted workspace, with a single sign-in and no routine second
login. Native Nora login remains fully functional as the protected
break-glass operator path during canary validation.

Status by layer:

| Layer | Status |
| --- | --- |
| Olive/lime theme, rebranded shells, preserved nav/attribution | implemented |
| App-owned frame policy (build-time parent origin) | implemented |
| Presentation/readiness bridge (origin+nonce checked) | implemented |
| Launch-code SSO exchange (S2S issue → browser redeem) | implemented |
| Session tracking, revocation, WS termination (≤30 s bound) | implemented |
| Live end-to-end verification against the canary | pending deployment |

## Frame policy

The dashboards own their embedding policy. `frontend-dashboard` and
`admin-dashboard` read `NEXT_PUBLIC_HEADMASTER_PARENT_ORIGIN` at **build
time** (Docker `ARG` → `ENV` → inlined into the Next.js build and
`next.config.ts` headers). With a valid exact HTTPS origin, every dashboard
response carries `Content-Security-Policy: frame-ancestors 'self' <origin>`,
which supersedes the reverse proxy's `X-Frame-Options: SAMEORIGIN` in modern
browsers. Without the variable, nothing is emitted and dashboards stay
same-origin-only. No nginx, Compose, or tunnel configuration changes are
required, and no wildcard or multi-origin embedding is possible.

## Launch exchange

1. The Headmaster page asks the embedded shell for a browser-binding nonce.
   The shell plants an HttpOnly, Secure, `SameSite=None; Partitioned` cookie
   (`hm_launch_browser`) via `POST /auth/headmaster/initiate` and returns the
   nonce over the origin-checked bridge.
2. The page posts the nonce to the Headmaster server
   (`POST /api/admin/nora/launch`), which freshly re-verifies the GCAP
   session, admin role, and suspension state, then issues a **single-use,
   ~60 s, origin- and audience-bound launch code** over an authenticated
   server-to-server call to Nora
   (`POST /api/internal/headmaster/launch-codes`, Bearer
   `HEADMASTER_S2S_TOKEN`). The code is stored atomically (`SET NX`, hashed)
   in Nora's Redis with the SHA-256 of the browser nonce.
3. The page hands the code to the shell, which redeems it
   (`POST /auth/headmaster/redeem`) with its binding cookie. Nora validates
   audience/origin, single use (`GETDEL`), browser binding, the **explicit**
   `headmaster_admin_links` row (GCAP account id → existing Nora admin;
   never the first admin, email alone, or metadata), and the linked user's
   current `admin` role — then issues a normal Nora session JWT flagged
   `hm: 1` and sets the native `nora_auth` cookie.

No service-role key, Nora API key, owner JWT, or long-lived session secret
ever reaches the browser, a URL, localStorage, or a postMessage payload. The
existing hello/status bridge messages remain presentation-only.

## Session lifecycle and revocation

Headmaster-launched sessions are tracked in Redis (`hm:sess:*`) and checked
on every authenticated request (`middleware/auth`); Redis outages fail
closed. Revocation paths:

- **GCAP logout / account switch** — the site calls
  `POST /api/internal/headmaster/revoke` with the GCAP session id.
- **GCAP suspension** — the site's suspend action revokes by GCAP user id.
- **Demotion (Nora side)** — role change to non-admin revokes immediately.
- **Link removal / user deletion** — revokes all sessions for the identity.
- **Bounded revalidation** — every active hm session is re-checked against
  the Headmaster session-check endpoint every
  `HEADMASTER_REVALIDATE_SECONDS` (10-120 s, default 25 s); dead GCAP sessions,
  lost roles, or bans revoke the Nora session. Revocation closes already-open
  privileged WebSockets (logs/terminal/metrics) immediately via Redis
  pub/sub, plus a per-socket re-check backstop.

Every issuance, redemption, rejection, and revocation is written to the
`headmaster_audit` table with the GCAP/Nora identity pair.

Gateway embed cookies also retain the originating login's session claims inside
their agent-bound scope. Gateway assets and WebSocket upgrades check that login
using the existing session-version/role check or privileged Headmaster session
check. A revoked login is refused with HTTP 401; unavailable session storage is
refused with HTTP 503. Open gateway relays repeat the check every
`REMOTE_HOST_AUTH_RECHECK_MS` (default 5 seconds), before sending runtime
credentials, and close both peers when authorization fails. The original login
expiry still applies. Scoped cookies cannot authenticate as full login sessions.

Older gateway embed cookies without originating login claims fail closed. Reload
the embed with a current login cookie to mint a replacement; no database change
or new session store is needed.

## Configuration

Nora backend (`/opt/nora/.env`):

- `HEADMASTER_S2S_TOKEN` — shared secret for the S2S surface (unset = the
  whole feature 404s).
- `HEADMASTER_PARENT_ORIGIN` — exact HTTPS origin of the Headmaster host.
- `HEADMASTER_SESSION_CHECK_URL` — Headmaster's session-check endpoint.
- `HEADMASTER_LAUNCH_TTL_SECONDS` (default 60), `HEADMASTER_REVALIDATE_SECONDS`
  (default 25, range 10-120).

Nora frontend builds (both dashboards): `NEXT_PUBLIC_HEADMASTER_PARENT_ORIGIN`
build arg — must equal `HEADMASTER_PARENT_ORIGIN`.

`docker-compose.yml` passes it as a build arg for both dashboards (from the
environment or `.env`, empty by default). Without it the embedded Runtime
console sits on "Preparing your console". Rebuild example:

```
cd /opt/nora
NEXT_PUBLIC_HEADMASTER_PARENT_ORIGIN=https://headmaster.gcaplabs.com \
  docker compose build frontend-dashboard admin-dashboard
```

Headmaster site: `HEADMASTER_NORA_EMBED_ENABLED` (default off),
`HEADMASTER_NORA_ORIGIN` (default `https://lpanel-admin.gcaplabs.com`, an unadvertised host reached only from the Headmaster admin embed),
`HEADMASTER_NORA_S2S_TOKEN` (same secret as Nora).

Identity links are provisioned explicitly (never inferred):

```
POST /api/internal/headmaster/admin-links   (S2S bearer)
{ "gcapUserId": "<supabase user id>", "noraUserId": "<existing Nora admin uuid>" }
```

## Deployment and rollback

Build only the affected images (backend-api, frontend-dashboard,
admin-dashboard) from this branch and recreate those services; workers,
Postgres, Redis, volumes, and the agent network are untouched. Rollback =
redeploy the previous image tags and/or point the frontends back at the
previous build; disabling `HEADMASTER_NORA_EMBED_ENABLED` restores the
classic `/admin`. Native Nora login at the marketing site remains the
break-glass operator path throughout.
