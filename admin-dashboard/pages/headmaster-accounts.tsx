import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, UserCog } from "lucide-react";
import AdminLayout from "../components/AdminLayout";
import { useToast } from "../components/Toast";
import { fetchWithAuth } from "../lib/api";
import { formatDateTime } from "../lib/format";

// Headmaster accounts: the admin flag (headmaster_account_entitlements.is_admin).
// An admin account sees the admin-only screens in the Headmaster apps, and
// admission admits the admin-only runtime routes for it. Admission reads the
// flag on every request, so a change applies on the account's next request.
export default function HeadmasterAccountsPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [filter, setFilter] = useState("");
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth("/api/admin/headmaster-accounts");
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || "Could not load Headmaster accounts.");
      setRows(Array.isArray(body) ? body : []);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  async function setAdmin(ownerId, isAdmin) {
    setBusy(ownerId);
    try {
      const res = await fetchWithAuth(`/api/admin/headmaster-accounts/${ownerId}/admin`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isAdmin }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || "Could not update the admin flag.");
      setRows((current) => current.map((row) => (row.owner_id === ownerId ? { ...row, ...body } : row)));
      toast.success(isAdmin ? "Account is now an admin." : "Admin removed.");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy("");
    }
  }

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => String(row.email || "").toLowerCase().includes(q) || String(row.owner_id).toLowerCase().includes(q));
  }, [rows, filter]);

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="flex items-center gap-2 text-2xl font-black"><UserCog size={22} /> Headmaster accounts</h1>
          <button type="button" onClick={load} className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold">
            <RefreshCw size={16} /> Refresh
          </button>
        </div>
        <p className="text-sm opacity-70">
          Admin accounts see the admin-only screens in the Headmaster apps. Changes apply on the account&apos;s next request.
        </p>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by email or user id"
          className="w-full rounded-xl border px-3 py-2 text-sm" />

        {loading ? <Loader2 className="animate-spin" /> : visible.length === 0 ? (
          <p className="text-sm opacity-70">No Headmaster accounts.</p>
        ) : (
          <div className="overflow-x-auto rounded-2xl border">
            <table className="w-full text-sm">
              <thead><tr className="text-left">
                <th className="p-3">Account</th><th className="p-3">Entitlement</th>
                <th className="p-3">Updated</th><th className="p-3">Admin</th>
              </tr></thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={row.owner_id} className="border-t align-top">
                    <td className="p-3"><div>{row.email || "—"}</div><div className="font-mono text-xs opacity-60">{row.owner_id}</div></td>
                    <td className="p-3">{row.entitlement === "approved" ? "Approved" : "Not approved"}</td>
                    <td className="p-3">{row.updated_at ? formatDateTime(row.updated_at) : "—"}</td>
                    <td className="p-3">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={row.is_admin === true}
                        aria-label={`Admin for ${row.email || row.owner_id}`}
                        disabled={busy === row.owner_id}
                        onClick={() => setAdmin(row.owner_id, !row.is_admin)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition disabled:opacity-40 ${row.is_admin ? "bg-emerald-600" : "bg-slate-400"}`}
                      >
                        <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${row.is_admin ? "translate-x-5" : "translate-x-1"}`} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
