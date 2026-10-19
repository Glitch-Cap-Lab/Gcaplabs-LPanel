// @ts-nocheck
// Admin "Account deletions" tab (decision 31).
//   GET  /admin/account-deletions                      list requests (newest first)
//   POST /admin/account-deletions                      { ownerId, confirm: "DELETE" } delete an account
//   POST /admin/account-deletions/:id/steps/:step      run/retry actual cleanup
// Admin session only (requireSession + requireAdmin); API keys never reach it.

const express = require("express");
const { requireAdmin, requireSession } = require("../middleware/auth");
const { createDeletionClient } = require("../headmasterAccountDeletions");

function buildRouter({ clientFactory = () => createDeletionClient() } = {}) {
  const router = express.Router();
  router.use(requireSession, requireAdmin);

  function client(res) {
    const c = clientFactory();
    if (!c) res.status(503).json({ error: "Headmaster account store is not configured." });
    return c;
  }
  const actorOf = (req) => req.user?.email || req.user?.id || "admin";

  router.get("/", async (_req, res) => {
    const c = client(res); if (!c) return;
    try { res.json(await c.list()); } catch { res.status(503).json({ error: "Could not load account deletions." }); }
  });

  router.post("/", express.json({ limit: "4kb" }), async (req, res) => {
    const c = client(res); if (!c) return;
    if (req.body?.confirm !== "DELETE") return res.status(400).json({ error: "Type DELETE to confirm." });
    try {
      res.json(await c.deleteAccount(String(req.body?.ownerId || "").trim(), actorOf(req)));
    } catch (error) {
      const code = error?.statusCode || 503;
      const copy = error?.message === "deletion_busy" ? "A runtime operation is still running. Wait for it to finish, then retry account deletion."
        : error?.message === "deletion_already_requested" ? "A deletion request already exists. Refresh and retry its remaining cleanup steps."
        : code === 400 ? "Enter the account's user id." : "The account could not be deleted.";
      res.status(code).json({ error: copy });
    }
  });

  router.post("/:id/steps/:step", async (req, res) => {
    const c = client(res); if (!c) return;
    try {
      res.json(await c.completeStep(req.params.id, req.params.step, actorOf(req)));
    } catch (error) {
      const msg = error?.message;
      const copy = msg === "cleanup_targets_missing" ? "Cleanup targets are missing. Operator recovery is required."
        : msg === "cleanup_targets_invalid" ? "Cleanup targets are invalid. Operator recovery is required."
        : msg === "deletion_conflict" ? "Deletion progress changed. Refresh and retry cleanup."
        : "Could not run cleanup. Refresh and retry.";
      res.status(error?.statusCode || 503).json({ error: copy });
    }
  });
  return router;
}

module.exports = buildRouter();
module.exports.buildRouter = buildRouter;
