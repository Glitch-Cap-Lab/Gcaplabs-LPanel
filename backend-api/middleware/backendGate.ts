// @ts-nocheck
// Mount-time gate for deploy-target-specific admin and operator surfaces.
// A surface whose deploy target is not in ENABLED_BACKENDS answers 404, as if
// the route did not exist. Read per request so env changes in tests apply.
const { getEnabledBackends } = require("../../agent-runtime/lib/backendCatalog");

// The catalog's ENABLED_BACKENDS parser accepts docker, k8s and proxmox only;
// Remote Docker hosts are an opt-in token on the same variable
// (ENABLED_BACKENDS=docker,remote-docker) so they stay off unless asked for.
function isBackendEnabled(backendId, env = process.env) {
  if (backendId === "remote-docker") {
    return String(env.ENABLED_BACKENDS || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .includes("remote-docker");
  }
  return getEnabledBackends(env).includes(backendId);
}

function requireBackendEnabled(backendId) {
  return function backendGate(_req, res, next) {
    if (isBackendEnabled(backendId)) return next();
    return res.status(404).json({ error: "Not found" });
  };
}

module.exports = { isBackendEnabled, requireBackendEnabled };
