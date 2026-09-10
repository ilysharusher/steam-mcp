import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  api,
  day,
  inBatches,
  json,
  MAX_FANOUT,
  type AppDetails,
  type SteamConfig,
  SteamError,
  SUMMARY_BATCH,
  storeDetails,
  type StoreItem,
  storeItems,
  wishlist,
  type WishlistEntry,
} from "./steam";
import { registerAchievementTools } from "./tools/achievements";
import { createContext } from "./tools/context";
import { registerLibraryTools } from "./tools/library";
import { CC, stripMarkup } from "./tools/format";

/**
 * Upper bound on wishlist entries we look up in one call. GetItems handles this
 * many in a single request, but the response is ~3 KB per game and parsing it
 * is what actually costs CPU, so we never enrich more than we return.
 */
const WISHLIST_ENRICH_CAP = 50;

export function registerTools(server: McpServer, cfg: SteamConfig) {
  const ctx = createContext(cfg);
  registerLibraryTools(server, ctx);
  registerAchievementTools(server, ctx);
  const { library, resolve } = ctx;

  // --- library -------------------------------------------------------------


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
          excerpt: stripMarkup(n.contents),
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
      // Steam answers 404 with a body for an unknown appid; that is an answer.
      const d = await api<{ response: { player_count?: number; result?: number } }>(
        cfg,
        "ISteamUserStats/GetNumberOfCurrentPlayers/v1/",
        { appid },
        [404],
      );
      if (d.response.player_count === undefined) {
        return json({ game: name, appid, players_online: null, note: "No such app on Steam." });
      }
      return json({ game: name, appid, players_online: d.response.player_count });
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
        name: p?.personaname ?? null,
        // An unresolvable SteamID comes back as an empty players array. Saying
        // "offline" there would be a confident wrong answer.
        state: p ? (states[p.personastate] ?? "unknown") : "unknown",
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
      }>(cfg, "ISteamUser/GetFriendList/v1/", {
        steamid: cfg.steamId,
        relationship: "friend",
      }).catch((error: unknown) => {
        // A non-public friends list answers 401. The API key is not the problem,
        // so don't repeat the generic key-or-privacy message here.
        if (error instanceof SteamError && error.status === 401) return null;
        throw error;
      });

      if (!list) {
        return json({
          count: 0,
          friends: [],
          note: "Steam would not serve this friends list — its privacy setting is not public.",
        });
      }

      const all = list.friendslist?.friends ?? [];
      if (!all.length) return json({ count: 0, total_friends: 0, friends: [] });

      // Ask about everyone Steam will answer for in one call, and slice only
      // AFTER filtering: slicing first reports the online share of an arbitrary
      // first page as though it were the online share of the whole list.
      const ids = all.slice(0, SUMMARY_BATCH).map((f) => f.steamid);
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

      return json({
        count: players.length,
        total_friends: all.length,
        friends: players.slice(0, limit),
        note:
          all.length > SUMMARY_BATCH
            ? `Checked the first ${SUMMARY_BATCH} of ${all.length} friends; Steam serves at most that many per call.`
            : undefined,
      });
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

      // Only enriched entries carry a discount, so a filtered call can answer
      // for the enriched slice and nothing beyond it. Say which, rather than
      // letting the filter quietly drop the tail.
      const scope = on_sale_only ? ordered.slice(0, wanted) : ordered;
      const rows = scope.map((e) => {
        const d = details.get(e.appid);
        return {
          appid: e.appid,
          name: d?.name,
          release: d?.release,
          price: d?.price,
          was: d?.was,
          discount_percent: d?.discount_percent,
          unavailable: d?.unavailable,
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
            ? on_sale_only
              ? `Checked the ${wanted} highest-priority entries of ${entries.length}; discounts further down the list are not included.`
              : `Prices resolved for the first ${wanted} entries by priority; the rest carry appid only.`
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
    /** True when Steam refused to serve the item: delisted, or region-locked. */
    unavailable?: boolean;
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
        for (const it of items) {
          // A failed lookup comes back as appid 0 with the requested id intact,
          // so keying on appid would file it under 0 and leave the real entry
          // looking merely un-enriched. Key on id and mark the difference.
          const appid = it.id ?? it.appid;
          out.set(
            appid,
            it.success === 1 && it.name ? fromStoreItem(it) : { unavailable: true },
          );
        }
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
