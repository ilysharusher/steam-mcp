import type { AuthRequest } from "@cloudflare/workers-oauth-provider";

const encoder = new TextEncoder();

/** How long a signed authorization request stays usable. Bounds replay. */
const STATE_TTL_MS = 10 * 60_000;

/** What travels through GitHub in `state`: the pending request plus its age. */
export interface StateEnvelope {
  r: AuthRequest;
  iat: number;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(payload: string, secret: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

async function verify(token: string, secret: string): Promise<string | null> {
  const idx = token.lastIndexOf(".");
  if (idx < 0) return null;
  // atob throws on non-base64. This runs on unauthenticated input, so a bad
  // signature has to read as "invalid", not as a 500.
  let sig: Uint8Array;
  try {
    sig = unb64url(token.slice(idx + 1));
  } catch {
    return null;
  }
  const payload = token.slice(0, idx);
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, encoder.encode(payload));
  return ok ? payload : null;
}

/** Signs a pending request into an opaque `state` value. */
export async function encodeState(request: AuthRequest, secret: string): Promise<string> {
  const envelope: StateEnvelope = { r: request, iat: Date.now() };
  return sign(b64url(encoder.encode(JSON.stringify(envelope))), secret);
}

/**
 * Returns the envelope only if the signature holds, the payload parses, the
 * shape is right and it is inside STATE_TTL_MS. Null covers all four failures:
 * the caller answers 400 either way, and telling an unauthenticated caller
 * which of the four it was leaks more than it helps a legitimate one.
 */
export async function decodeState(token: string, secret: string): Promise<StateEnvelope | null> {
  const payload = await verify(token, secret);
  if (!payload) return null;
  // The signature proves we produced this payload, but a secret rotation can
  // leave stale-yet-well-formed states in flight, so parse defensively.
  let envelope: StateEnvelope;
  try {
    envelope = JSON.parse(new TextDecoder().decode(unb64url(payload))) as StateEnvelope;
  } catch {
    return null;
  }
  if (!envelope?.r || typeof envelope.iat !== "number") return null;
  if (Date.now() - envelope.iat > STATE_TTL_MS) return null;
  return envelope;
}
