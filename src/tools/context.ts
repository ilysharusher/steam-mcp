import { api, SteamError, storeSearch, type OwnedGame, type SteamConfig } from "../steam";
import { CC } from "./format";

export interface ToolContext {
  cfg: SteamConfig;
  library(): Promise<OwnedGame[]>;
  resolve(game: string): Promise<{ appid: number; name: string | null }>;
}

/**
 * MUST be called per request, from inside the createMcpHandler factory — never
 * at module scope. The memo below is scoped to one request on purpose. A Workers
 * isolate serves many requests, so a module-level context would pin one library
 * fetch forever and keep serving it as fresh data, with nothing in any log to
 * show for it.
 */
export function createContext(cfg: SteamConfig): ToolContext {
  // Per-request memo. The Worker is stateless, so this lives for one request
  // only; it exists to stop a single tool call from fetching the library twice.
  let libraryMemo: Promise<OwnedGame[]> | null = null;

  const library = (): Promise<OwnedGame[]> => {
    libraryMemo ??= api<{ response: { games?: OwnedGame[] } }>(
      cfg,
      "IPlayerService/GetOwnedGames/v1/",
      { steamid: cfg.steamId, include_appinfo: true, include_played_free_games: true },
    ).then((d) => {
      const games = d.response.games ?? [];
      if (!games.length) {
        throw new SteamError(
          "Steam returned an empty library. This almost always means 'Game details' is not set to Public in the profile's privacy settings.",
        );
      }
      return games;
    });
    return libraryMemo;
  };

  /**
   * Accepts an appid or a game name; prefers the owned library over the store.
   * A numeric input needs no lookup, so the name comes back null instead of a
   * made-up `app 730` — callers that get a real name in their own payload should
   * use that.
   */
  async function resolve(game: string): Promise<{ appid: number; name: string | null }> {
    if (/^\d+$/.test(game)) return { appid: Number(game), name: null };

    const needle = game.toLowerCase();
    // A private or empty library must not block a store lookup. Tools that
    // genuinely need the library still raise the descriptive error themselves.
    const games = await library().catch(() => [] as OwnedGame[]);
    const exact = games.find((g) => g.name?.toLowerCase() === needle);
    // Shortest substring wins: "half-life" has three candidates in this library,
    // and picking whichever Steam listed first is arbitrary.
    const partial = games
      .filter((g) => g.name?.toLowerCase().includes(needle))
      .sort((a, b) => (a.name?.length ?? 0) - (b.name?.length ?? 0))[0];
    const hit = exact ?? partial;
    if (hit?.name) return { appid: hit.appid, name: hit.name };

    const first = (await storeSearch(game, CC)).items?.[0];
    if (!first) throw new SteamError(`No game matched "${game}".`);
    return { appid: first.id, name: first.name };
  }

  return { cfg, library, resolve };
}
