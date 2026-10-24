// @ts-nocheck
// Host memory budget for local Docker Hermes runtimes.
//
//   NORA_HOST_MEMORY_BUDGET_MB=<n>
//     Total memory the runtimes on this host may reserve (the sum of each runtime
//     container's memory limit). A new runtime that would push the sum past it is
//     refused before anything is created. Unset or 0 turns the check off. Pick a
//     value below the host's RAM that leaves room for the control plane, chat,
//     relay and page cache; measuring it is a server step.
//
// A recreate of an existing runtime (same agent id) replaces its own reservation
// instead of adding to it, so image updates are never blocked by their own old container.

const AGENT_LABEL = "nora.agent.id";

function hostMemoryBudgetMb(env = process.env) {
  const value = Number(String(env.NORA_HOST_MEMORY_BUDGET_MB || "").trim());
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// Memory (MB) reserved by every runtime container on the host except `agentId`'s own.
async function reservedRuntimeMemoryMb(docker, agentId) {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: [AGENT_LABEL] },
  });
  let reservedBytes = 0;
  for (const summary of containers) {
    if (String(summary.Labels?.[AGENT_LABEL]) === String(agentId)) continue;
    const info = await docker.getContainer(summary.Id).inspect();
    reservedBytes += Number(info?.HostConfig?.Memory) || 0;
  }
  return Math.ceil(reservedBytes / 1024 ** 2);
}

class HostMemoryBudgetError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "HostMemoryBudgetError";
    this.code = "HOST_MEMORY_BUDGET_EXCEEDED";
    this.details = details;
  }
}

// Throws HostMemoryBudgetError when the new runtime does not fit; a no-op without a budget.
async function assertHostMemoryBudget(docker, { agentId, requestedMb }, env = process.env) {
  const budgetMb = hostMemoryBudgetMb(env);
  if (!budgetMb) return;
  const reservedMb = await reservedRuntimeMemoryMb(docker, agentId);
  if (reservedMb + requestedMb > budgetMb) {
    throw new HostMemoryBudgetError(
      `Refusing to start a runtime: this host has ${reservedMb} MB of ${budgetMb} MB reserved ` +
        `and the new runtime needs ${requestedMb} MB. Free capacity or raise NORA_HOST_MEMORY_BUDGET_MB.`,
      { budgetMb, reservedMb, requestedMb },
    );
  }
}

module.exports = {
  hostMemoryBudgetMb,
  reservedRuntimeMemoryMb,
  assertHostMemoryBudget,
  HostMemoryBudgetError,
};
