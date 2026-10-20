// @ts-nocheck
// Opt-in Cloud isolation for local Docker Hermes runtimes.
//
//   NORA_AGENT_NETWORK_ISOLATION=per-runtime
//     Every runtime gets its own bridge network, so no runtime can reach another. In Headmaster one account has one runtime (its bots are profiles inside it), so this is a network per account and bots share it.
//     NORA_AGENT_NETWORK_PEERS (comma-separated container names, for example
//     the API, worker, admission, bridge and memory gateway) are attached to each
//     runtime network so they can still reach it by name.
//   NORA_AGENT_VOLUME_QUOTA=enforce
//     The runtime home volume (the whole account, all of its bots) is limited to the agent record's disk_gb.
//     Needs /var/lib/docker on XFS mounted with pquota; leave unset otherwise.
//
// Both are off by default, so an unconfigured install behaves exactly as before.

const NETWORK_LABEL = "nora.runtime.network";
const AGENT_LABEL = "nora.agent.id";

function perRuntimeNetworkEnabled(env = process.env) {
  return String(env.NORA_AGENT_NETWORK_ISOLATION || "").trim().toLowerCase() === "per-runtime";
}

function volumeQuotaMode(env = process.env) {
  const mode = String(env.NORA_AGENT_VOLUME_QUOTA || "").trim().toLowerCase();
  return mode === "enforce" || mode === "monitor" ? mode : "";
}

function volumeQuotaEnabled(env = process.env) {
  return volumeQuotaMode(env) === "enforce";
}

// For hosts without filesystem quotas (ext4): compare each runtime home volume's
// real size with its agent's disk_gb. Read-only; the caller decides what to do.
async function findOverQuotaVolumes(docker, diskGbByAgentId) {
  const df = await docker.df();
  const over = [];
  for (const volume of df?.Volumes || []) {
    const match = /^nora_hermes_home_(.+)$/.exec(volume.Name || "");
    const limitGb = match ? Number(diskGbByAgentId[match[1]]) : NaN;
    const used = volume.UsageData?.Size;
    if (!Number.isFinite(limitGb) || limitGb < 1 || !(used >= 0)) continue;
    const limitBytes = limitGb * 1024 ** 3;
    if (used > limitBytes) over.push({ agentId: match[1], usedBytes: used, limitBytes });
  }
  return over;
}

function perRuntimeNetworkName(agentId) {
  const slug = String(agentId).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) throw new Error("A per-runtime network needs an agent id");
  return `nora-runtime-net-${slug}`;
}

function agentNetworkPeers(env = process.env) {
  return String(env.NORA_AGENT_NETWORK_PEERS || "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name));
}

// Seconds between re-attach passes; 0 turns the timer off (start-up pass only).
function networkReconcileIntervalMs(env = process.env) {
  const raw = String(env.NORA_AGENT_NETWORK_RECONCILE_SECONDS ?? "60").trim();
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) return 60000;
  return seconds > 0 ? Math.max(10, seconds) * 1000 : 0;
}

function volumeQuotaOptions(diskGb, env = process.env) {
  if (!volumeQuotaEnabled(env)) return null;
  const gb = Number.parseInt(diskGb, 10);
  if (!Number.isInteger(gb) || gb < 1) return null;
  return { DriverOpts: { size: `${gb}g` } };
}

function isAlreadyDone(error) {
  const status = error?.statusCode;
  return status === 409 || status === 403 || /already (exists|connected)|endpoint with name .* already exists/i.test(error?.message || "");
}

const warnedAttach = new Set();

async function connectPeers(docker, networkName, peers) {
  const network = docker.getNetwork(networkName);
  for (const peer of peers) {
    try {
      await network.connect({ Container: peer });
    } catch (error) {
      if (isAlreadyDone(error)) continue;
      // A missing peer (for example admission not deployed here) must not fail a deploy.
      // Reconcile repeats, so say it once per peer and network.
      const key = `${networkName}/${peer}`;
      if (warnedAttach.has(key)) continue;
      warnedAttach.add(key);
      console.warn(`[isolation] Could not attach ${peer} to ${networkName}: ${error.message}`);
    }
  }
}

async function ensureAgentNetwork(docker, agentId, peers = agentNetworkPeers()) {
  const name = perRuntimeNetworkName(agentId);
  try {
    await docker.createNetwork({
      Name: name,
      Driver: "bridge",
      CheckDuplicate: true,
      Labels: { [NETWORK_LABEL]: "true", [AGENT_LABEL]: String(agentId) },
    });
  } catch (error) {
    if (!isAlreadyDone(error)) throw error;
  }
  await connectPeers(docker, name, peers);
  return name;
}

// A recreated peer (compose up) loses its runtime networks, so the worker
// re-attaches peers to every runtime network on start and on a timer.
async function reconcileAgentNetworks(docker, peers = agentNetworkPeers()) {
  const networks = await docker.listNetworks({
    filters: JSON.stringify({ label: [`${NETWORK_LABEL}=true`] }),
  });
  for (const net of networks) await connectPeers(docker, net.Name, peers);
  return networks.map((net) => net.Name);
}

async function removeAgentNetwork(docker, agentId, peers = agentNetworkPeers()) {
  const name = perRuntimeNetworkName(agentId);
  const network = docker.getNetwork(name);
  for (const peer of peers) {
    try {
      await network.disconnect({ Container: peer, Force: true });
    } catch {
      // Not attached.
    }
  }
  try {
    await network.remove();
  } catch (error) {
    if (error?.statusCode !== 404) console.warn(`[isolation] Could not remove ${name}: ${error.message}`);
  }
}

module.exports = {
  perRuntimeNetworkEnabled,
  volumeQuotaEnabled,
  volumeQuotaMode,
  findOverQuotaVolumes,
  perRuntimeNetworkName,
  agentNetworkPeers,
  networkReconcileIntervalMs,
  volumeQuotaOptions,
  ensureAgentNetwork,
  reconcileAgentNetworks,
  removeAgentNetwork,
};
