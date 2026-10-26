// @ts-nocheck
// The Hermes runtime image new bots start on follows the newest finalized runtime release in
// the account database (headmaster_current_runtime_image), so a fleet release does not leave
// HERMES_DOCKER_IMAGE pointing at the old version. The env value stays the fallback when no
// release is finalized or the account database cannot be reached. The image changes only when a
// release is finalized, and every poll counts against the account service's egress and log
// quota (two services poll here), so it is refreshed every five minutes.
const REFRESH_MS = 5 * 60_000;
let current = null;
let timer = null;

function config(env = process.env) {
  const url = String(env.HEADMASTER_SUPABASE_URL || "").replace(/\/+$/, "");
  const key = String(env.HEADMASTER_SUPABASE_SERVICE_ROLE_KEY || "");
  return url && key ? { url, key } : null;
}

async function refreshCurrentRuntimeImage({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const cfg = config(env);
  if (!cfg) return current;
  try {
    const res = await fetchImpl(`${cfg.url}/rest/v1/rpc/headmaster_current_runtime_image`, {
      method: "POST",
      headers: { apikey: cfg.key, authorization: `Bearer ${cfg.key}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return current;
    const body = await res.json();
    const image = typeof body === "string" ? body.trim() : "";
    current = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/.test(image) ? image : null;
  } catch {
    // Keep the last answer; the env image is the fallback.
  }
  return current;
}

/** Refresh once now and then every five minutes. Safe to call more than once. */
function startCurrentRuntimeImagePoll(options) {
  if (timer || !config(options?.env)) return;
  void refreshCurrentRuntimeImage(options);
  timer = setInterval(() => void refreshCurrentRuntimeImage(options), REFRESH_MS);
  timer.unref?.();
}

const getCurrentRuntimeImage = () => current;
function resetCurrentRuntimeImageForTests() {
  current = null;
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { getCurrentRuntimeImage, refreshCurrentRuntimeImage, startCurrentRuntimeImagePoll, resetCurrentRuntimeImageForTests };
