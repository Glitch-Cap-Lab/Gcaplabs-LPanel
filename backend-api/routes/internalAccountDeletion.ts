// @ts-nocheck
// Internal endpoints for Headmaster account deletion (decision 31). Not for
// browsers or users: the caller is the account API, authenticated by the
// `x-headmaster-internal-secret` header matching HEADMASTER_ACCOUNT_DELETION_SECRET
// (>= 32 chars; unset = every call 503). Mount only on the private network.
//   POST /internal/headmaster/account-deletion/cloud-runtime  { ownerId, agentId }
//   POST /internal/headmaster/account-deletion/memory-bank    { ownerId, bankId }
//   POST /internal/headmaster/account-deletion/relay-usage    { ownerId }

const express = require("express");
const { secretMatches, wipeCloudRuntime, deleteMemoryBank, clearRelayUsage } = require("../headmasterAccountWipe");

function buildRouter({ env = process.env, deps = null, redisFactory = null, fetchImpl } = {}) {
  const router = express.Router();
  router.use(express.json({ limit: "2kb" }));
  router.use((req, res, next) => {
    if (!env.HEADMASTER_ACCOUNT_DELETION_SECRET) return res.status(503).json({ error: "not_configured" });
    if (!secretMatches(req.get("x-headmaster-internal-secret"), env.HEADMASTER_ACCOUNT_DELETION_SECRET)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    next();
  });

  const lazyDeps = () => deps || {
    db: require("../db"),
    containerManager: require("../containerManager"),
    acquireLock: require("../agentProvisionLock").acquireAgentProvisionLock,
    releasePort: require("../portAllocations").releaseGatewayPort,
    cancelJobs: require("../redisQueue").cancelDeploymentJobsForAgent,
  };
  let redis = null;
  const lazyRedis = () => {
    if (redis) return redis;
    if (redisFactory) return (redis = redisFactory());
    const IORedis = require("ioredis");
    const { createRedisClient } = require("../lib/connectionConfig");
    return (redis = createRedisClient(IORedis, env));
  };

  const run = (fn) => async (req, res) => {
    try {
      res.json(await fn(req.body || {}));
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "step_failed" });
    }
  };

  router.post("/cloud-runtime", run((b) => wipeCloudRuntime(b.agentId, lazyDeps(), b.ownerId)));
  router.post("/memory-bank", run((b) => deleteMemoryBank(b.bankId, { env, fetchImpl, expectedOwnerId: b.ownerId })));
  router.post("/relay-usage", run((b) => clearRelayUsage(b.ownerId, lazyRedis())));
  return router;
}

module.exports = buildRouter();
module.exports.buildRouter = buildRouter;
