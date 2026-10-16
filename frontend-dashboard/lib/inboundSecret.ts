/**
 * Helpers for a channel's inbound webhook signing secret.
 *
 * The server stores the secret encrypted and always returns it redacted, so the
 * only time the browser ever holds the plain value is right after it created or
 * rotated it. These helpers keep that value in a single "reveal" object that the
 * UI drops as soon as the person closes the dialog.
 */

export const REDACTED_SECRET = "[REDACTED]";
export const INBOUND_SECRET_KEY = "inbound_secret";

type RandomSource = Pick<Crypto, "getRandomValues">;

/** 32 random bytes as 64 hex characters (the server accepts 16 or more). */
export function generateInboundSecret(source: RandomSource = globalThis.crypto): string {
  const bytes = source.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

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

/**
 * PATCH body that rotates the secret. The rest of the config is sent back as
 * the server returned it (secrets still redacted), which the server restores
 * from the stored copy, so nothing else changes.
 */
export function buildRotationBody(config: Record<string, unknown> | undefined, secret: string) {
  return { config: { ...(config || {}), [INBOUND_SECRET_KEY]: secret } };
}
