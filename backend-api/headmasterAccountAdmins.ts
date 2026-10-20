// @ts-nocheck
// Headmaster admin accounts, for the admin "Headmaster accounts" page. Lists
// accounts with their entitlement and admin flag, and sets the flag. Uses the
// same Headmaster Supabase service-role credentials as the account deletions
// tab (HEADMASTER_SUPABASE_URL, HEADMASTER_SUPABASE_SERVICE_ROLE_KEY).
// The column and the write function come from gcaplabs-webapp migration
// supabase/migrations/20261013120000_account_admin_flag.sql (owner applies it).
// Admission reads is_admin with the entitlement on every request, so a change
// takes effect on the account's next request.

const TABLE = "headmaster_account_entitlements";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ACCOUNTS = 1000;
const JOB_FIELDS = "id,owner_id,workspace_id,desired_action,status,step,nora_agent_id,fence,authorization_revision,updated_at,workspaces!inner(owner_id)";

function config(env = process.env) {
  const url = String(env.HEADMASTER_SUPABASE_URL || "").replace(/\/+$/, "");
  const key = String(env.HEADMASTER_SUPABASE_SERVICE_ROLE_KEY || "");
  if (!url || !key) return null;
  return { url, key };
}

function createAccountAdminClient({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const cfg = config(env);
  if (!cfg) return null;
  const headers = { apikey: cfg.key, authorization: `Bearer ${cfg.key}`, "content-type": "application/json" };
  const rest = (path, init = {}) => fetchImpl(`${cfg.url}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });

  // Best effort: emails come from the auth admin API. A failure leaves them blank.
  async function emailsById() {
    try {
      const res = await fetchImpl(`${cfg.url}/auth/v1/admin/users?page=1&per_page=${MAX_ACCOUNTS}`, { headers });
      if (!res.ok) return new Map();
      const body = await res.json();
      const users = Array.isArray(body?.users) ? body.users : [];
      return new Map(users.map((u) => [String(u.id).toLowerCase(), u.email || null]));
    } catch {
      return new Map();
    }
  }

  async function list() {
    const res = await rest(`${TABLE}?select=owner_id,entitlement,is_admin,updated_at&order=updated_at.desc&limit=${MAX_ACCOUNTS}`);
    if (!res.ok) throw new Error("accounts_unavailable");
    const rows = await res.json();
    const emails = await emailsById();
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      owner_id: row.owner_id,
      email: emails.get(String(row.owner_id).toLowerCase()) || null,
      entitlement: row.entitlement,
      is_admin: row.is_admin === true,
      updated_at: row.updated_at || null,
    }));
  }

  async function setAdmin(ownerId, isAdmin) {
    if (!UUID_RE.test(String(ownerId || ""))) throw new Error("owner_invalid");
    if (typeof isAdmin !== "boolean") throw new Error("flag_invalid");
    const res = await rest("rpc/headmaster_set_account_admin", {
      method: "POST",
      body: JSON.stringify({ p_owner_id: ownerId, p_is_admin: isAdmin }),
    });
    if (!res.ok) throw new Error("admin_update_failed");
    const rows = await res.json();
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) throw new Error("not_found");
    return { owner_id: row.owner_id, entitlement: row.entitlement, is_admin: row.is_admin === true, updated_at: row.updated_at || null };
  }

  async function recoveryAuthority(ownerId) {
    const query = new URLSearchParams({ owner_id: `eq.${ownerId}`, select: "owner_id,authorization_revision" });
    const res = await rest(`${TABLE}?${query}`);
    if (!res.ok) throw new Error("recovery_unavailable");
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.owner_id !== ownerId) throw new Error("recovery_unavailable");
    return rows[0];
  }
  async function recoveryJobs(ownerId, jobId = null) {
    const query = new URLSearchParams({ owner_id: `eq.${ownerId}`, select: JOB_FIELDS, order: "updated_at.desc", limit: "101" });
    if (jobId) query.set("id", `eq.${jobId}`);
    else {
      query.set("desired_action", "eq.provision");
      query.set("nora_agent_id", "is.null");
      query.set("step", "neq.queued");
    }
    const res = await rest(`headmaster_provision_jobs?${query}`);
    if (!res.ok) throw new Error("recovery_unavailable");
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length > 100) throw new Error("recovery_unavailable");
    return rows;
  }
  async function recoverProvisionJob(job, authority, agentId) {
    const res = await rest("rpc/headmaster_recover_provision_job_identity", {
      method: "POST", signal: AbortSignal.timeout(15000), body: JSON.stringify({ p_job_id: job.id, p_owner_id: job.owner_id,
        p_workspace_id: job.workspace_id, p_expected_fence: job.fence,
        p_expected_job_authorization_revision: job.authorization_revision,
        p_expected_owner_authorization_revision: authority.authorization_revision, p_nora_agent_id: agentId }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const conflict = res.status === 409 || ["55000", "P0001"].includes(body.code);
      const err = new Error(conflict ? "recovery_job_changed" : "recovery_unavailable");
      err.statusCode = conflict ? 409 : 503;
      throw err;
    }
    const rows = await res.json();
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    if (!row || row.id !== job.id || row.owner_id !== job.owner_id || row.workspace_id !== job.workspace_id ||
        row.nora_agent_id !== agentId || row.fence !== job.fence || row.authorization_revision !== job.authorization_revision ||
        row.status !== job.status || row.step !== job.step) throw new Error("recovery_unavailable");
    return row;
  }

  return { list, setAdmin, recoveryAuthority, recoveryJobs, recoverProvisionJob };
}

module.exports = { createAccountAdminClient };
