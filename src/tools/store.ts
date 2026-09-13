import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { api, appReviews, day, json, storeDetails, type AppDetails } from "../steam";
import type { ToolContext } from "./context";
import { CC, stripMarkup } from "./format";

export function registerStoreTools(server: McpServer, { cfg, resolve }: ToolContext) {
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
      // Two independent storefront calls. Reviews are undocumented and optional,
      // so a failure there must not cost the caller the details it asked for.
      const [details, reviews] = await Promise.all([
        storeDetails(appid, CC),
        appReviews(appid).catch(() => null),
      ]);

      const entry = details[String(appid)];
      if (!entry?.success || !entry.data) {
        return json({ appid, error: "No store data available for this appid." });
      }
      const d: AppDetails = entry.data;

      // Metacritic is press, sparse, and absent for most games. Steam's own
      // score is what players actually go by, so both are reported.
      const q = reviews?.query_summary;
      const total = q?.total_reviews ?? 0;
      return json({
        appid,
        name: d.name,
        released: d.release_date?.date,
        developers: d.developers,
        publishers: d.publishers,
        genres: d.genres?.map((g) => g.description),
        metacritic: d.metacritic?.score,
        steam_review: q?.review_score_desc,
        steam_review_percent:
          total && q?.total_positive !== undefined
            ? Math.round((q.total_positive / total) * 100)
            : undefined,
        steam_reviews_total: total || undefined,
        price: d.price_overview?.final_formatted,
        discount_percent: d.price_overview?.discount_percent || undefined,
        description: d.short_description,
      });
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
        appnews?: {
          newsitems?: Array<{
            title: string;
            url: string;
            date: number;
            feedlabel: string;
            contents: string;
          }>;
        };
      }>(
        cfg,
        "ISteamNews/GetNewsForApp/v2/",
        { appid, count, maxlength: 500 },
        // An app with no announcements answers 403 with an empty body, exactly
        // as an unknown appid does. Without this the generic 401/403 branch
        // fires and tells the owner his API key may be wrong, which it is not.
        [403],
      );

      const items = d.appnews?.newsitems ?? [];
      if (!items.length) {
        return json({
          game: name,
          appid,
          count: 0,
          news: [],
          note: "Steam has no news feed for this app.",
        });
      }

      return json({
        game: name,
        appid,
        count: items.length,
        news: items.map((n) => ({
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
      const d = await api<{ response: { player_count?: number } }>(
        cfg,
        "ISteamUserStats/GetNumberOfCurrentPlayers/v1/",
        { appid },
        [404],
      );
      if (d.response?.player_count === undefined) {
        return json({ game: name, appid, players_online: null, note: "No such app on Steam." });
      }
      return json({ game: name, appid, players_online: d.response.player_count });
    },
  );
}
