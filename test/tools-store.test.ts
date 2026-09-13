import { afterEach, describe, expect, it, vi } from "vitest";
import { callTool, game, stubRoutes } from "./helpers";

const OWNED = { GetOwnedGames: () => ({ response: { games: [game({ appid: 730, name: "CS2" })] } }) };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("game_details", () => {
  it("flattens the store payload to the fields it documents", async () => {
    stubRoutes({
      ...OWNED,
      appdetails: {
        "730": {
          success: true,
          data: {
            name: "Counter-Strike 2",
            release_date: { date: "21 Aug, 2012" },
            developers: ["Valve"],
            publishers: ["Valve"],
            genres: [{ description: "Action" }, { description: "FPS" }],
            metacritic: { score: 83 },
            price_overview: { final_formatted: "100₴", discount_percent: 0 },
            short_description: "Shoot things.",
          },
        },
      },
    });
    const out = await callTool<{
      genres: string[];
      metacritic: number;
      price: string;
      discount_percent?: number;
    }>("game_details", { game: "730" });
    expect(out.genres).toEqual(["Action", "FPS"]);
    expect(out.metacritic).toBe(83);
    expect(out.price).toBe("100₴");
    // A zero discount is not a discount; the key should be gone, not 0.
    expect(out.discount_percent).toBeUndefined();
  });

  it("carries Steam's own review score alongside Metacritic", async () => {
    stubRoutes({
      ...OWNED,
      appdetails: { "730": { success: true, data: { name: "CS2", metacritic: { score: 83 } } } },
      appreviews: {
        query_summary: {
          review_score_desc: "Very Positive",
          total_positive: 8_464_630,
          total_negative: 1_391_026,
          total_reviews: 9_855_656,
        },
      },
    });
    const out = await callTool<{
      metacritic: number;
      steam_review: string;
      steam_review_percent: number;
      steam_reviews_total: number;
    }>("game_details", { game: "730" });
    expect(out.steam_review).toBe("Very Positive");
    expect(out.steam_review_percent).toBe(86);
    expect(out.steam_reviews_total).toBe(9_855_656);
    expect(out.metacritic).toBe(83); // both, not one instead of the other
  });

  // The reviews path is undocumented; losing it must not cost the caller the
  // details they actually asked for.
  it("still answers when the review endpoint fails", async () => {
    const mock = stubRoutes(OWNED);
    mock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("GetOwnedGames")) {
        return Response.json({ response: { games: [game({ appid: 730 })] } });
      }
      if (url.includes("appdetails")) {
        return Response.json({ "730": { success: true, data: { name: "CS2" } } });
      }
      if (url.includes("appreviews")) return new Response("nope", { status: 500 });
      return Response.json({});
    });
    const out = await callTool<{ name: string; steam_review?: string }>("game_details", {
      game: "730",
    });
    expect(out.name).toBe("CS2");
    expect(out.steam_review).toBeUndefined();
  });

  it("omits the review fields when Steam has no reviews yet", async () => {
    stubRoutes({
      ...OWNED,
      appdetails: { "730": { success: true, data: { name: "CS2" } } },
      appreviews: { query_summary: { review_score_desc: "No user reviews", total_reviews: 0 } },
    });
    const out = await callTool<{ steam_review_percent?: number; steam_reviews_total?: number }>(
      "game_details",
      { game: "730" },
    );
    expect(out.steam_review_percent).toBeUndefined();
    expect(out.steam_reviews_total).toBeUndefined();
  });

  it("says so when the store has nothing for the appid", async () => {
    stubRoutes({ ...OWNED, appdetails: { "730": { success: false } } });
    const out = await callTool<{ appid: number; error: string }>("game_details", { game: "730" });
    expect(out.appid).toBe(730);
    expect(out.error).toContain("No store data");
  });
});

describe("get_news", () => {
  it("strips markup and decodes entities in the excerpt", async () => {
    stubRoutes({
      ...OWNED,
      GetNewsForApp: {
        appnews: {
          newsitems: [
            {
              title: "Update",
              url: "https://example.com/1",
              date: 1_700_000_000,
              feedlabel: "Community",
              contents: "<p>Fixed &amp; shipped</p>   <br>Done",
            },
          ],
        },
      },
    });
    const out = await callTool<{ news: Array<{ excerpt: string; source: string }> }>("get_news", {
      game: "730",
      count: 5,
    });
    expect(out.news[0].excerpt).toBe("Fixed & shipped Done");
    expect(out.news[0].source).toBe("Community");
  });

  it("decodes numeric entities too", async () => {
    stubRoutes({
      ...OWNED,
      GetNewsForApp: {
        appnews: {
          newsitems: [
            { title: "t", url: "u", date: 1, feedlabel: "f", contents: "a &#8212; b &nbsp; c" },
          ],
        },
      },
    });
    const out = await callTool<{ news: Array<{ excerpt: string }> }>("get_news", {
      game: "730",
      count: 1,
    });
    expect(out.news[0].excerpt).toBe("a — b c");
  });

  it("answers an empty feed without an error", async () => {
    stubRoutes({ ...OWNED, GetNewsForApp: { appnews: {} } });
    const out = await callTool<{ news: unknown[] }>("get_news", { game: "730", count: 5 });
    expect(out.news).toEqual([]);
  });
});

describe("player_count", () => {
  it("returns the live concurrent count", async () => {
    stubRoutes({ ...OWNED, GetNumberOfCurrentPlayers: { response: { player_count: 421_000 } } });
    const out = await callTool<{ players_online: number }>("player_count", { game: "730" });
    expect(out.players_online).toBe(421_000);
  });

  // Steam answers 404 with a body for an unknown appid; that is an answer.
  it("explains an unknown appid rather than throwing", async () => {
    const mock = stubRoutes(OWNED);
    mock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("GetOwnedGames")) {
        return Response.json({ response: { games: [game({ appid: 730 })] } });
      }
      if (url.includes("GetNumberOfCurrentPlayers")) {
        return Response.json({ response: { result: 42 } }, { status: 404 });
      }
      return Response.json({});
    });
    const out = await callTool<{ players_online: null; note: string }>("player_count", {
      game: "999999",
    });
    expect(out.players_online).toBeNull();
    expect(out.note).toBe("No such app on Steam.");
  });

  it("leaves game null for a bare appid rather than inventing a title", async () => {
    stubRoutes({ ...OWNED, GetNumberOfCurrentPlayers: { response: { player_count: 5 } } });
    const out = await callTool<{ game: string | null; appid: number }>("player_count", {
      game: "999999",
    });
    expect(out.game).toBeNull();
    expect(out.appid).toBe(999999);
  });
});
