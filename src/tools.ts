import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  api,
  day,
  hours,
  inBatches,
  json,
  MAX_FANOUT,
  type AppDetails,
  type OwnedGame,
  type PlayerAchievement,
  type SteamConfig,
  SteamError,
  storeDetails,
  storeSearch,
  type WishlistItem,
  wishlistData,
} from "./steam";

/** Storefront country code — affects prices only. */
const CC = "ua";

export function registerTools(server: McpServer, cfg: SteamConfig) {
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

  /** Accepts an appid or a game name; prefers the owned library over the store. */
  async function resolve(game: string): Promise<{ appid: number; name: string }> {
    if (/^\d+$/.test(game)) return { appid: Number(game), name: `app ${game}` };

    const needle = game.toLowerCase();
    const games = await library();
    const hit =
      games.find((g) => g.name?.toLowerCase() === needle) ??
      games.find((g) => g.name?.toLowerCase().includes(needle));
    if (hit?.name) return { appid: hit.appid, name: hit.name };

    const first = (await storeSearch(game, CC)).items?.[0];
    if (!first) throw new SteamError(`No game matched "${game}".`);
    return { appid: first.id, name: first.name };
  }

  // --- library -------------------------------------------------------------

  server.registerTool(
    "list_library",
    {
      title: "List library",
      description:
        "Owned games with playtime, sorted by hours played. Use min_hours/limit to keep the output small.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(25),
        min_hours: z.number().min(0).default(0),
        sort: z.enum(["playtime", "recent", "name"]).default("playtime"),
      }),
    },
    async ({ limit, min_hours, sort }) => {
      const games = (await library()).filter((g) => g.playtime_forever / 60 >= min_hours);
      const sorted = [...games].sort((a, b) => {
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
      const totalMinutes = games.reduce((s, g) => s + g.playtime_forever, 0);
      const played = games.filter((g) => g.playtime_forever > 0);

      return json({
        total_games: games.length,
        played_games: played.length,
        never_played: games.length - played.length,
        total_playtime: hours(totalMinutes),
        median_playtime_of_played: hours(
          played.length
            ? [...played].sort((a, b) => a.playtime_forever - b.playtime_forever)[
                Math.floor(played.length / 2)
              ].playtime_forever
            : 0,
        ),
        top_games: [...games]
          .sort((a, b) => b.playtime_forever - a.playtime_forever)
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
      const d = await api<{ response: { games?: OwnedGame[] } }>(
        cfg,
        "IPlayerService/GetRecentlyPlayedGames/v1/",
        { steamid: cfg.steamId, count: limit },
      );
      return json(
        (d.response.games ?? []).map((g) => ({
          appid: g.appid,
          name: g.name,
          last_2_weeks: hours(g.playtime_2weeks ?? 0),
          total: hours(g.playtime_forever),
        })),
      );
    },
  );

  server.registerTool(
    "unplayed_games",
    {
      title: "Unplayed games",
      description: "Owned games with little or no playtime — the backlog.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(30),
        max_minutes: z.number().int().min(0).max(600).default(0),
      }),
    },
    async ({ limit, max_minutes }) => {
      const games = (await library())
        .filter((g) => g.playtime_forever <= max_minutes)
        .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
      return json({
        count: games.length,
        games: games.slice(0, limit).map((g) => ({
          appid: g.appid,
          name: g.name,
          playtime: hours(g.playtime_forever),
        })),
      });
    },
  );

  // --- lookup --------------------------------------------------------------

  server.registerTool(
    "find_game",
    {
      title: "Find game",
      description:
        "Resolve a name to an appid. Searches the owned library first, then the Steam store.",
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

  server.registerTool(
    "game_details",
    {
      title: "Game details",
      description:
        "Store information for a game: description, release date, developer, genres, Metacritic score and current price.",
      inputSchema: z.object({ game: z.string().min(1) }),
    },
    async ({ game }) => {
      const { appid } = await resolve(game);
      const entry = (await storeDetails(appid, CC))[String(appid)];
      if (!entry?.success || !entry.data) {
        return json({ appid, error: "No store data available for this appid." });
      }
      const d: AppDetails = entry.data;
      return json({
        appid,
        name: d.name,
        released: d.release_date?.date,
        developers: d.developers,
        publishers: d.publishers,
        genres: d.genres?.map((g) => g.description),
        metacritic: d.metacritic?.score,
        price: d.price_overview?.final_formatted,
        discount_percent: d.price_overview?.discount_percent || undefined,
        description: d.short_description,
      });
    },
  );

  // --- achievements --------------------------------------------------------

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
          playerstats: { achievements?: PlayerAchievement[]; error?: string };
        }>(cfg, "ISteamUserStats/GetPlayerAchievements/v1/", {
          steamid: cfg.steamId,
          appid,
          l: "english",
        }),
        api<{
          achievementpercentages: { achievements?: Array<{ name: string; percent: number }> };
        }>(cfg, "ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/", {
          gameid: appid,
        }).catch(() => null),
      ]);

      const list = player.playerstats.achievements;
      if (!list?.length) {
        return json({
          game: name,
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
        game: name,
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

  server.registerTool(
    "perfect_games",
    {
      title: "Perfect games",
      description: "Games completed to 100% achievements, per Steam's own counter.",
      inputSchema: z.object({}),
    },
    async () => {
      const d = await api<{
        response: { games?: Array<{ appid: number; name?: string }> };
      }>(cfg, "IPlayerService/GetOwnedGames/v1/", {
        steamid: cfg.steamId,
        include_appinfo: true,
      });
      const owned = new Map((d.response.games ?? []).map((g) => [g.appid, g.name]));

      const badges = await api<{
        response: { badges?: Array<{ badgeid: number; appid?: number; level?: number }> };
      }>(cfg, "IPlayerService/GetBadges/v1/", { steamid: cfg.steamId }).catch(() => null);

      return json({
        note: "Steam exposes perfect-game data indirectly; use achievement_progress for exact percentages.",
        candidates: (badges?.response.badges ?? [])
          .filter((b) => b.appid && owned.has(b.appid))
          .slice(0, 25)
          .map((b) => ({ appid: b.appid, name: owned.get(b.appid!) })),
      });
    },
  );

  // --- live / social -------------------------------------------------------

  server.registerTool(
    "get_news",
    {
      title: "Game news",
      description: "Latest news items and patch notes for a game.",
      inputSchema: z.object({
        game: z.string().min(1),
        count: z.number().int().min(1).max(10).default(5),
      }),
    },
    async ({ game, count }) => {
      const { appid, name } = await resolve(game);
      const d = await api<{
        appnews: {
          newsitems?: Array<{
            title: string;
            url: string;
            date: number;
            feedlabel: string;
            contents: string;
          }>;
        };
      }>(cfg, "ISteamNews/GetNewsForApp/v2/", { appid, count, maxlength: 500 });

      return json({
        game: name,
        news: (d.appnews.newsitems ?? []).map((n) => ({
          title: n.title,
          date: day(n.date),
          source: n.feedlabel,
          url: n.url,
          excerpt: n.contents.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
        })),
      });
    },
  );

  server.registerTool(
    "player_count",
    {
      title: "Players online",
      description: "Current concurrent player count for a game.",
      inputSchema: z.object({ game: z.string().min(1) }),
    },
    async ({ game }) => {
      const { appid, name } = await resolve(game);
      const d = await api<{ response: { player_count?: number } }>(
        cfg,
        "ISteamUserStats/GetNumberOfCurrentPlayers/v1/",
        { appid },
      );
      return json({ game: name, appid, players_online: d.response.player_count ?? null });
    },
  );

  server.registerTool(
    "profile_status",
    {
      title: "Profile status",
      description: "Account status: online state, current game, Steam level and ban flags.",
      inputSchema: z.object({}),
    },
    async () => {
      const [summary, level, bans] = await Promise.all([
        api<{
          response: {
            players: Array<{
              personaname: string;
              personastate: number;
              gameextrainfo?: string;
              lastlogoff?: number;
              timecreated?: number;
            }>;
          };
        }>(cfg, "ISteamUser/GetPlayerSummaries/v2/", { steamids: cfg.steamId }),
        api<{ response: { player_level?: number } }>(cfg, "IPlayerService/GetSteamLevel/v1/", {
          steamid: cfg.steamId,
        }).catch(() => null),
        api<{
          players: Array<{ VACBanned: boolean; NumberOfGameBans: number }>;
        }>(cfg, "ISteamUser/GetPlayerBans/v1/", { steamids: cfg.steamId }).catch(() => null),
      ]);

      const p = summary.response.players[0];
      const states = ["offline", "online", "busy", "away", "snooze", "looking to trade", "looking to play"];

      return json({
        name: p?.personaname,
        state: states[p?.personastate ?? 0] ?? "unknown",
        playing_now: p?.gameextrainfo ?? null,
        last_logoff: day(p?.lastlogoff),
        account_created: day(p?.timecreated),
        steam_level: level?.response.player_level ?? null,
        vac_banned: bans?.players[0]?.VACBanned ?? null,
        game_bans: bans?.players[0]?.NumberOfGameBans ?? null,
      });
    },
  );

  server.registerTool(
    "friends",
    {
      title: "Friends",
      description:
        "Friends list with online status and what they are playing. Requires the friends list to be public.",
      inputSchema: z.object({
        online_only: z.boolean().default(false),
        limit: z.number().int().min(1).max(50).default(25),
      }),
    },
    async ({ online_only, limit }) => {
      const list = await api<{
        friendslist?: { friends?: Array<{ steamid: string; friend_since: number }> };
      }>(cfg, "ISteamUser/GetFriendList/v1/", { steamid: cfg.steamId, relationship: "friend" });

      const ids = (list.friendslist?.friends ?? []).slice(0, limit).map((f) => f.steamid);
      if (!ids.length) return json({ friends: [], note: "No friends returned — the list may be private." });

      // One batched call: GetPlayerSummaries accepts up to 100 comma-separated ids.
      const summaries = await api<{
        response: {
          players: Array<{
            steamid: string;
            personaname: string;
            personastate: number;
            gameextrainfo?: string;
          }>;
        };
      }>(cfg, "ISteamUser/GetPlayerSummaries/v2/", { steamids: ids.join(",") });

      const players = summaries.response.players
        .filter((p) => !online_only || p.personastate !== 0)
        .map((p) => ({
          name: p.personaname,
          online: p.personastate !== 0,
          playing: p.gameextrainfo ?? null,
        }));

      return json({ count: players.length, friends: players });
    },
  );

  server.registerTool(
    "wishlist",
    {
      title: "Wishlist",
      description: "Wishlist entries with current prices and discounts.",
      inputSchema: z.object({
        on_sale_only: z.boolean().default(false),
        limit: z.number().int().min(1).max(50).default(25),
      }),
    },
    async ({ on_sale_only, limit }) => {
      const data = await wishlistData(cfg.steamId);
      const rows = Object.entries(data).map(([appid, item]: [string, WishlistItem]) => {
        const sub = item.subs?.[0];
        return {
          appid: Number(appid),
          name: item.name,
          release: item.release_string,
          price: sub?.price !== undefined ? (sub.price / 100).toFixed(2) : undefined,
          discount_percent: sub?.discount_pct || undefined,
        };
      });

      const filtered = on_sale_only ? rows.filter((r) => (r.discount_percent ?? 0) > 0) : rows;
      return json({ count: filtered.length, items: filtered.slice(0, limit) });
    },
  );
}
