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
  type StoreItem,
  storeItems,
  storeSearch,
  wishlist,
  type WishlistEntry,
} from "./steam";

/** Storefront country code — affects prices only. */
const CC = "ua";

/**
 * Upper bound on wishlist entries we look up in one call. GetItems handles this
 * many in a single request, but the response is ~3 KB per game and parsing it
 * is what actually costs CPU, so we never enrich more than we return.
 */
const WISHLIST_ENRICH_CAP = 50;

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

  /**
   * Accepts an appid or a game name; prefers the owned library over the store.
   * A numeric input needs no lookup, so the name comes back null instead of a
   * made-up `app 730` — callers that get a real name in their own payload should
   * use that.
   */
  async function resolve(game: string): Promise<{ appid: number; name: string | null }> {
    if (/^\d+$/.test(game)) return { appid: Number(game), name: null };

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
          playerstats: { achievements?: PlayerAchievement[]; error?: string; gameName?: string };
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
      const entries = (await wishlist(cfg)).response.items ?? [];
      if (!entries.length) return json({ count: 0, items: [] });

      const ordered = [...entries].sort(byPriority);

      // Filtering by discount needs prices for everything we might keep, so a
      // filtered call enriches up to the cap; an unfiltered one only enriches
      // the page it is about to return.
      const wanted = on_sale_only ? WISHLIST_ENRICH_CAP : Math.min(limit, WISHLIST_ENRICH_CAP);
      const details = await wishlistDetails(ordered.slice(0, wanted).map((e) => e.appid));

      const rows = ordered.map((e) => {
        const d = details.get(e.appid);
        return {
          appid: e.appid,
          name: d?.name,
          release: d?.release,
          price: d?.price,
          was: d?.was,
          discount_percent: d?.discount_percent,
          priority: e.priority || undefined,
          added: day(e.date_added),
        };
      });

      const filtered = on_sale_only ? rows.filter((r) => (r.discount_percent ?? 0) > 0) : rows;
      return json({
        count: filtered.length,
        total_on_wishlist: entries.length,
        items: filtered.slice(0, limit),
        note:
          entries.length > wanted
            ? `Prices resolved for the first ${wanted} entries by priority; the rest carry appid only.`
            : undefined,
      });
    },
  );

  /** Steam sorts by priority, where 1 is most wanted and 0 means unset. */
  function byPriority(a: WishlistEntry, b: WishlistEntry): number {
    const pa = a.priority || Number.MAX_SAFE_INTEGER;
    const pb = b.priority || Number.MAX_SAFE_INTEGER;
    return pa === pb ? (b.date_added ?? 0) - (a.date_added ?? 0) : pa - pb;
  }

  interface WishlistDetail {
    name?: string;
    release?: string | null;
    price?: string;
    was?: string;
    discount_percent?: number;
  }

  /**
   * Names and prices for wishlist appids. One batched GetItems call covers the
   * whole page; if that endpoint fails we drop to per-app storeDetails, capped
   * at MAX_FANOUT so the subrequest budget survives, and the remainder comes
   * back without a name.
   */
  async function wishlistDetails(appids: number[]): Promise<Map<number, WishlistDetail>> {
    const out = new Map<number, WishlistDetail>();
    if (!appids.length) return out;

    try {
      const items = (await storeItems(appids, CC)).response.store_items ?? [];
      if (items.length) {
        for (const it of items) out.set(it.appid, fromStoreItem(it));
        return out;
      }
    } catch {
      // Undocumented shape or a bad day upstream — fall through.
    }

    const rows = await inBatches(appids.slice(0, MAX_FANOUT), async (appid) => {
      try {
        const entry = (await storeDetails(appid, CC))[String(appid)];
        return entry?.success && entry.data ? ([appid, entry.data] as const) : null;
      } catch {
        return null;
      }
    });

    for (const row of rows) {
      if (!row) continue;
      const [appid, d]: readonly [number, AppDetails] = row;
      out.set(appid, {
        name: d.name,
        release: d.release_date?.date ?? null,
        price: d.price_overview?.final_formatted,
        discount_percent: d.price_overview?.discount_percent || undefined,
      });
    }
    return out;
  }

  function fromStoreItem(it: StoreItem): WishlistDetail {
    const opt = it.best_purchase_option;
    return {
      name: it.name,
      release: it.release?.is_coming_soon ? "coming soon" : day(it.release?.steam_release_date),
      price: it.is_free ? "Free" : opt?.formatted_final_price,
      was: opt?.discount_pct ? opt.formatted_original_price : undefined,
      discount_percent: opt?.discount_pct || undefined,
    };
  }
}
