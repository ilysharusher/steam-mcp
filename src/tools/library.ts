import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { api, day, hours, json, storeSearch, type OwnedGame } from "../steam";
import type { ToolContext } from "./context";
import { CC } from "./format";

export function registerLibraryTools(server: McpServer, { cfg, library }: ToolContext) {
  server.registerTool(
    "list_library",
    {
      title: "List library",
      description:
        "Owned games with playtime, sorted by hours played. Use min_hours/max_hours/limit to keep the output small; max_hours: 0 gives the backlog.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(25),
        min_hours: z.number().min(0).default(0),
        max_hours: z
          .number()
          .min(0)
          .optional()
          .describe("Upper bound on hours played; 0 returns the untouched backlog"),
        sort: z.enum(["playtime", "recent", "name"]).default("playtime"),
      }),
    },
    async ({ limit, min_hours, max_hours, sort }) => {
      const games = (await library()).filter((g) => {
        const h = g.playtime_forever / 60;
        return h >= min_hours && (max_hours === undefined || h <= max_hours);
      });
      // `games` is already a fresh array from filter(), so sort it in place —
      // unlike library_stats, which must copy to protect the memoised library.
      const sorted = games.sort((a, b) => {
        if (sort === "name") return (a.name ?? "").localeCompare(b.name ?? "");
        if (sort === "recent") return (b.rtime_last_played ?? 0) - (a.rtime_last_played ?? 0);
        return b.playtime_forever - a.playtime_forever;
      });

      return json({
        matched: sorted.length,
        games: sorted.slice(0, limit).map((g) => ({
          appid: g.appid,
          name: g.name,
          playtime: hours(g.playtime_forever),
          last_played: day(g.rtime_last_played),
        })),
      });
    },
  );

  server.registerTool(
    "library_stats",
    {
      title: "Library stats",
      description:
        "Aggregate view of the account: game count, total hours, unplayed count, and the top titles by playtime.",
      inputSchema: z.object({}),
    },
    async () => {
      const games = await library();

      // One descending sort feeds both the top list and the median: played games
      // occupy the front of it, so the median is an index into that prefix.
      const ranked = [...games].sort((a, b) => b.playtime_forever - a.playtime_forever);

      let totalMinutes = 0;
      let played = 0;
      for (const g of games) {
        totalMinutes += g.playtime_forever;
        if (g.playtime_forever > 0) played++;
      }

      return json({
        total_games: games.length,
        played_games: played,
        never_played: games.length - played,
        total_playtime: hours(totalMinutes),
        median_playtime_of_played: hours(
          // Upper median: index counts back from the played prefix's tail.
          played ? ranked[played - 1 - Math.floor(played / 2)].playtime_forever : 0,
        ),
        top_games: ranked
          .slice(0, 10)
          .map((g) => ({ name: g.name, playtime: hours(g.playtime_forever) })),
      });
    },
  );

  server.registerTool(
    "recently_played",
    {
      title: "Recently played",
      description: "Games played in the last two weeks, with hours for that window.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(20).default(10) }),
    },
    async ({ limit }) => {
      const d = await api<{ response: { total_count?: number; games?: OwnedGame[] } }>(
        cfg,
        "IPlayerService/GetRecentlyPlayedGames/v1/",
        { steamid: cfg.steamId, count: limit },
      );
      // Steam already tells us how many it had; passing it on stops the caller
      // from reading a truncated list as the whole fortnight.
      return json({
        total_count: d.response.total_count,
        games: (d.response.games ?? []).map((g) => ({
          appid: g.appid,
          name: g.name,
          last_2_weeks: hours(g.playtime_2weeks ?? 0),
          total: hours(g.playtime_forever),
        })),
      });
    },
  );

  server.registerTool(
    "find_game",
    {
      title: "Find game",
      description:
        "Search for a game by name and get its appid. Looks through the owned library first, then the Steam store.",
      inputSchema: z.object({ query: z.string().min(1) }),
    },
    async ({ query }) => {
      const needle = query.toLowerCase();
      const owned = (await library())
        .filter((g) => g.name?.toLowerCase().includes(needle))
        .slice(0, 10)
        .map((g) => ({
          appid: g.appid,
          name: g.name,
          playtime: hours(g.playtime_forever),
          owned: true,
        }));

      if (owned.length) return json(owned);

      const store = (await storeSearch(query, CC)).items ?? [];
      return json(store.slice(0, 10).map((i) => ({ appid: i.id, name: i.name, owned: false })));
    },
  );
}
