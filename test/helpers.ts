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
      lookupClient: async () => ({
        clientId: "test-client",
        clientName: "Test Client",
        redirectUris: ["https://client.example/callback"],
        tokenEndpointAuthMethod: "none",
      }),
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

// ---------------------------------------------------------------------------
// Tool harness
// ---------------------------------------------------------------------------

import { McpServer } from "@modelcontextprotocol/server";
import { vi } from "vitest";
import type { SteamConfig } from "../src/steam";
import { registerTools } from "../src/tools";

export const CFG: SteamConfig = { apiKey: "test-key", steamId: "76561198000000000" };

type ToolResult = { content: Array<{ text: string }> };

/**
 * Calls one tool the way the server would. The SDK exposes no local listing, so
 * this reaches the registry; it fails loudly rather than silently if the shape
 * changes, because Object.values on undefined throws.
 */
export async function callTool<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown> = {},
  cfg: SteamConfig = CFG,
): Promise<T> {
  const server = new McpServer({ name: "test", version: "test" });
  registerTools(server, cfg);
  const registry = (
    server as unknown as { _registeredTools: Record<string, Record<string, unknown>> }
  )._registeredTools;
  const entry = registry[name];
  if (!entry) throw new Error(`no such tool: ${name}; have ${Object.keys(registry).join(", ")}`);
  const callback = Object.values(entry).find((v) => typeof v === "function") as (
    a: unknown,
    b: unknown,
  ) => Promise<ToolResult>;
  return JSON.parse((await callback(args, {})).content[0].text) as T;
}

/** One owned game, with the fields the library tools actually read. */
export function game(over: Partial<Record<string, unknown>> = {}) {
  return {
    appid: 10,
    name: "Counter-Strike",
    playtime_forever: 600,
    rtime_last_played: 1_700_000_000,
    has_community_visible_stats: true,
    ...over,
  };
}

/**
 * Routes stubbed fetches by URL fragment. Each handler returns the JSON body;
 * a fresh Response is built per call, because a reused one has its body
 * consumed by the first read.
 */
export function stubRoutes(routes: Record<string, unknown | (() => unknown)>) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [fragment, body] of Object.entries(routes)) {
      if (url.includes(fragment)) {
        return Response.json(typeof body === "function" ? (body as () => unknown)() : body);
      }
    }
    return Response.json({});
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
