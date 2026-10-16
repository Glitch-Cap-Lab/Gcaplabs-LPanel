// @ts-nocheck
const { WebSocketServer } = require("ws");
const { buildAgentStatsResponse } = require("./agentTelemetry");
const { authenticateSocketUpgrade, checkSocketSession } = require("./middleware/auth");
const { findAccessibleAgentForActor } = require("./middleware/ownership");
const { assertRemoteHostAgentUse, isRemoteHostAccessRevokedError } = require("./remoteHosts");

const STREAM_INTERVAL_MS = 5000;

/**
 * Attach a viewer-authorized metrics WebSocket endpoint that rechecks access
 * and publishes a current agent snapshot every five seconds.
 *
 * @param {Object} server - HTTP server receiving the upgrade handler.
 * @returns {Object} Attached WebSocket server.
 */
function attachMetricsStream(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const match = url.pathname.match(/^\/ws\/metrics\/(.+)$/);
    if (!match) {
      return;
    }

    // Same session checks as the HTTP middleware (revoked, demoted, or
    // unverifiable sessions are refused before the upgrade completes).
    void authenticateSocketUpgrade(request, socket, url.searchParams).then((actor) => {
      if (!actor) return;
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, { agentId: match[1], user: actor });
      });
    }, () => socket.destroy());
  });

  wss.on("connection", async (ws, { agentId, user }) => {
    // Headmaster-launched sessions: close revoked connections within the
    // bounded revocation delay.
    let unregisterRevokedSocket = () => {};
    if (user && user.hm) {
      try {
        unregisterRevokedSocket = await require("./headmasterLaunch").registerPrivilegedSocket(
          user,
          () => {
            if (ws.readyState === 1) ws.close();
          },
        );
      } catch {
        if (ws.readyState === 1) ws.close();
        return;
      }
      ws.on("close", () => unregisterRevokedSocket());
    }

    let closed = false;
    let snapshotInterval = null;
    let authorizationInterval = null;
    let snapshotInFlight = false;
    let authorizationCheckPromise = null;

    const teardown = () => {
      if (closed) return;
      closed = true;
      if (snapshotInterval) {
        clearInterval(snapshotInterval);
        snapshotInterval = null;
      }
      if (authorizationInterval) {
        clearInterval(authorizationInterval);
        authorizationInterval = null;
      }
    };

    ws.on("close", teardown);
    ws.on("error", teardown);

    const authorizationFailure = (message, code, cause) => {
      const error = new Error(message);
      if (code) error.code = code;
      if (cause) error.cause = cause;
      error.authorizationCheckFailed = true;
      return error;
    };

    const findAuthorizedAgent = async () => {
      // Re-run the HTTP session check on every pass and authorize with the
      // role stored for the user, so logout or demotion closes the socket.
      const session = await checkSocketSession(user);
      if (!session.ok) {
        throw authorizationFailure(
          session.status === 503 ? "Session check unavailable" : "Session has been revoked",
          session.code,
        );
      }
      let agent;
      try {
        agent = await findAccessibleAgentForActor(agentId, session.actor, "viewer");
      } catch (error) {
        throw authorizationFailure(
          "Unable to verify agent access",
          "AGENT_ACCESS_CHECK_FAILED",
          error,
        );
      }

      if (!agent) {
        throw authorizationFailure("Agent not found");
      }

      try {
        await assertRemoteHostAgentUse(agent, { includeProfile: false });
      } catch (error) {
        if (isRemoteHostAccessRevokedError(error)) {
          error.authorizationCheckFailed = true;
          throw error;
        }
        throw authorizationFailure(
          "Unable to verify Remote Docker host access",
          "REMOTE_HOST_AUTH_CHECK_FAILED",
          error,
        );
      }

      return agent;
    };

    const sendSnapshot = async (agent) => {
      const payload = await buildAgentStatsResponse(agent);
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "snapshot", payload }));
      }
    };

    const handleSnapshotError = (error) => {
      if (ws.readyState === 1) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: error.message,
            ...(error?.code ? { code: error.code } : {}),
          }),
        );
      }
      if (error?.authorizationCheckFailed || isRemoteHostAccessRevokedError(error)) ws.close();
    };

    const runAuthorizationCheck = () => {
      if (closed) return Promise.resolve(null);
      if (authorizationCheckPromise) return authorizationCheckPromise;
      authorizationCheckPromise = (async () => {
        try {
          const agent = await findAuthorizedAgent();
          return closed ? null : agent;
        } catch (error) {
          handleSnapshotError(error);
          return null;
        } finally {
          authorizationCheckPromise = null;
        }
      })();
      return authorizationCheckPromise;
    };

    const runSnapshot = async (authorizedAgent = null) => {
      if (closed || snapshotInFlight) return;
      snapshotInFlight = true;
      try {
        const agent = authorizedAgent || (await runAuthorizationCheck());
        if (!agent || closed) return;
        await sendSnapshot(agent);
      } catch (error) {
        handleSnapshotError(error);
      } finally {
        snapshotInFlight = false;
      }
    };

    const initialAgent = await runAuthorizationCheck();
    if (!initialAgent || closed || ws.readyState !== 1) return;

    // Keep authorization independent from telemetry collection. A remote
    // Docker stats call can hang indefinitely; revocation must still close the
    // socket while that first (or any later) snapshot is unresolved.
    authorizationInterval = setInterval(() => {
      void runAuthorizationCheck();
    }, STREAM_INTERVAL_MS);
    authorizationInterval.unref?.();

    await runSnapshot(initialAgent);
    if (closed || ws.readyState !== 1) return;

    snapshotInterval = setInterval(() => {
      void runSnapshot();
    }, STREAM_INTERVAL_MS);
    snapshotInterval.unref?.();
  });

  return wss;
}

module.exports = { attachMetricsStream };
