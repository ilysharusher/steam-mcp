import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/** Authenticated user data attached to the token by the OAuth provider. */
export interface Props extends Record<string, unknown> {
  login: string;
  name: string;
  githubId: number;
}

export interface Env {
  // Bindings
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;

  // Vars (wrangler.jsonc; .dev.vars overrides locally)
  ALLOWED_GITHUB_LOGINS: string;
  /** This deployment's own /mcp URL. Pins the audience of issued tokens. */
  MCP_RESOURCE_URL?: string;

  // Secrets (wrangler secret put)
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  AUTH_STATE_SECRET: string;
  STEAM_API_KEY: string;
  STEAM_ID: string;
}
