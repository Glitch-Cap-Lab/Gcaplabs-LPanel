/**
 * Helpers for a channel's inbound webhook signing secret.
 *
 * The server stores the secret encrypted and always returns it redacted, so the
 * only time the browser ever holds the plain value is right after the server created or
 * rotated it. These helpers keep that value in a single "reveal" object that the
 * UI drops as soon as the person closes the dialog.
 */

export const REDACTED_SECRET = "[REDACTED]";
export const INBOUND_SECRET_KEY = "inbound_secret";

export type SecretReveal = {
  channelName: string;
  secret: string;
  reason: "created" | "rotated";
};

/** The signing secret in a create response, or null when there is none to show. */
export function revealFromCreateResponse(data: unknown, channelName: string): SecretReveal | null {
  const secret = (data as { inbound_secret?: unknown } | null)?.inbound_secret;
  if (typeof secret !== "string" || !secret || secret === REDACTED_SECRET) return null;
  return { channelName, secret, reason: "created" };
}

/** PATCH body that asks the server to rotate the secret; the server generates it. */
export const ROTATION_BODY = Object.freeze({ rotate_inbound_secret: true });

/** The new secret in a rotate response, or null when there is none to show. */
export function revealFromRotateResponse(data: unknown, channelName: string): SecretReveal | null {
  const reveal = revealFromCreateResponse(data, channelName);
  return reveal ? { ...reveal, reason: "rotated" } : null;
}
