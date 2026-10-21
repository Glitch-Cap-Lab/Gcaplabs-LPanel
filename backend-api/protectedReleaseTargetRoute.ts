// @ts-nocheck
// Read-only release target for one bot, for the Headmaster provisioner's fleet
// rollout. Same session and ownership rule as the status and operation routes.
const { loadShared } = require("./protectedReleaseStatusRoute");

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function createProtectedReleaseTargetHandler({ db, loadBackend,
  describeTarget = loadShared("protectedReleaseTarget").describeProtectedReleaseTarget,
  Adapter = loadShared("protectedReleaseDocker").ProtectedReleaseDocker } = {}) {
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.apiKey || !req.user?.id) return res.status(403).json({ code: "session_required" });
    if (!UUID.test(req.params.id ?? "") || Object.keys(req.query || {}).length) return res.status(400).json({ code: "invalid_request" });
    try {
      const row = (await db.query("SELECT * FROM agents WHERE id = $1", [req.params.id])).rows[0];
      if (!row || row.user_id !== req.user.id) return res.status(404).json({ code: "release_not_found" });
      const target = await describeTarget(row, new Adapter(await loadBackend(row)));
      return res.json({ target });
    } catch (error) {
      if (typeof error?.code === "string" && error.code.startsWith("PROTECTED_RELEASE_")) return res.status(409).json({ code: error.code });
      return res.status(503).json({ code: "release_target_unconfirmed" });
    }
  };
}
module.exports = { createProtectedReleaseTargetHandler };
