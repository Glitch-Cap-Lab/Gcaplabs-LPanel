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

  return { list, setAdmin };
}

module.exports = { createAccountAdminClient };
