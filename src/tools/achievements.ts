import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { api, day, hours, inBatches, json, MAX_FANOUT, type PlayerAchievement } from "../steam";
import type { ToolContext } from "./context";

export function registerAchievementTools(server: McpServer, { cfg, library, resolve }: ToolContext) {
  server.registerTool(
    "get_achievements",
    {
      title: "Achievements for a game",
      description:
        "Achievement progress for one game, including how rare each achievement is across all players.",
      inputSchema: z.object({
        game: z.string().min(1),
        filter: z.enum(["all", "locked", "unlocked"]).default("all"),
        limit: z.number().int().min(1).max(200).default(60),
      }),
    },
    async ({ game, filter, limit }) => {
      const { appid, name } = await resolve(game);

      const [player, global] = await Promise.all([
        api<{
          playerstats: { achievements?: PlayerAchievement[]; error?: string; gameName?: string };
        }>(
          cfg,
          "ISteamUserStats/GetPlayerAchievements/v1/",
          { steamid: cfg.steamId, appid, l: "english" },
          // Steam says "no stats for this app" with 400 plus a body, so that
          // status is an answer here, not a transport failure.
          [400],
        ),
        api<{
          achievementpercentages: { achievements?: Array<{ name: string; percent: number }> };
        }>(cfg, "ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/", {
          gameid: appid,
        }).catch(() => null),
      ]);

      // Steam names the game in its own payload, so an appid input still gets a title.
      const title = player.playerstats.gameName ?? name;
      const list = player.playerstats.achievements;
      if (!list?.length) {
        return json({
          game: title,
          appid,
          note: player.playerstats.error ?? "This game has no achievements, or stats are private.",
        });
      }

      const rarity = new Map(
        (global?.achievementpercentages.achievements ?? []).map((a) => [a.name, a.percent]),
      );
      const unlocked = list.filter((a) => a.achieved === 1).length;
      const shown =
        filter === "all"
          ? list
          : list.filter((a) => (filter === "unlocked" ? a.achieved === 1 : a.achieved === 0));

      return json({
        game: title,
        appid,
        unlocked,
        total: list.length,
        percent: Math.round((unlocked / list.length) * 100),
        achievements: shown.slice(0, limit).map((a) => ({
          name: a.name ?? a.apiname,
          description: a.description || undefined,
          unlocked: a.achieved === 1,
          unlocked_at: day(a.unlocktime),
          global_percent: rarity.has(a.apiname)
            ? Math.round(rarity.get(a.apiname)! * 10) / 10
            : undefined,
        })),
      });
    },
  );

  server.registerTool(
    "achievement_progress",
    {
      title: "Achievement progress across games",
      description:
        `Completion percentage across the most-played games. Capped at ${MAX_FANOUT} games per call because each game costs one upstream request.`,
      inputSchema: z.object({
        count: z.number().int().min(1).max(MAX_FANOUT).default(10),
        skip: z.number().int().min(0).default(0).describe("Offset into the playtime ranking"),
      }),
    },
    async ({ count, skip }) => {
      const games = (await library())
        .filter((g) => g.has_community_visible_stats)
        .sort((a, b) => b.playtime_forever - a.playtime_forever)
        .slice(skip, skip + count);

      const rows = await inBatches(games, async (g) => {
        try {
          const d = await api<{ playerstats: { achievements?: PlayerAchievement[] } }>(
            cfg,
            "ISteamUserStats/GetPlayerAchievements/v1/",
            { steamid: cfg.steamId, appid: g.appid },
          );
          const list = d.playerstats.achievements ?? [];
          if (!list.length) return null;
          const got = list.filter((a) => a.achieved === 1).length;
          return {
            name: g.name,
            appid: g.appid,
            playtime: hours(g.playtime_forever),
            unlocked: got,
            total: list.length,
            percent: Math.round((got / list.length) * 100),
          };
        } catch {
          return null;
        }
      });

      return json({ examined: games.length, games: rows.filter(Boolean) });
    },
  );
}
