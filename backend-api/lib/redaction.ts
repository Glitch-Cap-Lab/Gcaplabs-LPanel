// @ts-nocheck
// Shared by upgrade output, HTTP diagnostics and audit persistence. Never log a
// redaction failure with its original value: hostile getters and oversized
// structures must become bounded markers rather than a second disclosure path.
const REDACTED = "[redacted]";
const FAILED = "[redaction failed]";
const MAX_TEXT = 16384;
const MAX_ENTRIES = 128;
const MAX_NODES = 2048;

function isCredentialName(name) {
  const normalized = String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  return /(?:^|[-_])(?:password|passwd|secret|token|api_key|apikey|private_key|encryption_key|authorization|cookie|cookies|credentials|signature|key|card_number|cardnumber|pan|cvv|cvc|card_security(?:_code)?)$/.test(
    normalized,
  );
}

function isPaymentCardNumber(value) {
  const digits = value.replace(/[ -]/g, "");
  if (
    digits.length < 13 ||
    digits.length > 19 ||
    !/^(?:4|5[1-5]|2[2-7]|3[47]|6)/.test(digits) ||
    /^(\d)\1+$/.test(digits)
  )
    return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index--) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function addSecret(values, value) {
  if (typeof value !== "string" || value.length < 4) return;
  if (value.length > MAX_TEXT || values.size >= 256) throw new Error("Redaction limit");
  values.add(value);
  values.add(encodeURIComponent(value));
}

function environmentSecrets(env) {
  const values = new Set();
  for (const [name, value] of Object.entries(env)) {
    if (isCredentialName(name) || name === "NORA_UPGRADE_REPO") {
      addSecret(values, value);
      if (typeof value === "string") {
        addSecret(values, value.trim());
        if (name === "ENCRYPTION_KEY") addSecret(values, value.split("#")[0].trim());
      }
    }
    if (typeof value === "string" && /(?:url|dsn)$/i.test(name) && value.includes("://")) {
      let password;
      try {
        password = decodeURIComponent(new URL(value).password);
      } catch {
        /* A malformed URL is still sanitized by the text boundary. */
      }
      if (password) addSecret(values, password);
    }
  }
  return values;
}

function redactText(input, env = process.env, secrets = []) {
  try {
    let output = String(input ?? "");
    if (output.length > MAX_TEXT) return "[redacted: oversized text]";
    const values = environmentSecrets(env);
    for (const value of secrets) addSecret(values, value);
    output = output
      .replace(
        /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
        REDACTED,
      )
      .replace(/\b(?:\d[ -]?){12,18}\d\b/g, (candidate) =>
        isPaymentCardNumber(candidate) ? REDACTED : candidate,
      )
      .replace(/[a-z][a-z\d+.-]*:\/\/[^\s<>"']+/gi, (raw) => {
        try {
          const url = new URL(raw);
          if (!url.username && !url.password && !url.search && !url.hash) return raw;
          url.username = "";
          url.password = "";
          url.search = "";
          url.hash = "";
          return url.toString();
        } catch {
          return REDACTED;
        }
      })
      .replace(/(\/[^\s?]*)\?[^\s#]*/g, "$1?[redacted]")
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
      .replace(
        /((?:["']?)[\w-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credentials|signature|key|card[_-]?number|pan|cvv|cvc|card[_-]?security(?:[_-]?code)?)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
        "$1[redacted]",
      )
      .replace(
        /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g,
        REDACTED,
      );
    for (const value of [...values].sort((a, b) => b.length - a.length))
      output = output.split(value).join(REDACTED);
    return output;
  } catch {
    return FAILED;
  }
}

function redactValue(value, { env = process.env, secrets = [] } = {}) {
  let nodes = 0;
  let textSize = 0;
  const seen = new WeakSet();
  function visit(entry, depth, cardContext = false) {
    if (++nodes > MAX_NODES) throw new Error("Redaction limit");
    if (depth > 8) return "[max-depth]";
    if (typeof entry === "string") {
      textSize += entry.length;
      if (textSize > 65536) throw new Error("Redaction limit");
      return redactText(entry, env, secrets);
    }
    if (typeof entry === "number")
      return Number.isInteger(entry) && isPaymentCardNumber(String(entry)) ? REDACTED : entry;
    if (entry == null || typeof entry === "boolean") return entry;
    if (typeof entry === "bigint") return visit(entry.toString(), depth + 1);
    if (typeof entry !== "object") return "[unsupported]";
    if (seen.has(entry)) return "[circular]";
    seen.add(entry);
    if (entry instanceof Date) return entry.toISOString();
    if (Buffer.isBuffer(entry)) return "[binary]";
    if (Array.isArray(entry) && entry.length > MAX_ENTRIES) return "[redacted: oversized array]";
    if (
      !Array.isArray(entry) &&
      !(entry instanceof Error) &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(entry))
    )
      return "[unsupported]";
    const source =
      entry instanceof Error
        ? {
            name: entry.name,
            message: entry.message,
            code: entry.code,
            statusCode: entry.statusCode || entry.status,
            stack: entry.stack,
            cause: entry.cause,
          }
        : entry;
    const entries = Object.entries(source);
    if (entries.length > MAX_ENTRIES) return "[redacted: oversized object]";
    if (Array.isArray(source)) return source.map((child) => visit(child, depth + 1, cardContext));
    const output = {};
    for (const [key, child] of entries) {
      const safeKey = redactText(key, env, secrets);
      let safeChild;
      if (/^(?:origin|referer|referrer)$/i.test(key) && typeof child === "string") {
        if (child.length > MAX_TEXT) safeChild = "[redacted: oversized text]";
        else {
          try {
            safeChild = redactText(new URL(child).origin, env, secrets);
          } catch {
            safeChild = REDACTED;
          }
        }
      } else
        safeChild =
          isCredentialName(key) || (cardContext && key.toLowerCase() === "number")
            ? REDACTED
            : visit(child, depth + 1, /^(?:card|payment_card|paymentCard)$/i.test(key));
      Object.defineProperty(output, safeKey, {
        value: safeChild,
        enumerable: true,
      });
    }
    return output;
  }
  try {
    return visit(value, 0);
  } catch {
    return FAILED;
  }
}

function requestSecrets(req) {
  const values = new Set();
  const seen = new WeakSet();
  let nodes = 0;
  function collect(value, all = false, depth = 0) {
    if (++nodes > MAX_NODES || depth > 8) throw new Error("Redaction limit");
    if (typeof value === "string") {
      if (all) addSecret(values, value);
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const entries = Object.entries(value);
    if (entries.length > MAX_ENTRIES) throw new Error("Redaction limit");
    for (const [key, child] of entries)
      collect(child, all || isCredentialName(key) || key === "email", depth + 1);
  }
  collect(req?.query, true);
  collect(req?.params);
  collect(req?.headers);
  let body = req?.body;
  if (Buffer.isBuffer(body)) {
    if (body.length > MAX_TEXT) throw new Error("Redaction limit");
    try {
      body = JSON.parse(body.toString("utf8"));
    } catch {
      body = null;
    }
  }
  collect(body);
  const authorization = req?.headers?.authorization;
  if (typeof authorization === "string") addSecret(values, authorization.replace(/^\S+\s+/, ""));
  const cookie = req?.headers?.cookie;
  if (typeof cookie === "string")
    for (const part of cookie.split(";"))
      addSecret(values, part.slice(part.indexOf("=") + 1).trim());
  return [...values];
}

function redactForRequest(value, req) {
  try {
    return redactValue(value, { secrets: requestSecrets(req) });
  } catch {
    return FAILED;
  }
}

function requestPath(req) {
  try {
    const path = String(req?.originalUrl || req?.path || "/").split(/[?#]/, 1)[0];
    return redactForRequest(path, req);
  } catch {
    return FAILED;
  }
}

module.exports = { isCredentialName, redactText, redactValue, redactForRequest, requestPath };
