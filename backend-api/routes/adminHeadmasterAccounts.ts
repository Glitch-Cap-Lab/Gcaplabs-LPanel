// @ts-nocheck
// Admin "Headmaster accounts" page: the Headmaster admin flag.
//   GET /admin/headmaster-accounts                   list accounts (entitlement, is_admin, email)
//   PUT /admin/headmaster-accounts/:ownerId/admin    { isAdmin: boolean } set the flag
// Admin session only (requireSession + requireAdmin); API keys never reach it.

const express = require("express");
const { requireAdmin, requireSession } = require("../middleware/auth");
const { createAccountAdminClient } = require("../headmasterAccountAdmins");

async function defaultAudit(req, row) {
  const monitoring = require("../monitoring");
  await monitoring.logEvent(
    "headmaster_account_admin_changed",
    `Headmaster account ${row.owner_id} admin set to ${row.is_admin}`,
    { ownerId: row.owner_id, isAdmin: row.is_admin, actor: req.user?.email || req.user?.id || null },
  );
}

function buildRouter({ clientFactory = () => createAccountAdminClient(), audit = defaultAudit, recoveryDeps = null, recoveryAudit = null } = {}) {
  const router = express.Router();
  router.use(requireSession, requireAdmin);

  function client(res) {
    const c = clientFactory();
    if (!c) res.status(503).json({ error: "Headmaster account store is not configured." });
    return c;
  }

  router.get("/", async (_req, res) => {
    const c = client(res); if (!c) return;
    try { res.json(await c.list()); } catch { res.status(503).json({ error: "Could not load Headmaster accounts." }); }
  });

  const deps = () => recoveryDeps || { db: require("../db"), acquireLock: require("../agentProvisionLock").acquireAgentProvisionLock };
  const recoveryFailure = (res, error) => {
    const messages = {
      owner_invalid: "Enter the account's user id.", recovery_input_invalid: "Refresh the recovery panel and inspect the job again.",
      recovery_job_not_found: "The provisioning job is no longer available.", recovery_job_changed: "The account or job changed. Refresh and inspect it again.",
      recovery_running: "The job is running. Wait for it to finish before recovering its identity.", recovery_ineligible: "This job is not eligible for identity recovery.",
      recovery_no_match: "No matching runtime was found. Operator investigation is required.", recovery_ambiguous: "More than one matching runtime exists. Operator investigation is required.",
      recovery_identity_mismatch: "The runtime identity changed. Refresh and inspect it again.", recovery_unsupported_runtime: "This runtime cannot be recovered through this action.",
    };
    res.status(error?.statusCode || 503).json({ error: messages[error?.message] || "Could not verify runtime identity recovery. Refresh and inspect it again." });
  };
  router.get("/:ownerId/provision-recovery", async (req, res) => {
    const c = client(res); if (!c) return;
    try { res.json(await require("../headmasterProvisionRecovery").inspectProvisionRecovery(c, req.params.ownerId, deps())); }
    catch (error) { recoveryFailure(res, error); }
  });
  router.post("/:ownerId/provision-recovery/:jobId", express.json({ limit: "2kb" }), async (req, res) => {
    const c = client(res); if (!c) return;
    try {
      const result = await require("../headmasterProvisionRecovery").recoverProvisionIdentity(c, req.params.ownerId, req.params.jobId, req.body, deps());
      const metadata = { actor: req.user?.id || null, ownerId: result.owner_id, jobId: result.job.id,
        workspaceId: result.job.workspace_id, agentId: result.candidate.id, proof: result.proof };
      try {
        if (recoveryAudit) await recoveryAudit(metadata);
        else await require("../monitoring").logEvent("headmaster_provision_identity_recovered", "Provisioning runtime identity recovered", metadata);
      } catch { /* The durable RPC receipt is authoritative; never replay a write merely for audit delivery. */ }
      res.json(result);
    } catch (error) { recoveryFailure(res, error); }
  });

  router.put("/:ownerId/admin", express.json({ limit: "1kb" }), async (req, res) => {
    const isAdmin = req.body?.isAdmin;
    if (typeof isAdmin !== "boolean") return res.status(400).json({ error: "isAdmin must be true or false." });
    const c = client(res); if (!c) return;
    try {
      const row = await c.setAdmin(String(req.params.ownerId || "").trim(), isAdmin);
      if (typeof audit === "function") {
        try { await audit(req, row); } catch { /* audit is best effort */ }
      }
      res.json(row);
    } catch (error) {
      const msg = error?.message;
      const status = msg === "owner_invalid" || msg === "flag_invalid" ? 400 : msg === "not_found" ? 404 : 503;
      res.status(status).json({ error: status === 400 ? "Enter the account's user id." : status === 404 ? "No Headmaster account with that id." : "Could not update the admin flag." });
    }
  });
  return router;
}

module.exports = buildRouter();
module.exports.buildRouter = buildRouter;
