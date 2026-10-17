// @ts-nocheck
/**
 * Channels module — CRUD + messaging for agent communication channels.
 */

const crypto = require("crypto");
const db = require("../db");
const { encrypt, decrypt, ensureEncryptionConfigured } = require("../crypto");
const { runtimeUrlForAgent } = require("../../agent-runtime/lib/agentEndpoints");
const { runtimeAuthHeaders } = require("../runtimeAuth");
const { getAdapter, listAdapterTypes } = require("./adapters");

const REDACTED_SECRET = "[REDACTED]";
const SECRET_CONFIG_KEY_RE = /(token|secret|password|webhook_url|smtp_pass|auth_token)/i;

// Inbound webhook signing. Scheme and header names match the generic HMAC "V2"
// scheme of the agent runtime's webhook adapter: X-Webhook-Signature-V2 is the
// hex HMAC-SHA256 of "<timestamp>.<raw body>", X-Webhook-Timestamp is Unix seconds.
const INBOUND_SECRET_KEY = "inbound_secret";
const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

function generateInboundSecret() {
  return crypto.randomBytes(32).toString("hex");
}

// Replay cache for signed inbound webhooks. A signature is only valid inside the
// timestamp window, so remembering each accepted (channel, signature) pair for that
// window is enough to refuse a repeat. In-process, like the rest of this module's state.
const seenInboundSignatures = new Map();

function pruneSeenSignatures(nowMs) {
  for (const [key, expiresAt] of seenInboundSignatures) {
    if (expiresAt <= nowMs) seenInboundSignatures.delete(key);
  }
}

/**
 * Record a verified signature; returns false if it was already used in the window.
 *
 * @param {string} channelId - Channel the request targeted.
 * @param {string} signature - The verified signature header.
 * @param {number} [nowMs=Date.now()] - Clock.
 * @returns {boolean} True the first time, false for a replay.
 */
function claimInboundSignature(channelId, signature, nowMs = Date.now()) {
  pruneSeenSignatures(nowMs);
  const key = `${channelId}:${String(signature).toLowerCase()}`;
  if (seenInboundSignatures.has(key)) return false;
  // Twice the tolerance covers timestamps up to 300 s in the future as well as the past.
  seenInboundSignatures.set(key, nowMs + 2 * WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS * 1000);
  return true;
}

function safeEqualHex(provided, expected) {
  const a = Buffer.from(String(provided || ""), "utf8");
  const b = Buffer.from(String(expected || ""), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Check the signed-webhook headers against a channel secret in constant time.
 *
 * @param {string} secret - Per-channel inbound secret.
 * @param {Object} headers - Lower-cased request headers.
 * @param {Buffer|string} rawBody - Exact request bytes.
 * @param {number} [nowMs=Date.now()] - Clock for replay-window checks.
 * @returns {boolean} True only for a fresh, correct signature.
 */
function verifyInboundSignature(secret, headers, rawBody, nowMs = Date.now()) {
  if (!secret || !rawBody) return false;
  const signature = headers?.["x-webhook-signature-v2"];
  const timestamp = headers?.["x-webhook-timestamp"];
  if (!signature || !timestamp || !/^\d{1,12}$/.test(String(timestamp))) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) {
    return false;
  }
  const expected = crypto
    .createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.from(rawBody)]))
    .digest("hex");
  return safeEqualHex(signature, expected);
}

// Channel config security

function parseConfig(config) {
  return typeof config === "string" ? JSON.parse(config) : config || {};
}

function restoreRedactedConfigValue(nextValue, currentValue) {
  if (nextValue === REDACTED_SECRET) {
    return currentValue;
  }

  if (Array.isArray(nextValue)) {
    const currentItems = Array.isArray(currentValue) ? currentValue : [];
    return nextValue.map((entry, index) => restoreRedactedConfigValue(entry, currentItems[index]));
  }

  if (nextValue && typeof nextValue === "object") {
    const currentObject =
      currentValue && typeof currentValue === "object" && !Array.isArray(currentValue)
        ? currentValue
        : {};
    return Object.fromEntries(
      Object.entries(nextValue).map(([key, value]) => [
        key,
        restoreRedactedConfigValue(value, currentObject[key]),
      ]),
    );
  }

  return nextValue;
}

function getSensitiveChannelKeys(type) {
  const adapter = getAdapter(type);
  return new Set(
    (adapter.configFields || [])
      .filter((field) => field?.type === "password" || SECRET_CONFIG_KEY_RE.test(field?.key || ""))
      .map((field) => field.key),
  );
}

/**
 * Encrypt top-level adapter-declared or secret-like config fields before persistence.
 *
 * @param {string} type - Registered channel adapter type.
 * @param {Object} [config={}] - Plain channel configuration.
 * @returns {Object} Secured config and whether sensitive material was present.
 */
function protectChannelConfig(type, config = {}) {
  const parsed = parseConfig(config);
  const sensitiveKeys = getSensitiveChannelKeys(type);
  const secured = { ...parsed };
  let hasSensitiveMaterial = false;

  for (const key of Object.keys(secured)) {
    const value = secured[key];
    if (!value) continue;
    if (sensitiveKeys.has(key) || SECRET_CONFIG_KEY_RE.test(key)) {
      hasSensitiveMaterial = true;
      secured[key] = encrypt(String(value));
    }
  }

  return { secured, hasSensitiveMaterial };
}

/**
 * Decrypt stored channel credentials for trusted adapter and migration use.
 *
 * @param {string} type - Registered channel adapter type.
 * @param {Object} [config={}] - Persisted channel configuration.
 * @returns {Object} Configuration with top-level credential values revealed.
 */
function revealChannelConfig(type, config = {}) {
  const parsed = parseConfig(config);
  const sensitiveKeys = getSensitiveChannelKeys(type);
  const revealed = { ...parsed };

  for (const key of Object.keys(revealed)) {
    const value = revealed[key];
    if (!value) continue;
    if (sensitiveKeys.has(key) || SECRET_CONFIG_KEY_RE.test(key)) {
      revealed[key] = decrypt(String(value));
    }
  }

  return revealed;
}

function redactChannelConfig(type, config = {}) {
  const parsed = parseConfig(config);
  const redacted = { ...parsed };
  const sensitiveKeys = getSensitiveChannelKeys(type);

  for (const key of Object.keys(redacted)) {
    if ((sensitiveKeys.has(key) || SECRET_CONFIG_KEY_RE.test(key)) && redacted[key]) {
      redacted[key] = REDACTED_SECRET;
    }
  }

  return redacted;
}

function stripChannelSecrets(type, config = {}) {
  const parsed = parseConfig(config);
  const stripped = { ...parsed };
  const sensitiveKeys = getSensitiveChannelKeys(type);
  let removedSensitive = false;

  for (const key of Object.keys(stripped)) {
    if ((sensitiveKeys.has(key) || SECRET_CONFIG_KEY_RE.test(key)) && stripped[key]) {
      removedSensitive = true;
      stripped[key] = null;
    }
  }

  return { config: stripped, removedSensitive };
}

/**
 * Remove channel credentials from a clone and disable it when reconnection is required.
 *
 * @param {Object} [channel={}] - Channel row to make portable.
 * @returns {Object} Clone-safe channel configuration.
 */
function buildCloneableChannel(channel = {}) {
  const { config, removedSensitive } = stripChannelSecrets(channel.type, channel.config);

  return {
    type: channel.type,
    name: channel.name,
    config,
    enabled: Boolean(channel.enabled) && !removedSensitive,
  };
}

function sanitizeChannel(channel) {
  if (!channel) return channel;
  return {
    ...channel,
    config: redactChannelConfig(channel.type, channel.config),
  };
}

function hydrateChannel(channel) {
  if (!channel) return channel;
  return {
    ...channel,
    config: revealChannelConfig(channel.type, channel.config),
  };
}

// ── Channel CRUD ─────────────────────────────────────────

async function listChannels(agentId) {
  const result = await db.query(
    "SELECT * FROM channels WHERE agent_id = $1 ORDER BY created_at DESC",
    [agentId],
  );
  return result.rows.map(sanitizeChannel);
}

/**
 * Require a registered adapter type, encrypt credential fields, and persist a redacted response.
 *
 * Adapter configuration verification is not performed during creation.
 *
 * @param {string} agentId - Agent that owns the channel.
 * @param {string} type - Registered adapter type.
 * @param {string} name - Display name.
 * @param {Object} [config={}] - Plain adapter configuration.
 * @returns {Promise<Object>} Persisted channel with credentials redacted.
 */
async function createChannel(agentId, type, name, config = {}) {
  // Verify the adapter type exists
  getAdapter(type);
  const inboundSecret = generateInboundSecret();
  const { secured, hasSensitiveMaterial } = protectChannelConfig(type, config);
  // Only caller-supplied credentials require the encryption key; with the
  // NORA_ALLOW_PLAINTEXT_SECRETS override the generated secret is stored as
  // encrypt() returns it (plaintext when no key is set), as elsewhere.
  if (hasSensitiveMaterial) {
    ensureEncryptionConfigured("Channel credential storage");
  }
  secured[INBOUND_SECRET_KEY] = encrypt(inboundSecret);
  const result = await db.query(
    "INSERT INTO channels(agent_id, type, name, config) VALUES($1, $2, $3, $4) RETURNING *",
    [agentId, type, name, JSON.stringify(secured)],
  );
  // The inbound signing secret is shown once, here; later reads are redacted.
  return { ...sanitizeChannel(result.rows[0]), inbound_secret: inboundSecret };
}

/**
 * Apply an owner-scoped channel update while preserving redacted credential placeholders.
 *
 * @param {string} channelId - Channel identifier.
 * @param {string} agentId - Owning agent identifier.
 * @param {Object} updates - Supported name, config, or enabled changes.
 * @returns {Promise<Object>} Updated channel with credentials redacted.
 */
async function updateChannel(channelId, agentId, updates) {
  const existingResult = await db.query("SELECT * FROM channels WHERE id = $1 AND agent_id = $2", [
    channelId,
    agentId,
  ]);
  const existing = existingResult.rows[0];
  if (!existing) throw new Error("Channel not found");

  const sets = [];
  const params = [];
  let idx = 1;

  if (updates.name !== undefined) {
    sets.push(`name = $${idx++}`);
    params.push(updates.name);
  }
  const rotate = updates.rotate_inbound_secret === true;
  const rotatedSecret = rotate ? generateInboundSecret() : null;
  if (updates.config !== undefined || rotate) {
    const currentConfig = revealChannelConfig(existing.type, existing.config);
    const restoredConfig =
      updates.config !== undefined
        ? restoreRedactedConfigValue(parseConfig(updates.config), currentConfig)
        : { ...currentConfig };
    // The inbound secret is server-owned: a client-supplied value is ignored and the
    // current one kept. Rotation goes through rotate_inbound_secret below.
    if (currentConfig[INBOUND_SECRET_KEY]) {
      restoredConfig[INBOUND_SECRET_KEY] = currentConfig[INBOUND_SECRET_KEY];
    } else {
      delete restoredConfig[INBOUND_SECRET_KEY];
    }
    if (rotatedSecret) restoredConfig[INBOUND_SECRET_KEY] = rotatedSecret;
    const { secured, hasSensitiveMaterial } = protectChannelConfig(existing.type, restoredConfig);
    sets.push(`config = $${idx++}`);
    params.push(JSON.stringify(secured));
    if (hasSensitiveMaterial) {
      ensureEncryptionConfigured("Channel credential storage");
    }
  }
  if (updates.enabled !== undefined) {
    sets.push(`enabled = $${idx++}`);
    params.push(updates.enabled);
  }
  if (sets.length === 0) throw new Error("No fields to update");

  params.push(channelId, agentId);
  const result = await db.query(
    `UPDATE channels SET ${sets.join(", ")} WHERE id = $${idx++} AND agent_id = $${idx} RETURNING *`,
    params,
  );
  if (!result.rows[0]) throw new Error("Channel not found");
  const channel = sanitizeChannel(result.rows[0]);
  // A rotated secret is shown once, here; later reads are redacted.
  return rotatedSecret ? { ...channel, inbound_secret: rotatedSecret } : channel;
}

async function deleteChannel(channelId, agentId) {
  const result = await db.query(
    "DELETE FROM channels WHERE id = $1 AND agent_id = $2 RETURNING id",
    [channelId, agentId],
  );
  if (!result.rows[0]) throw new Error("Channel not found");
}

// ── Messaging ────────────────────────────────────────────

/**
 * Deliver through the configured adapter and audit only successful outbound messages.
 *
 * @param {string} channelId - Enabled channel identifier.
 * @param {string} content - Message body.
 * @param {Object} [metadata={}] - Adapter options and audit metadata.
 * @returns {Promise<Object>} Adapter delivery result.
 */
async function sendMessage(channelId, content, metadata = {}) {
  const chResult = await db.query("SELECT * FROM channels WHERE id = $1", [channelId]);
  const channel = hydrateChannel(chResult.rows[0]);
  if (!channel) throw new Error("Channel not found");
  if (!channel.enabled) throw new Error("Channel is disabled");

  const adapter = getAdapter(channel.type);
  const result = await adapter.send(channel, content, metadata);

  // Some adapters (email) report failures via `delivered: false` instead of
  // throwing — surface those instead of logging a phantom outbound message.
  if (result && result.delivered === false) {
    throw new Error(result.error || `Message delivery failed for ${channel.type} channel`);
  }

  // Log the outbound message
  await db.query(
    "INSERT INTO channel_messages(channel_id, direction, content, metadata) VALUES($1, 'outbound', $2, $3)",
    [channelId, content, JSON.stringify(metadata)],
  );

  return result;
}

async function getMessages(channelId, agentId, limit = 50) {
  const result = await db.query(
    `SELECT cm.*
     FROM channel_messages cm
     JOIN channels c ON c.id = cm.channel_id
     WHERE cm.channel_id = $1 AND c.agent_id = $2
     ORDER BY cm.created_at DESC
     LIMIT $3`,
    [channelId, agentId, limit],
  );
  return result.rows;
}

// ── Testing ──────────────────────────────────────────────

/**
 * Verify channel configuration, then attempt a real test delivery.
 *
 * @param {string} channelId - Channel to test.
 * @param {string} agentId - Owning agent identifier.
 * @returns {Promise<Object>} Success or non-throwing delivery failure result.
 */
async function testChannel(channelId, agentId) {
  const chResult = await db.query("SELECT * FROM channels WHERE id = $1 AND agent_id = $2", [
    channelId,
    agentId,
  ]);
  const channel = hydrateChannel(chResult.rows[0]);
  if (!channel) throw new Error("Channel not found");

  const adapter = getAdapter(channel.type);

  // First verify config
  const verification = await adapter.verify(channel.config);
  if (!verification.valid) return { success: false, error: verification.error };

  // Then try sending a test message
  try {
    const sendResult = await adapter.send(
      channel,
      `🦞 OpenClaw test message — ${new Date().toISOString()}`,
    );
    // Non-throwing adapters (email) report failure via `delivered: false` —
    // a test must not show green over a failed delivery.
    if (sendResult && sendResult.delivered === false) {
      return { success: false, error: sendResult.error || "Test message delivery failed" };
    }
    return { success: true, message: "Test message sent successfully" };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Inbound Webhooks ─────────────────────────────────────

/**
 * Inbound webhook signing mode from HEADMASTER_INBOUND_WEBHOOK_SIGNING.
 *
 * "enforce" (the default when unset) rejects unsigned requests. "off" accepts unsigned
 * requests during a sender migration, but signed requests must still verify. Any other
 * value fails closed to "enforce" and logs an error.
 *
 * @param {Object} env - Environment to read (defaults to process.env).
 * @returns {"enforce"|"off"} The effective mode.
 */
function inboundSigningMode(env = process.env) {
  const raw = env.HEADMASTER_INBOUND_WEBHOOK_SIGNING;
  if (raw === undefined || raw === "") return "enforce";
  const value = String(raw).trim().toLowerCase();
  if (value === "enforce" || value === "off") return value;
  console.error(
    `[channels] HEADMASTER_INBOUND_WEBHOOK_SIGNING has unknown value ${JSON.stringify(String(raw).slice(0, 32))}; enforcing signatures`,
  );
  return "enforce";
}

/**
 * Format and audit a public channel webhook, then forward it to a reachable agent runtime.
 *
 * Runtime network failures become retryable 503 errors after the inbound audit row is written.
 * The request must carry a valid per-channel HMAC signature; an unknown channel, a channel
 * without an inbound secret, or a bad signature is rejected with 401 before any write or forward.
 * With HEADMASTER_INBOUND_WEBHOOK_SIGNING=off, a request with no signature headers is accepted
 * (with a warning); a request that does carry a signature must still verify.
 *
 * @param {string} channelId - Target channel identifier.
 * @param {Object} payload - Provider webhook payload.
 * @param {Object} headers - Request headers (signature and timestamp).
 * @param {Buffer} rawBody - Exact request bytes the signature covers.
 * @returns {Promise<Object>} Receipt acknowledgement.
 */
async function handleInboundWebhook(channelId, payload, headers, rawBody) {
  const chResult = await db.query("SELECT * FROM channels WHERE id = $1", [channelId]);
  const channel = hydrateChannel(chResult.rows[0]);
  const denied = new Error("Invalid webhook signature");
  denied.statusCode = 401;
  if (!channel) throw denied;
  const signed = Boolean(
    headers?.["x-webhook-signature-v2"] || headers?.["x-webhook-timestamp"],
  );
  if (signed || inboundSigningMode() === "enforce") {
    // A request that carries a signature must always verify, whatever the mode.
    if (!verifyInboundSignature(channel.config?.[INBOUND_SECRET_KEY], headers, rawBody)) throw denied;
    if (!claimInboundSignature(channelId, headers["x-webhook-signature-v2"])) throw denied;
  } else {
    console.warn(
      `[channels] accepted unsigned inbound webhook for channel ${channelId} (HEADMASTER_INBOUND_WEBHOOK_SIGNING=off)`,
    );
  }
  if (!channel.enabled) throw new Error("Channel is disabled");

  const adapter = getAdapter(channel.type);
  const formatted = adapter.formatInbound(payload);

  // Log the inbound message
  await db.query(
    "INSERT INTO channel_messages(channel_id, direction, content, metadata) VALUES($1, 'inbound', $2, $3)",
    [
      channelId,
      formatted.content,
      JSON.stringify({ sender: formatted.sender, ...formatted.metadata }),
    ],
  );

  // Forward to agent runtime if agent is running
  const agentResult = await db.query(
    "SELECT id, host, runtime_host, runtime_port, gateway_token FROM agents WHERE id = $1",
    [channel.agent_id],
  );
  const agent = agentResult.rows[0];
  const runtimeUrl = runtimeUrlForAgent(agent, "/channels/receive");
  if (runtimeUrl && agent?.host !== "pending") {
    try {
      // Bounded: a hung runtime socket must not stall the provider's webhook
      // delivery worker.
      await fetch(runtimeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await runtimeAuthHeaders(agent)) },
        body: JSON.stringify({
          channelId,
          channelType: channel.type,
          content: formatted.content,
          sender: formatted.sender,
          metadata: formatted.metadata,
        }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      // Do NOT swallow this as a 200: providers treat 2xx as delivered and
      // never retry, so the message would be silently lost exactly when the
      // agent pod is restarting. Signal "try again later" instead — the
      // inbound copy is already logged for the audit trail.
      const failure = new Error(
        `Agent runtime unreachable — webhook not delivered (${error?.message || "fetch failed"})`,
      );
      failure.statusCode = 503;
      failure.retryable = true;
      throw failure;
    }
  }

  return { received: true };
}

// ── Channel Types ────────────────────────────────────────

function getChannelTypes() {
  return listAdapterTypes();
}

module.exports = {
  listChannels,
  createChannel,
  updateChannel,
  deleteChannel,
  sendMessage,
  getMessages,
  testChannel,
  handleInboundWebhook,
  verifyInboundSignature,
  inboundSigningMode,
  getChannelTypes,
  buildCloneableChannel,
  redactChannelConfig,
  sanitizeChannel,
  protectChannelConfig,
  revealChannelConfig,
  hydrateChannel,
  stripChannelSecrets,
};
