// @ts-nocheck
// Workspace-scoped alert rules. Each rule matches events by event_pattern
// (literal "agent.error" or suffix-glob "agent.*") and delivers to one or more
// channels. v1 channels: { type: "webhook", url, headers? } | { type: "email" }.
// Webhook deliveries are enqueued to the BullMQ alert-deliveries queue with
// exponential-backoff retry; email deliveries stay inline (the mailer manages
// its own transport-level retries). Terminal failures are recorded on the
// rule's last_error.

const { randomUUID } = require("crypto");
const db = require("./db");
const { assertSafeUrl, assertSafeUrlAsync } = require("./networkSafety");

const SUPPORTED_CHANNEL_TYPES = new Set(["webhook", "email"]);
const DELIVERY_TIMEOUT_MS = 5000;
const MAX_PATTERN_LENGTH = 100;
const MAX_NAME_LENGTH = 100;
const MAX_EMAIL_RECIPIENTS = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// BullMQ persists job data in Redis. Bound the metadata blob we forward so a
// pathological event payload can't blow up the queue.
const MAX_QUEUED_METADATA_BYTES = 8 * 1024;

// ── Validation and matching ─────────────────────────────────────

function normalizeName(value) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) {
    const error = new Error("name is required");
    error.statusCode = 400;
    throw error;
  }
  return s.slice(0, MAX_NAME_LENGTH);
}

function normalizePattern(value) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) {
    const error = new Error("event_pattern is required");
    error.statusCode = 400;
    throw error;
  }
  if (s.length > MAX_PATTERN_LENGTH) {
    const error = new Error("event_pattern is too long");
    error.statusCode = 400;
    throw error;
  }
  return s;
}

/**
 * Validate and normalize persisted delivery channels. Webhook URLs receive a
 * lexical SSRF check here and are resolved again immediately before delivery.
 *
 * @param {Array} value - Requested webhook and email channel definitions.
 * @returns {Array} Normalized channel definitions safe to persist.
 */
function normalizeChannels(value) {
  if (!Array.isArray(value) || value.length === 0) {
    const error = new Error("at least one channel is required");
    error.statusCode = 400;
    throw error;
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      const error = new Error(`channel #${index + 1} must be an object`);
      error.statusCode = 400;
      throw error;
    }
    const type = String(entry.type || "").trim();
    if (!SUPPORTED_CHANNEL_TYPES.has(type)) {
      const error = new Error(
        `channel #${index + 1}: unsupported type "${type}"; expected one of ${[...SUPPORTED_CHANNEL_TYPES].join(", ")}`,
      );
      error.statusCode = 400;
      throw error;
    }
    if (type === "webhook") {
      const url = String(entry.url || "").trim();
      if (!/^https?:\/\//i.test(url)) {
        const error = new Error(`channel #${index + 1}: webhook url must start with http(s)://`);
        error.statusCode = 400;
        throw error;
      }
      // SSRF guard at save time. This is the lexical-only layer (rejects
      // 127.0.0.1, 169.254.169.254, RFC1918 IP literals, etc.); the delivery
      // path also runs DNS resolution in deliverWebhook to cover hostnames
      // that resolve into private space.
      try {
        assertSafeUrl(url, `channel #${index + 1}: webhook url`);
      } catch (urlErr) {
        const error = new Error(urlErr.message);
        error.statusCode = 400;
        throw error;
      }
      const headers =
        entry.headers && typeof entry.headers === "object" && !Array.isArray(entry.headers)
          ? entry.headers
          : undefined;
      return { type, url, ...(headers ? { headers } : {}) };
    }
    if (type === "email") {
      const rawTo = Array.isArray(entry.to) ? entry.to : [];
      const cleanTo = [];
      for (const value of rawTo) {
        if (typeof value !== "string") continue;
        const trimmed = value.trim();
        if (trimmed && !cleanTo.includes(trimmed)) cleanTo.push(trimmed);
      }
      if (cleanTo.length === 0) {
        const error = new Error(
          `channel #${index + 1}: email channel requires at least one recipient in "to"`,
        );
        error.statusCode = 400;
        throw error;
      }
      if (cleanTo.length > MAX_EMAIL_RECIPIENTS) {
        const error = new Error(
          `channel #${index + 1}: email channel allows at most ${MAX_EMAIL_RECIPIENTS} recipients`,
        );
        error.statusCode = 400;
        throw error;
      }
      for (const value of cleanTo) {
        if (!EMAIL_RE.test(value)) {
          const error = new Error(`channel #${index + 1}: "${value}" is not a valid email address`);
          error.statusCode = 400;
          throw error;
        }
      }
      const subjectPrefix =
        typeof entry.subjectPrefix === "string" ? entry.subjectPrefix.trim().slice(0, 60) : "";
      return {
        type,
        to: cleanTo,
        ...(subjectPrefix ? { subjectPrefix } : {}),
      };
    }
    return { type };
  });
}

function patternMatches(pattern, eventType) {
  if (!pattern || !eventType) return false;
  if (pattern === eventType) return true;
  if (pattern === "*") return true;
  // suffix glob: "agent.*" matches "agent.error", "agent.warning", etc.
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return eventType === prefix || eventType.startsWith(`${prefix}.`);
  }
  return false;
}

function serializeRule(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    createdBy: row.created_by,
    name: row.name,
    eventPattern: row.event_pattern,
    channels: Array.isArray(row.channels) ? row.channels : [],
    enabled: row.enabled,
    lastFiredAt: row.last_fired_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Rule persistence ────────────────────────────────────────────

async function listRules(workspaceId) {
  const result = await db.query(
    `SELECT id, workspace_id, created_by, name, event_pattern, channels, enabled,
            last_fired_at, last_error, created_at, updated_at
       FROM alert_rules
      WHERE workspace_id = $1
      ORDER BY created_at DESC`,
    [workspaceId],
  );
  return result.rows.map(serializeRule);
}

async function getRule(ruleId, workspaceId) {
  const result = await db.query(
    `SELECT id, workspace_id, created_by, name, event_pattern, channels, enabled,
            last_fired_at, last_error, created_at, updated_at
       FROM alert_rules
      WHERE id = $1 AND workspace_id = $2`,
    [ruleId, workspaceId],
  );
  return result.rows[0] ? serializeRule(result.rows[0]) : null;
}

async function createRule(workspaceId, createdBy, payload = {}) {
  const name = normalizeName(payload.name);
  const eventPattern = normalizePattern(payload.eventPattern || payload.event_pattern);
  const channels = normalizeChannels(payload.channels);
  const enabled = payload.enabled !== false;

  const result = await db.query(
    `INSERT INTO alert_rules (workspace_id, created_by, name, event_pattern, channels, enabled)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING id, workspace_id, created_by, name, event_pattern, channels, enabled,
               last_fired_at, last_error, created_at, updated_at`,
    [workspaceId, createdBy || null, name, eventPattern, JSON.stringify(channels), enabled],
  );
  return serializeRule(result.rows[0]);
}

async function updateRule(ruleId, workspaceId, payload = {}) {
  const fields = [];
  const params = [ruleId, workspaceId];
  let next = 3;

  if (payload.name !== undefined) {
    fields.push(`name = $${next++}`);
    params.push(normalizeName(payload.name));
  }
  if (payload.eventPattern !== undefined || payload.event_pattern !== undefined) {
    fields.push(`event_pattern = $${next++}`);
    params.push(normalizePattern(payload.eventPattern || payload.event_pattern));
  }
  if (payload.channels !== undefined) {
    fields.push(`channels = $${next++}::jsonb`);
    params.push(JSON.stringify(normalizeChannels(payload.channels)));
  }
  if (payload.enabled !== undefined) {
    fields.push(`enabled = $${next++}`);
    params.push(Boolean(payload.enabled));
  }

  if (fields.length === 0) return getRule(ruleId, workspaceId);

  fields.push("updated_at = NOW()");
  const result = await db.query(
    `UPDATE alert_rules SET ${fields.join(", ")}
      WHERE id = $1 AND workspace_id = $2
      RETURNING id, workspace_id, created_by, name, event_pattern, channels, enabled,
                last_fired_at, last_error, created_at, updated_at`,
    params,
  );
  return result.rows[0] ? serializeRule(result.rows[0]) : null;
}

async function deleteRule(ruleId, workspaceId) {
  const result = await db.query(
    "DELETE FROM alert_rules WHERE id = $1 AND workspace_id = $2 RETURNING id",
    [ruleId, workspaceId],
  );
  return Boolean(result.rows[0]);
}

async function recordFiring(ruleId, error) {
  await db
    .query(
      `UPDATE alert_rules
          SET last_fired_at = NOW(),
              last_error = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [ruleId, error || null],
    )
    .catch((err) => {
      console.error("Failed to record alert rule firing:", err.message);
    });
}

/**
 * Record a terminal webhook failure without replacing the firing timestamp set
 * by sibling channels. Database errors are logged and suppressed.
 *
 * @param {string} ruleId - Rule whose queued delivery exhausted retries.
 * @param {string} error - Terminal delivery error.
 * @returns {Promise<void>}
 */
async function recordDeliveryFailure(ruleId, error) {
  if (!ruleId) return;
  await db
    .query(
      `UPDATE alert_rules
          SET last_error = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [ruleId, error || null],
    )
    .catch((err) => {
      console.error("Failed to record alert delivery failure:", err.message);
    });
}

// ── Delivery and evaluation ─────────────────────────────────────

function clampMetadataForQueue(metadata) {
  if (!metadata || typeof metadata !== "object") return metadata || {};
  let serialized;
  try {
    serialized = JSON.stringify(metadata);
  } catch {
    return { truncated: true, reason: "metadata_unserializable" };
  }
  if (serialized.length <= MAX_QUEUED_METADATA_BYTES) return metadata;
  return {
    truncated: true,
    originalBytes: serialized.length,
    workspace:
      metadata.workspace || (metadata.workspaceId ? { id: metadata.workspaceId } : undefined),
    agentId: metadata.agentId,
    agent: metadata.agent,
    sourceAgent: metadata.sourceAgent,
  };
}

async function deliverEmail(channel, payload) {
  // Lazy-require so test suites that don't mock mailer don't pull it in.
  const mailer = require("./mailer");
  const subjectPrefix = channel.subjectPrefix ? `[${channel.subjectPrefix}] ` : "";
  const subject = `${subjectPrefix}LPanel alert: ${payload.eventType}`;
  const lines = [
    `Event: ${payload.eventType}`,
    payload.message ? `Message: ${payload.message}` : null,
    payload.firedAt ? `Fired at: ${payload.firedAt}` : null,
    payload.ruleName ? `Rule: ${payload.ruleName}` : null,
    "",
    "Context:",
    JSON.stringify(payload.metadata || {}, null, 2),
  ].filter(Boolean);
  const result = await mailer.sendMail({
    to: channel.to,
    subject,
    text: lines.join("\n"),
  });
  if (!result.delivered) {
    throw new Error(result.error || "email delivery failed");
  }
}

/**
 * Deliver one webhook after checking its current DNS answers and refusing
 * redirects. The validation does not pin fetch to the checked address, and
 * transport or non-2xx responses are thrown for BullMQ retry handling.
 *
 * @param {Object} channel - Webhook URL and optional headers.
 * @param {Object} payload - Alert payload.
 * @returns {Promise<void>}
 */
async function deliverWebhook(channel, payload) {
  // Re-validate at delivery time because rules persist and DNS answers can
  // change after the save-time lexical check.
  await assertSafeUrlAsync(channel.url, "webhook url");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const response = await fetch(channel.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "LPanel-Alerts/1.0",
        ...(channel.headers || {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      // Refuse to follow redirects — a 30x to http://169.254.169.254/ would
      // bypass our pre-check otherwise.
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(`Webhook returned ${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve recipient workspaces from explicit event scope and current agent
 * assignments, using the same workspace_agents authority as agent access and
 * monitoring. Multiple agent references require shared access to every agent.
 * Provenance (including system/admin sources) never grants tenant access.
 */
async function resolveEventWorkspaces(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const workspaceHints = [metadata.workspace?.id, metadata.workspaceId];
  const agentHints = [metadata.agentId, metadata.agent?.id, metadata.sourceAgent?.id];
  const validId = (value) => typeof value === "string" && value.trim().length > 0;
  const supplied = (value) => value !== undefined && value !== null;
  if ([...workspaceHints, ...agentHints].some((value) => supplied(value) && !validId(value))) {
    return [];
  }
  if (metadata.agentId && metadata.agent?.id && metadata.agentId !== metadata.agent.id) return [];
  const workspaceIds = [...new Set(workspaceHints.filter(supplied))];
  if (workspaceIds.length > 1) return [];
  const agentIds = [...new Set(agentHints.filter(supplied))];
  if (!agentIds.length) return workspaceIds;

  const result = await db.query(
    `SELECT wa.workspace_id
       FROM workspace_agents wa
       JOIN agents a ON a.id = wa.agent_id
      WHERE a.id::text = ANY($1::text[])
      GROUP BY wa.workspace_id
     HAVING count(DISTINCT a.id) = $2`,
    [agentIds, agentIds.length],
  );
  return [...new Set(result.rows.map((row) => row.workspace_id))].filter(
    (id) => validId(id) && (!workspaceIds.length || workspaceIds[0] === id),
  );
}

/**
 * Fire enabled rules only within resolved event workspaces. Missing, deleted,
 * conflicting or unavailable ownership fails closed without undoing audit
 * persistence. Webhooks are queued per channel; email remains inline.
 *
 * @param {string} eventType - Event type matched against rule patterns.
 * @param {string} message - Human-readable alert message.
 * @param {Object} metadata - Event context, including workspace identity when
 * scoped.
 * @returns {Promise<void>}
 */
async function evaluateAndDeliver(eventType, message, metadata = {}) {
  if (!eventType) return;
  let rules;
  let workspaceIds;
  try {
    workspaceIds = await resolveEventWorkspaces(metadata);
    if (!workspaceIds.length) return;
    const result = await db.query(
      `SELECT id, workspace_id, name, event_pattern, channels
         FROM alert_rules
        WHERE enabled = true AND workspace_id::text = ANY($1::text[])`,
      [workspaceIds],
    );
    rules = result.rows;
  } catch (err) {
    console.error("Failed to load alert rules for evaluation:", err.message);
    return;
  }

  const matches = rules.filter(
    (rule) =>
      workspaceIds.includes(rule.workspace_id) && patternMatches(rule.event_pattern, eventType),
  );

  if (matches.length === 0) return;

  // redisQueue is required lazily so unit tests that don't mock it (and have
  // no Redis available) aren't pulled into a connection on import.
  let addAlertDeliveryJob;
  try {
    ({ addAlertDeliveryJob } = require("./redisQueue"));
  } catch (err) {
    console.error("Failed to load redisQueue for alert delivery:", err.message);
  }

  const queueMetadata = clampMetadataForQueue(metadata);
  const firedAt = new Date().toISOString();
  const inlinePayload = { eventType, message, metadata, firedAt };

  await Promise.all(
    matches.map(async (rule) => {
      const channels = Array.isArray(rule.channels) ? rule.channels : [];
      const inlineErrors = [];
      for (const channel of channels) {
        if (channel.type === "webhook") {
          if (!addAlertDeliveryJob) {
            inlineErrors.push("webhook:queue_unavailable");
            continue;
          }
          try {
            await addAlertDeliveryJob({
              ruleId: rule.id,
              ruleName: rule.name,
              workspaceId: rule.workspace_id,
              channel,
              eventType,
              message,
              metadata: queueMetadata,
              firedAt,
            });
          } catch (err) {
            inlineErrors.push(`webhook:enqueue_failed:${err.message}`);
          }
        } else if (channel.type === "email") {
          try {
            await deliverEmail(channel, { ...inlinePayload, ruleId: rule.id, ruleName: rule.name });
          } catch (err) {
            inlineErrors.push(`email:${err.message}`);
          }
        }
      }
      await recordFiring(rule.id, inlineErrors.join("; ") || null);
    }),
  );
}

/**
 * Execute one queued webhook delivery. Validation and non-2xx failures throw so
 * BullMQ can retry; the worker records terminal exhaustion separately.
 *
 * @param {Object} jobData - Persisted alert delivery job payload.
 * @returns {Promise<void>}
 */
async function runAlertDeliveryJob(jobData) {
  if (!jobData || typeof jobData !== "object") {
    throw new Error("alert delivery job data is missing");
  }
  const { channel, eventType, message, metadata, firedAt, ruleId, ruleName, deliveryId } = jobData;
  if (!channel || channel.type !== "webhook") {
    throw new Error(`alert delivery job has unsupported channel type: ${channel?.type}`);
  }
  // Recheck persisted jobs as well: an assignment or rule may have been
  // removed since enqueue, and older jobs may predate scoped evaluation.
  const workspaceIds = await resolveEventWorkspaces(metadata);
  if (!workspaceIds.includes(jobData.workspaceId)) return;
  const rule = await db.query(
    "SELECT id FROM alert_rules WHERE id = $1 AND workspace_id = $2 AND enabled = true",
    [ruleId, jobData.workspaceId],
  );
  if (!rule.rows.length) return;
  const payload = {
    eventType,
    message,
    metadata: metadata || {},
    firedAt: firedAt || new Date().toISOString(),
    ruleId,
    ruleName,
    deliveryId: deliveryId || randomUUID(),
  };
  await deliverWebhook(channel, payload);
}

module.exports = {
  SUPPORTED_CHANNEL_TYPES,
  createRule,
  deleteRule,
  evaluateAndDeliver,
  getRule,
  listRules,
  patternMatches,
  recordDeliveryFailure,
  runAlertDeliveryJob,
  serializeRule,
  updateRule,
};
