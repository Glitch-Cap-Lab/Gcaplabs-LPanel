// @ts-nocheck
// AES-256-GCM encryption for sensitive data at rest (integration tokens, etc.)

const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
// Extract just the 64-char hex key — strip inline comments and whitespace
const RAW_KEY = (process.env.ENCRYPTION_KEY || "").split("#")[0].trim();
const ENCRYPTION_KEY = /^[0-9a-fA-F]{64}$/.test(RAW_KEY) ? RAW_KEY : null;

function isEncryptionConfigured() {
  return Boolean(ENCRYPTION_KEY);
}

// Same rule as backend-api/server.ts: in production a missing or invalid
// ENCRYPTION_KEY is fatal, unless the operator explicitly opts out with
// NORA_ALLOW_PLAINTEXT_SECRETS=true. Called once when the worker starts.
function assertEncryptionConfiguredForStart({ env = process.env, exit = process.exit, log = console.error } = {}) {
  if (isEncryptionConfigured() || env.NODE_ENV !== "production") return;
  if (env.NORA_ALLOW_PLAINTEXT_SECRETS === "true") return;
  log(
    "FATAL: ENCRYPTION_KEY is not set (or is not a 64-char hex key) in production. " +
      "The provisioner would store gateway tokens unencrypted. " +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" " +
      "and set it in .env. To intentionally run without encryption at rest, set NORA_ALLOW_PLAINTEXT_SECRETS=true.",
  );
  exit(1);
}

if (!ENCRYPTION_KEY) {
  console.error(
    "SECURITY WARNING: ENCRYPTION_KEY is not set or invalid. " +
      "Sensitive data (API keys, tokens) will be stored in PLAINTEXT. " +
      "Set a 64-char hex key in .env to enable encryption at rest.",
  );
}

/**
 * Encrypt plaintext. Returns "iv:authTag:ciphertext" hex string.
 * Without ENCRYPTION_KEY, returns plaintext only outside production or when
 * NORA_ALLOW_PLAINTEXT_SECRETS=true; in production it throws instead.
 */
function encrypt(text) {
  if (!text) return text;
  if (!ENCRYPTION_KEY) {
    if (process.env.NODE_ENV === "production" && process.env.NORA_ALLOW_PLAINTEXT_SECRETS !== "true") {
      throw new Error("ENCRYPTION_KEY is not configured; refusing to store a secret in plaintext");
    }
    return text;
  }
  const key = Buffer.from(ENCRYPTION_KEY, "hex");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

class DecryptionError extends Error {
  constructor(message) {
    super(message);
    this.name = "DecryptionError";
  }
}

/**
 * Decrypt "iv:authTag:ciphertext" string back to plaintext.
 * Returns as-is when ENCRYPTION_KEY is unset, data is empty, or the string
 * doesn't have the expected three-part shape (pre-encryption legacy rows).
 * Throws DecryptionError when the shape matches but authenticated decryption
 * fails — we must never hand ciphertext to the provisioner (it would land in
 * container env vars masquerading as a credential).
 */
function decrypt(data) {
  if (!ENCRYPTION_KEY || !data) return data;
  const parts = data.split(":");
  if (parts.length !== 3) return data; // not encrypted (legacy row)
  const [ivHex, authTagHex, encrypted] = parts;
  try {
    const key = Buffer.from(ENCRYPTION_KEY, "hex");
    const iv = Buffer.from(ivHex, "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (err) {
    console.error("Decryption failed (key mismatch or corrupted data):", err.message);
    throw new DecryptionError(
      "Failed to decrypt stored credential — encryption key may have rotated or data is corrupted",
    );
  }
}

module.exports = {
  encrypt,
  decrypt,
  isEncryptionConfigured,
  assertEncryptionConfiguredForStart,
  DecryptionError,
};
