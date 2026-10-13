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

function buildRouter({ clientFactory = () => createAccountAdminClient(), audit = defaultAudit } = {}) {
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
