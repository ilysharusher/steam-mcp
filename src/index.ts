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
import { authHandler } from "./auth";
import { registerTools } from "./tools";
import type { Env, Props } from "./types";

export class SteamMcp extends WorkerEntrypoint<Env, Props> {
  async fetch(request: Request): Promise<Response> {
    const handler = createMcpHandler(
      () => {
        const server = new McpServer({ name: "steam-mcp", version: "0.1.0" });
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

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: SteamMcp,
  defaultHandler: authHandler,

  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",

  scopesSupported: ["steam:read"],

  // CIMD is the 2026-07-28 way to identify clients; DCR stays on as a fallback
  // for clients that have not migrated yet.
  clientIdMetadataDocumentEnabled: true,
  clientRegistrationEndpoint: "/oauth/register",
});
