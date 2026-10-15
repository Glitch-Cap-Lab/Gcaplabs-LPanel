# Cloud socket cleanup and memory limits

The shared Docker adapter and the account memory route use the same two live
resize choices: 2048 and 3072 MiB. Both growing and shrinking pin swap to the
new memory limit. Unsupported values fail before accessing the container.
This does not change initial deployment sizing.

The gateway relay allows eight seconds for its upstream WebSocket connection
and authentication exchange, using the existing connection timeout. Failure,
timeout, or either transport ending stops both sides, clears pending connection
and authorization timers, and discards buffered client messages. A failed
upstream is terminated immediately, including a pending HTTP upgrade. Failure
to send a closing notice cannot prevent cleanup. Successful authentication
removes the deadline; established connections retain their normal lifetime.

## Existing image and resolver requirements

The engine repository already satisfies the image portion of this work at
`eabaecc6d9eb4219fe964f6ac1506585e28fb28c`: its root `Dockerfile` defaults Bot
Screen packages on, installs `at-spi2-core`, and installs `cua-driver 0.30.4`
from a fixed release asset verified by SHA-256
`84445347ceb3039034ce30577b3b7c19a1f0c1f67639423f9da3a71be0418f90`.
The driver is currently baked for Linux x86_64; other architectures skip it
with a warning. These existing requirements do not need another image edit.
No image was built or published as part of this change.

The root `nginx.conf` and `nginx.e2e.conf`, plus
`infra/nginx_public.conf.template` and `infra/nginx_tls.conf`, already declare
Docker DNS resolver `127.0.0.11` with IPv6 disabled and a one-second validity.
The Kubernetes configuration uses static Service upstreams instead of variable
proxy targets and therefore uses cluster DNS at startup.

## Upstream review

Inspected upstream engine revision
`5575a0859d6278bfcef79c28189a24594952efd3`, its root `Dockerfile`, package lock,
and display WebSocket bridge before implementation. The existing image recipe
already adapts the upstream package list; the account gate and pinned driver
are distribution additions. The display bridge cancels pumps and closes its
transport during terminal cleanup. This change adapts that lifecycle principle
to the JavaScript control-plane relay, without copying its Python implementation.
Upstream has no equivalent control-plane container resize endpoint; the memory
choices come from this repository's existing route contract.

Mocked regression tests exercise refused authentication, failed notification
sends, pending-upgrade and established-socket errors, authentication timeouts,
late frames after termination, successful relay survival, and both resize tiers
with unsupported values rejected. They do not access a database or container.
