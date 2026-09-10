import type { McpServer } from "@modelcontextprotocol/server";
import type { SteamConfig } from "../steam";
import { registerAchievementTools } from "./achievements";
import { createContext } from "./context";
import { registerLibraryTools } from "./library";
import { registerSocialTools } from "./social";
import { registerStoreTools } from "./store";
import { registerWishlistTools } from "./wishlist";

/**
 * Called from inside the createMcpHandler factory, so the context — and the
 * library memo it holds — lasts exactly one request. Do not hoist the
 * createContext call to module scope.
 */
export function registerTools(server: McpServer, cfg: SteamConfig) {
  const ctx = createContext(cfg);
  registerLibraryTools(server, ctx);
  registerAchievementTools(server, ctx);
  registerStoreTools(server, ctx);
  registerWishlistTools(server, ctx);
  registerSocialTools(server, ctx);
}
