import { afterEach, describe, expect, it, vi } from "vitest";
import { callTool, game, stubRoutes } from "./helpers";

type Listing = {
  matched: number;
  games: Array<{ appid: number; name: string; playtime: string; last_played: string | null }>;
};

const LIBRARY = [
  game({ appid: 10, name: "Counter-Strike", playtime_forever: 6000, rtime_last_played: 300 }),
  game({ appid: 20, name: "Half-Life", playtime_forever: 600, rtime_last_played: 500 }),
  game({ appid: 30, name: "Portal", playtime_forever: 60, rtime_last_played: 400 }),
  game({ appid: 40, name: "Alyx", playtime_forever: 0, rtime_last_played: 0 }),
  game({ appid: 50, name: "Dota 2", playtime_forever: 0, rtime_last_played: 0 }),
];

function stubLibrary(games = LIBRARY) {
  return stubRoutes({ GetOwnedGames: () => ({ response: { games } }) });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("list_library", () => {
  it("sorts by playtime and reports how many matched", async () => {
    stubLibrary();
    const out = await callTool<Listing>("list_library", { limit: 2, min_hours: 0, sort: "playtime" });
    expect(out.matched).toBe(5);
    expect(out.games.map((g) => g.name)).toEqual(["Counter-Strike", "Half-Life"]);
  });

  it("max_hours: 0 is the backlog", async () => {
    stubLibrary();
    const out = await callTool<Listing>("list_library", {
      limit: 25,
      min_hours: 0,
      max_hours: 0,
      sort: "playtime",
    });
    expect(out.matched).toBe(2);
    expect(out.games.map((g) => g.name).sort()).toEqual(["Alyx", "Dota 2"]);
  });

  it("min_hours filters on hours, not minutes", async () => {
    stubLibrary();
    const out = await callTool<Listing>("list_library", { limit: 25, min_hours: 5, sort: "playtime" });
    // 6000 minutes = 100 h, 600 = 10 h, 60 = 1 h. Only the first two clear 5 h.
    expect(out.matched).toBe(2);
  });

  it("sorts by name and by recency on request", async () => {
    stubLibrary();
    const byName = await callTool<Listing>("list_library", { limit: 3, min_hours: 0, sort: "name" });
    expect(byName.games.map((g) => g.name)).toEqual(["Alyx", "Counter-Strike", "Dota 2"]);
    const byRecent = await callTool<Listing>("list_library", {
      limit: 2,
      min_hours: 0,
      sort: "recent",
    });
    expect(byRecent.games.map((g) => g.name)).toEqual(["Half-Life", "Portal"]);
  });

  it("matched stays the filtered total when the limit truncates", async () => {
    stubLibrary();
    const out = await callTool<Listing>("list_library", { limit: 1, min_hours: 0, sort: "playtime" });
    expect(out.games).toHaveLength(1);
    expect(out.matched).toBe(5);
  });

  it("surfaces a private library as a legible error", async () => {
    stubRoutes({ GetOwnedGames: () => ({ response: {} }) });
    await expect(callTool("list_library", { limit: 5, min_hours: 0, sort: "playtime" })).rejects.toThrow(
      /Game details/,
    );
  });
});

describe("library_stats", () => {
  it("counts played and never-played separately", async () => {
    stubLibrary();
    const out = await callTool<{
      total_games: number;
      played_games: number;
      never_played: number;
      total_playtime: string;
      top_games: Array<{ name: string }>;
    }>("library_stats");
    expect(out.total_games).toBe(5);
    expect(out.played_games).toBe(3);
    expect(out.never_played).toBe(2);
  });

  it("totals playtime across the whole library", async () => {
    stubLibrary();
    const out = await callTool<{ total_playtime: string }>("library_stats");
    // 6000 + 600 + 60 minutes = 111 h
    expect(out.total_playtime).toBe("111h");
  });

  it("takes the median over played games only", async () => {
    stubLibrary();
    const out = await callTool<{ median_playtime_of_played: string }>("library_stats");
    // Played: 100h, 10h, 1h -> median 10h. Counting the two zeroes would give 1h.
    expect(out.median_playtime_of_played).toBe("10h");
  });

  it("does not disturb the memoised library order", async () => {
    stubLibrary();
    // library_stats sorts a copy; list_library in the same process must still
    // see the original array and sort it for itself.
    const stats = await callTool<{ top_games: Array<{ name: string }> }>("library_stats");
    expect(stats.top_games[0].name).toBe("Counter-Strike");
    const listing = await callTool<Listing>("list_library", { limit: 1, min_hours: 0, sort: "name" });
    expect(listing.games[0].name).toBe("Alyx");
  });
});

describe("recently_played", () => {
  it("passes Steam's own total through", async () => {
    stubRoutes({
      GetRecentlyPlayedGames: {
        response: {
          total_count: 7,
          games: [{ appid: 10, name: "Counter-Strike", playtime_2weeks: 120, playtime_forever: 6000 }],
        },
      },
    });
    const out = await callTool<{ total_count: number; games: Array<{ last_2_weeks: string }> }>(
      "recently_played",
      { limit: 1 },
    );
    expect(out.total_count).toBe(7);
    expect(out.games[0].last_2_weeks).toBe("2.0h"); // under 10h keeps a decimal
  });

  it("answers an empty fortnight without an error", async () => {
    stubRoutes({ GetRecentlyPlayedGames: { response: { total_count: 0 } } });
    const out = await callTool<{ games: unknown[] }>("recently_played", { limit: 10 });
    expect(out.games).toEqual([]);
  });
});

describe("find_game", () => {
  it("reports how many matched, not just what fitted", async () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      game({ appid: 100 + i, name: `Half-Life ${i}`, playtime_forever: 60 }),
    );
    stubLibrary(many);
    const out = await callTool<{ count: number; matched: number; source: string; note?: string }>(
      "find_game",
      { query: "half-life" },
    );
    expect(out.count).toBe(10);
    expect(out.matched).toBe(14);
    expect(out.source).toBe("library");
    expect(out.note).toContain("Showing 10 of 14");
  });

  it("stays silent when everything fitted", async () => {
    stubLibrary();
    const out = await callTool<{ count: number; matched: number; note?: string }>("find_game", {
      query: "portal",
    });
    expect(out.count).toBe(1);
    expect(out.matched).toBe(1);
    expect(out.note).toBeUndefined();
  });

  it("falls through to the store and says so", async () => {
    stubRoutes({
      GetOwnedGames: () => ({ response: { games: LIBRARY } }),
      "api/storesearch": { items: [{ id: 999, name: "Some Unowned Game" }] },
    });
    const out = await callTool<{
      source: string;
      games: Array<{ appid: number; owned: boolean }>;
    }>("find_game", { query: "something nobody owns" });
    expect(out.source).toBe("store");
    expect(out.games[0]).toEqual({ appid: 999, name: "Some Unowned Game", owned: false });
  });

  it("searches the store even when the library is unreadable", async () => {
    stubRoutes({
      GetOwnedGames: () => ({ response: {} }),
      "api/storesearch": { items: [{ id: 999, name: "Some Game" }] },
    });
    const out = await callTool<{ source: string; count: number }>("find_game", { query: "some" });
    expect(out.source).toBe("store");
    expect(out.count).toBe(1);
  });
});
