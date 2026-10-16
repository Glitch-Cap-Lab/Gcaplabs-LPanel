// @ts-nocheck
const { isSessionTokenPayload, checkSocketSession } = require("./middleware/auth");

// Embed cookies remain agent-scoped credentials. Retain the originating login
// claims inside that scope so logout, role changes and hm revocation still apply.
async function checkGatewayEmbedSession(payload) {
  const session = payload?.session;
  if (
    !isSessionTokenPayload(session) ||
    session.id !== payload.id ||
    (session.exp !== undefined && session.exp <= Math.floor(Date.now() / 1000))
  ) {
    return { ok: false, status: 401, code: "session_invalid" };
  }
  return checkSocketSession(session);
}

module.exports = { checkGatewayEmbedSession };
