// @ts-nocheck
// Admin-started protected release operations. The Headmaster provisioner calls this
// with its LP session after the account service has prepared the release; the
// manifest it sends is the one the account service stored at prepare time. LP
// revalidates everything here exactly as the operator command does.
const { loadShared } = require("./protectedReleaseStatusRoute");

const ACTIONS = { dry_run: "--dry-run", apply: "--enqueue", recover: "--recover" };
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

function createProtectedReleaseOperationHandler({ db, acquireLock, loadBackend, buildReplacementDeploymentJob, enqueue, createQueueSession,
  runOperation = loadShared("protectedReleaseOperation").runProtectedReleaseOperation,
  validateManifest = loadShared("protectedReleaseManifest").validateManifest } = {}) {
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.apiKey || !req.user?.id) return res.status(403).json({ code: "session_required" });
    const body = req.body;
    if (!UUID.test(req.params.id ?? "") || !HASH.test(req.params.releaseId ?? "") || Object.keys(req.query || {}).length
        || !body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join(",") !== "action,manifest"
        || !Object.hasOwn(ACTIONS, body.action)) return res.status(400).json({ code: "invalid_request" });
    let identity;
    try { identity = validateManifest(body.manifest); } catch { return res.status(400).json({ code: "invalid_request" }); }
    if (identity.releaseId !== req.params.releaseId || identity.target.agent_id !== req.params.id) return res.status(400).json({ code: "invalid_request" });
    try {
      const visible = (await db.query("SELECT * FROM agents WHERE id = $1", [req.params.id])).rows[0];
      if (!visible || visible.user_id !== req.user.id) return res.status(404).json({ code: "release_not_found" });
      const result = await runOperation(ACTIONS[body.action], body.manifest, { db, acquireLock, buildReplacementDeploymentJob, enqueue, createQueueSession,
        loadBackend: async () => loadBackend(visible) });
      return res.json(result);
    } catch (error) {
      // Refusals keep their LP code so the admin page can say which check stopped it.
      if (typeof error?.code === "string" && error.code.startsWith("PROTECTED_RELEASE_")) return res.status(409).json({ code: error.code, publication_blocked: true });
      return res.status(503).json({ code: "release_operation_unconfirmed", publication_blocked: true });
    }
  };
}
module.exports = { createProtectedReleaseOperationHandler };
