// @ts-nocheck
const crypto = require("crypto");
const { redactForRequest, requestPath } = require("../lib/redaction");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Structured application error with status code and error code.
 */
class AppError extends Error {
  constructor(message, statusCode = 500, code = "INTERNAL_ERROR", options = {}) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.expose = options.expose ?? statusCode < 500;
    this.name = "AppError";
  }
}

/**
 * Middleware: attach a correlation ID to every request.
 * Clients can pass x-correlation-id to trace across services.
 */
function correlationId(req, res, next) {
  const supplied = req.headers["x-correlation-id"];
  req.correlationId =
    typeof supplied === "string" &&
    UUID.test(supplied) &&
    redactForRequest(supplied, req) === supplied
      ? supplied
      : crypto.randomUUID();
  res.setHeader("x-correlation-id", req.correlationId);
  next();
}

/**
 * Wrap async route handlers so rejected promises are forwarded to Express error handler.
 */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Central error handler — must be registered LAST (after all routes).
 * - Logs bounded, redacted diagnostics with correlation ID
 * - Hides internal error details from clients unless explicitly exposed
 * - Preserves explicit status codes from AppError
 */
function errorHandler(err, req, res, _next) {
  let status = 500;
  let code = "INTERNAL_ERROR";
  let expose = false;
  let diagnostic = { name: "Error", message: "Error details unavailable" };
  try {
    const candidateStatus = err.statusCode || err.status;
    if (Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus <= 599)
      status = candidateStatus;
    const safe = redactForRequest(
      {
        name: err.name || "Error",
        message: err.message,
        stack: err.stack,
        cause: err.cause,
        code: err.code,
      },
      req,
    );
    if (safe && typeof safe === "object") diagnostic = safe;
    if (typeof diagnostic.message !== "string") diagnostic.message = "Error details unavailable";
    if (typeof diagnostic.code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(diagnostic.code))
      code = diagnostic.code;
    expose = err.expose === true || status < 500;
  } catch {
    /* No original value may escape a failed diagnostic/redaction read. */
  }
  const cid =
    UUID.test(req.correlationId || "") &&
    redactForRequest(req.correlationId, req) === req.correlationId
      ? req.correlationId
      : crypto.randomUUID();
  req.correlationId = cid;
  if (!res.headersSent) res.setHeader("x-correlation-id", cid);
  console.error({
    correlationId: cid,
    method: req.method,
    path: requestPath(req),
    status,
    error: diagnostic,
  });
  res.locals.auditError = { ...diagnostic, code, statusCode: status };

  if (res.headersSent) return;

  // 4xx messages are intentionally exposed. 5xx messages stay generic unless
  // a route marks the error as exposed for expected operator-facing failures,
  // such as missing backup storage configuration.
  res.status(status).json({
    error: expose ? diagnostic.message || "Request failed" : "Internal server error",
    code,
    correlationId: cid,
  });
}

module.exports = { AppError, correlationId, asyncHandler, errorHandler };
