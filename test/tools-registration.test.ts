import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { registerTools } from "../src/tools";

const CFG = { apiKey: "k", steamId: "76561198000000000" };

const EXPECTED = [
  "achievement_progress",
  "find_game",
  "friends",
  "game_details",
  "get_achievements",
  "get_news",
  "library_stats",
  "list_library",
  "player_count",
  "profile_status",
  "recently_played",
  "wishlist",
];

/** Reaches past the public surface: the SDK exposes no tool listing locally. */
function registeredNames(server: McpServer): string[] {
  const registered = (server as unknown as { _registeredTools: Record<string, unknown> })
    ._registeredTools;
  return Object.keys(registered).sort();
}

describe("registerTools", () => {
  it("registers exactly the twelve documented tools", () => {
    const server = new McpServer({ name: "steam-mcp", version: "test" });
    registerTools(server, CFG);
    expect(registeredNames(server)).toEqual(EXPECTED);
  });

  it("registers a fresh set on a second server, sharing nothing", () => {
    const a = new McpServer({ name: "steam-mcp", version: "test" });
    const b = new McpServer({ name: "steam-mcp", version: "test" });
    registerTools(a, CFG);
    registerTools(b, CFG);
    expect(registeredNames(a)).toEqual(registeredNames(b));
  });
});
