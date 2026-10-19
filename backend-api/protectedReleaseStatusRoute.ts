// @ts-nocheck
const path = require("path");
const fs = require("fs");
const NAMES = new Set(["protectedReleaseStatus", "protectedReleaseManifest", "protectedReleaseDocker"]);
function loadShared(name) {
  if (!NAMES.has(name)) throw new Error("invalid protected release module");
  const checkout = path.resolve(__dirname, "../workers/provisioner");
  const packaged = path.resolve(__dirname, "protected-release");
  return require(path.join(fs.existsSync(path.join(checkout,"protectedReleaseStatus.ts")) ? checkout : packaged, name));
}
function createProtectedReleaseStatusHandler({ db, getJob, acquireLock, loadBackend,
  readStatus = loadShared("protectedReleaseStatus").readProtectedReleaseStatus,
  Adapter = loadShared("protectedReleaseDocker").ProtectedReleaseDocker } = {}) {
  return async (req,res) => {
    res.set("Cache-Control","private, no-store");
    if (req.apiKey || !req.user?.id) return res.status(403).json({code:"session_required"});
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(req.params.id ?? "")
        || !/^[0-9a-f]{64}$/.test(req.params.releaseId ?? "") || Object.keys(req.query || {}).length
        || req.headers["content-length"] !== undefined || req.headers["transfer-encoding"] !== undefined
        || (req.body && Object.keys(req.body).length)) return res.status(400).json({code:"invalid_request"});
    const read = async () => (await db.query("SELECT * FROM agents WHERE id = $1",[req.params.id])).rows[0];
    const visible = await read();
    if (!visible || visible.user_id !== req.user.id) return res.status(404).json({code:"release_not_found"});
    let lock;
    try {
      lock = await acquireLock(visible.id,{applicationName:"headmaster-protected-release-status"});
      const row = await read();
      if (!row || row.user_id !== req.user.id) return res.status(404).json({code:"release_not_found"});
      const job = await getJob(`protected-release-${req.params.releaseId}`);
      if (!job) return res.status(404).json({code:"release_not_found"});
      const backend = await loadBackend(row);
      const status = await readStatus({manifest:job.data?.protected_release?.manifest,adapter:new Adapter(backend),state:{read},job});
      return res.json(status);
    } catch {
      return res.status(409).json({code:"release_status_unconfirmed",publication_blocked:true});
    } finally { if (lock) await lock.release(); }
  };
}
module.exports = {createProtectedReleaseStatusHandler,loadShared};
