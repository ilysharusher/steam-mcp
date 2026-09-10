import type { Env } from "../src/types";

/** A parsed authorization request, shaped like what the provider hands back. */
export const AUTH_REQUEST = {
  clientId: "test-client",
  redirectUri: "https://client.example/callback",
  scope: ["steam:read"],
  state: "client-state",
  codeChallenge: "challenge",
  codeChallengeMethod: "S256",
  responseType: "code",
};

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Builds a signed state envelope the way the server does, without importing the
 * server's own signer. That is deliberate: these tests pin the wire format, so
 * a refactor that changes it fails here instead of in production.
 */
export async function signState(
  request: unknown,
  secret: string,
  iat: number = Date.now(),
): Promise<string> {
  const encoder = new TextEncoder();
  const body = b64url(encoder.encode(JSON.stringify({ r: request, iat })));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

/** Minimal env. Bindings the code never touches at runtime are cast, not built. */
export function fakeEnv(over: Partial<Env> = {}): Env {
  return {
    OAUTH_KV: {} as KVNamespace,
    OAUTH_PROVIDER: {
      parseAuthRequest: async () => AUTH_REQUEST,
      lookupClient: async () => ({ clientId: "test-client", clientName: "Test Client" }),
      completeAuthorization: async () => ({
        redirectTo: "https://client.example/callback?code=abc",
      }),
    } as unknown as Env["OAUTH_PROVIDER"],
    ALLOWED_GITHUB_LOGINS: "ilysharusher",
    MCP_RESOURCE_URL: "https://mcp.example/mcp",
    GITHUB_CLIENT_ID: "gh-client",
    GITHUB_CLIENT_SECRET: "gh-secret",
    AUTH_STATE_SECRET: "test-secret-value",
    STEAM_API_KEY: "steam-key",
    STEAM_ID: "76561198000000000",
    ...over,
  };
}
