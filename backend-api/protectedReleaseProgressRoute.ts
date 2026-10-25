// @ts-nocheck
// Live progress of one protected release while its job runs. The status route needs
// the agent lock, which the running job holds, so it can only answer at the end. This
// reads the receipt the job journals into its own queue entry after every phase. It
// takes no lock, touches no container and proves nothing: finalize still uses status.
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

function createProtectedReleaseProgressHandler({ db, getJob }) {
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.apiKey || !req.user?.id) return res.status(403).json({ code: "session_required" });
    if (!UUID.test(req.params.id ?? "") || !HASH.test(req.params.releaseId ?? "") || Object.keys(req.query || {}).length) return res.status(400).json({ code: "invalid_request" });
    try {
      const row = (await db.query("SELECT id, user_id FROM agents WHERE id = $1", [req.params.id])).rows[0];
      if (!row || row.user_id !== req.user.id) return res.status(404).json({ code: "release_not_found" });
      const job = await getJob(`protected-release-${req.params.releaseId}`);
      const release = job?.data?.protected_release;
      if (!job || release?.release_id !== req.params.releaseId || String(job.data.id) !== req.params.id) return res.status(404).json({ code: "release_not_found" });
      const queueState = await job.getState();
      const receipt = release.receipt || null;
      return res.json({ release_id: req.params.releaseId, queue_state: queueState,
        phase: receipt?.phase || (queueState === "failed" ? "failed_before_receipt" : "queued"),
        lp_committed: receipt?.lp_committed === true,
        failure_code: typeof receipt?.failure_code === "string" && /^PROTECTED_RELEASE_[A-Z0-9_]{1,64}$/.test(receipt.failure_code) ? receipt.failure_code : null,
        publication_blocked: true });
    } catch {
      return res.status(503).json({ code: "release_progress_unconfirmed" });
    }
  };
}
module.exports = { createProtectedReleaseProgressHandler };
