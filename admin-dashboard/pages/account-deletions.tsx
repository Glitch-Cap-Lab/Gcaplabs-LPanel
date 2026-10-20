import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, UserX } from "lucide-react";
import AdminLayout from "../components/AdminLayout";
import { useToast } from "../components/Toast";
import { fetchWithAuth } from "../lib/api";
import { formatDateTime } from "../lib/format";

// Headmaster account deletions (decision 31): requests made in the apps, plus
// admin-initiated deletion. Operators retry actual failed or pending cleanup
// from the saved targets, including requests interrupted before Auth deletion.
const DELETION_STEPS = ["revoke_sessions", "push_registrations", "cloud_runtime", "memory_bank", "relay_usage", "auth_user"];
const STEP_LABELS = {
  revoke_sessions: "Sessions revoked",
  push_registrations: "Push devices removed",
  cloud_runtime: "Cloud runtime wiped",
  memory_bank: "Memory bank deleted",
  relay_usage: "Relay usage deleted",
  auth_user: "Account deleted",
};

export default function AccountDeletionsPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [ownerId, setOwnerId] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState("");
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth("/api/admin/account-deletions");
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || "Could not load account deletions.");
      setRows(Array.isArray(body) ? body : []);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  async function deleteAccount(event) {
    event.preventDefault();
    setBusy("delete");
    try {
      const res = await fetchWithAuth("/api/admin/account-deletions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ownerId: ownerId.trim(), confirm }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || "The account could not be deleted.");
      toast.success(body?.status === "completed" ? "Account deletion completed." : "Deletion recorded. Retry the remaining cleanup steps.");
      setOwnerId(""); setConfirm("");
      await load();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy("");
    }
  }

  async function runCleanup(id, step) {
    setBusy(`${id}:${step}`);
    try {
      const res = await fetchWithAuth(`/api/admin/account-deletions/${id}/steps/${step}`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || "Could not run cleanup.");
      if (body?.steps?.[step] !== "done") toast.error("Cleanup did not finish. Refresh and retry.");
      await load();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy("");
    }
  }

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-black">Account deletions</h1>
          <button type="button" onClick={load} className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold">
            <RefreshCw size={16} /> Refresh
          </button>
        </div>

        <form onSubmit={deleteAccount} className="space-y-3 rounded-2xl border p-4">
          <h2 className="flex items-center gap-2 font-bold"><UserX size={18} /> Delete an account</h2>
          <p className="text-sm opacity-70">Revokes sessions, removes stored data and deletes the sign-in. It cannot be undone.</p>
          <input value={ownerId} onChange={(e) => setOwnerId(e.target.value)} placeholder="Account user id (uuid)"
            className="w-full rounded-xl border px-3 py-2 text-sm" />
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder='Type DELETE to confirm'
            className="w-full rounded-xl border px-3 py-2 text-sm" />
          <button type="submit" disabled={busy === "delete" || confirm !== "DELETE" || !ownerId.trim()}
            className="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
            {busy === "delete" ? <Loader2 size={16} className="animate-spin" /> : "Delete account"}
          </button>
        </form>

        {loading ? <Loader2 className="animate-spin" /> : rows.length === 0 ? (
          <p className="text-sm opacity-70">No deletion requests.</p>
        ) : (
          <div className="overflow-x-auto rounded-2xl border">
            <table className="w-full text-sm">
              <thead><tr className="text-left">
                <th className="p-3">Requested</th><th className="p-3">Account</th><th className="p-3">From</th>
                <th className="p-3">Status</th><th className="p-3">Steps</th>
              </tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-t align-top">
                    <td className="p-3">{formatDateTime(row.requested_at)}</td>
                    <td className="p-3"><div>{row.email || "—"}</div><div className="font-mono text-xs opacity-60">{row.owner_id}</div></td>
                    <td className="p-3">{row.source === "admin" ? "Admin" : "App"}</td>
                    <td className="p-3">{row.status}</td>
                    <td className="space-y-1 p-3">
                      {!row.cleanup_targets && <p className="text-xs">Cleanup targets are missing. Operator recovery is required.</p>}
                      {DELETION_STEPS.map((step) => (
                        <div key={step} className="flex items-center gap-2">
                          <span>{STEP_LABELS[step] || step}: {row.steps?.[step] || "pending_operator"}</span>
                          {row.cleanup_targets && row.steps?.[step] !== "done" && (
                            <button type="button" onClick={() => runCleanup(row.id, step)} disabled={busy === `${row.id}:${step}`}
                              className="rounded-lg border px-2 py-0.5 text-xs font-semibold">{row.steps?.[step] === "failed" || row.steps?.[step] === "skipped" ? "Retry cleanup" : "Run cleanup"}</button>
                          )}
                        </div>
                      ))}
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
