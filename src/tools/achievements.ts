import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  api,
  day,
  hours,
  inBatches,
  json,
  MAX_FANOUT,
  gameSchema,
  type GameStat,
  type PlayerAchievement,
} from "../steam";
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

      const [player, global, schema] = await Promise.all([
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
        // The only source of the hidden flag. Optional: without it the reply is
        // exactly what it was before, minus the labelling.
        gameSchema(cfg, appid).catch(() => null),
      ]);

      // Steam names the game in its own payload, so an appid input still gets a title.
      const title = player.playerstats?.gameName ?? name;
      const list = player.playerstats?.achievements;
      if (!list?.length) {
        return json({
          game: title,
          appid,
          note: player.playerstats?.error ?? "This game has no achievements, or stats are private.",
        });
      }

      const hidden = new Set(
        (schema?.game?.availableGameStats?.achievements ?? [])
          .filter((a) => a.hidden === 1)
          .map((a) => a.name),
      );
      const rarity = new Map(
        (global?.achievementpercentages?.achievements ?? []).map((a) => [a.name, a.percent]),
      );
      const unlocked = list.filter((a) => a.achieved === 1).length;
      const shown =
        filter === "all"
          ? list
          : list.filter((a) => (filter === "unlocked" ? a.achieved === 1 : a.achieved === 0));

      const page = shown.slice(0, limit);
      return json({
        game: title,
        appid,
        // unlocked/total describe the game; count/matched describe this reply.
        // Without matched there is no way to tell that a filter plus a limit
        // dropped achievements, because total counts the unfiltered list.
        unlocked,
        total: list.length,
        percent: Math.round((unlocked / list.length) * 100),
        count: page.length,
        ...(filter === "all" ? {} : { matched: shown.length }),
        note:
          shown.length > page.length
            ? `Showing ${page.length} of ${shown.length} ${filter === "all" ? "" : filter + " "}achievements.`
            : undefined,
        achievements: page.map((a) => ({
          name: a.name ?? a.apiname,
          description: a.description || undefined,
          // Says why the description is missing. Steam withholds the text of a
          // hidden achievement until it is unlocked, so an absent description
          // on a hidden one is by design, not a gap in this client.
          hidden: hidden.has(a.apiname) || undefined,
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
      const withStats = (await library())
        .filter((g) => g.has_community_visible_stats)
        .sort((a, b) => b.playtime_forever - a.playtime_forever);
      const games = withStats.slice(skip, skip + count);

      let failed = 0;
      const rows = await inBatches(games, async (g) => {
        try {
          const d = await api<{ playerstats: { achievements?: PlayerAchievement[] } }>(
            cfg,
            "ISteamUserStats/GetPlayerAchievements/v1/",
            { steamid: cfg.steamId, appid: g.appid },
          );
          const list = d.playerstats?.achievements ?? [];
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
          // Steam refusing and a game having no achievements are different
          // facts. Conflating them lets a run where every call failed read as
          // a clean answer.
          failed++;
          return null;
        }
      });

      const rowsWithData = rows.filter(Boolean);
      return json({
        // total_with_stats is what skip pages through. Without it an empty
        // answer at skip: 20 is indistinguishable from a broken call.
        count: rowsWithData.length,
        examined: games.length,
        total_with_stats: withStats.length,
        games: rowsWithData,
        ...(failed ? { failed } : {}),
        note: progressNote(games.length, rowsWithData.length, failed),
      });
    },
  );

  server.registerTool(
    "game_stats",
    {
      title: "Lifetime stats for a game",
      description:
        "Lifetime counters Steam keeps for one game — kills, wins, time played, per-map and per-weapon totals. Distinct from achievements, which are only unlocked/locked. Coverage is uneven and set by the developer, not by Steam: CS2 reports 184 self-describing counters, many games report none, and some report opaque names like `stat_25` or `AchievementStat_3` that carry no meaning. Use `match` to narrow a large set.",
      inputSchema: z.object({
        game: z.string().min(1),
        match: z
          .string()
          .optional()
          .describe("Case-insensitive substring of the stat name, e.g. 'kills' or 'map_de'"),
        limit: z.number().int().min(1).max(200).default(40),
      }),
    },
    async ({ game, match, limit }) => {
      const { appid, name } = await resolve(game);

      // An unknown appid answers 400 with an empty body; a known game without
      // stats answers 200 and simply omits the array. Both are answers.
      const d = await api<{ playerstats?: { gameName?: string; stats?: GameStat[] } }>(
        cfg,
        "ISteamUserStats/GetUserStatsForGame/v2/",
        { steamid: cfg.steamId, appid },
        [400],
      );

      // Steam names the game in its own payload, so an appid input still gets a title.
      const title = d.playerstats?.gameName ?? name;
      const all = d.playerstats?.stats ?? [];
      if (!all.length) {
        return json({
          game: title,
          appid,
          note: "Steam keeps no stats for this game, or the profile's game details are private.",
        });
      }

      const needle = match?.toLowerCase();
      const matching = needle ? all.filter((s) => s.name.toLowerCase().includes(needle)) : all;
      const page = matching.slice(0, limit);

      const notes: string[] = [];
      if (needle && !matching.length) {
        notes.push(`No stat name contains "${match}". Call without \`match\` to see what exists.`);
      }
      if (matching.length > page.length) {
        notes.push(`Showing ${page.length} of ${matching.length} matching counters.`);
      }

      return json({
        game: title,
        appid,
        count: page.length,
        ...(needle ? { matched: matching.length } : {}),
        total_stats: all.length,
        note: notes.length ? notes.join(" ") : undefined,
        // Steam's own order leads with the headline totals, so it is kept. An
        // object rather than a list of {name, value} pairs: same data, roughly
        // half the tokens, and 184 of them is the case this tool is built for.
        stats: Object.fromEntries(page.map((s) => [s.name, s.value])),
      });
    },
  );
}

/**
 * Distinguishes "Steam has nothing for this game" from "Steam would not answer".
 * The second is not a fact about the library and must not be reported as one.
 */
function progressNote(examined: number, returned: number, failed: number): string | undefined {
  const empty = examined - returned - failed;
  const parts: string[] = [];
  if (failed) parts.push(`${failed} of the ${examined} games examined could not be read from Steam`);
  if (empty > 0) parts.push(`${empty} reported no achievements`);
  return parts.length ? `${parts.join("; ")}.` : undefined;
}
