/**
 * Steam MCP server on Cloudflare Workers.
 *
 * Stateless Streamable HTTP via the Agents SDK `createMcpHandler`, wrapped in
 * OAuth 2.1 with GitHub as the identity provider. No Durable Objects: the
 * deprecated stateful `McpAgent` path is deliberately not used.
 */
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/server";
import { allowlist, authHandler } from "./auth";
import { registerTools } from "./tools";
import type { Env, Props } from "./types";

export class SteamMcp extends WorkerEntrypoint<Env, Props> {
  async fetch(request: Request): Promise<Response> {
    // The allowlist is checked again here, not just at sign-in. Grants outlive a
    // config change, so without this a login removed from ALLOWED_GITHUB_LOGINS
    // would keep working until its token expired. Costs no subrequest: props are
    // already decrypted by the provider.
    const allowed = allowlist(this.env);
    if (allowed.length && !allowed.includes(this.ctx.props.login.toLowerCase())) {
      return new Response("Forbidden", { status: 403 });
    }

    const handler = createMcpHandler(
      () => {
        const server = new McpServer({ name: "steam-mcp", version: "0.3.0" });
        registerTools(server, {
          apiKey: this.env.STEAM_API_KEY,
          steamId: this.env.STEAM_ID,
        });
        return server;
      },
    );

    return handler.fetch(request);
  }
}

/**
 * Built lazily because `resourceMetadata.resource` has to name this deployment's
 * own URL, which only exists on `env`. Memoised per isolate: the constructor
 * just stores options, but there is no reason to redo it per request.
 */
let provider: OAuthProvider<Env> | undefined;

function getProvider(env: Env): OAuthProvider<Env> {
  provider ??= new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: SteamMcp,
    defaultHandler: authHandler,

    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",

    scopesSupported: ["steam:read"],

    // Pins issued tokens to this resource, so a token minted for some other
    // server cannot be replayed here. Omitted when unset so a misconfigured
    // local run degrades to the old unbound behaviour instead of refusing
    // every request.
    ...(env.MCP_RESOURCE_URL
      ? {
          resourceMetadata: {
            resource: env.MCP_RESOURCE_URL,
            scopes_supported: ["steam:read"],
          },
        }
      : {}),

    // CIMD is the 2026-07-28 way to identify clients; DCR stays on as a fallback
    // for clients that have not migrated yet.
    clientIdMetadataDocumentEnabled: true,
    clientRegistrationEndpoint: "/oauth/register",
  });
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return getProvider(env).fetch(request, env, ctx);
  },
};
