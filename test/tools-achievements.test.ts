import { afterEach, describe, expect, it, vi } from "vitest";
import { callTool, game, stubRoutes } from "./helpers";

type Achievements = {
  game: string | null;
  appid: number;
  unlocked: number;
  total: number;
  percent: number;
  count: number;
  matched?: number;
  note?: string;
  achievements: Array<{
    name: string;
    description?: string;
    unlocked: boolean;
    global_percent?: number;
  }>;
};

function ach(i: number, achieved: number) {
  return {
    apiname: `ACH_${i}`,
    name: `Achievement ${i}`,
    description: `Do the thing ${i}`,
    achieved,
    unlocktime: achieved ? 1_700_000_000 : 0,
  };
}

/** Four achievements, two unlocked. */
const FOUR = [ach(1, 1), ach(2, 1), ach(3, 0), ach(4, 0)];

function stubAchievements(list = FOUR, percentages: Array<{ name: string; percent: number }> = []) {
  return stubRoutes({
    GetOwnedGames: () => ({ response: { games: [game({ appid: 730, name: "Counter-Strike 2" })] } }),
    GetPlayerAchievements: () => ({
      playerstats: { gameName: "Counter-Strike 2", achievements: list },
    }),
    GetGlobalAchievementPercentages: () => ({
      achievementpercentages: { achievements: percentages },
    }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("get_achievements", () => {
  it("counts unlocked against the whole set", async () => {
    stubAchievements();
    const out = await callTool<Achievements>("get_achievements", {
      game: "730",
      filter: "all",
      limit: 60,
    });
    expect(out.unlocked).toBe(2);
    expect(out.total).toBe(4);
    expect(out.percent).toBe(50);
  });

  it("names the game from Steam's own payload when given an appid", async () => {
    stubAchievements();
    const out = await callTool<Achievements>("get_achievements", {
      game: "730",
      filter: "all",
      limit: 60,
    });
    expect(out.game).toBe("Counter-Strike 2");
  });

  it("filters to locked without changing unlocked/total", async () => {
    stubAchievements();
    const out = await callTool<Achievements>("get_achievements", {
      game: "730",
      filter: "locked",
      limit: 60,
    });
    expect(out.achievements.every((a) => !a.unlocked)).toBe(true);
    expect(out.matched).toBe(2);
    expect(out.total).toBe(4); // still the whole set, deliberately
  });

  it("says when a filter plus a limit dropped achievements", async () => {
    stubAchievements();
    const out = await callTool<Achievements>("get_achievements", {
      game: "730",
      filter: "locked",
      limit: 1,
    });
    expect(out.count).toBe(1);
    expect(out.matched).toBe(2);
    expect(out.note).toBe("Showing 1 of 2 locked achievements.");
  });

  it("omits matched when nothing was filtered", async () => {
    stubAchievements();
    const out = await callTool<Achievements>("get_achievements", {
      game: "730",
      filter: "all",
      limit: 60,
    });
    expect(out.matched).toBeUndefined();
    expect(out.note).toBeUndefined();
  });

  it("attaches global rarity by apiname", async () => {
    stubAchievements(FOUR, [{ name: "ACH_1", percent: 12.345 }]);
    const out = await callTool<Achievements>("get_achievements", {
      game: "730",
      filter: "all",
      limit: 60,
    });
    expect(out.achievements[0].global_percent).toBe(12.3);
    expect(out.achievements[1].global_percent).toBeUndefined();
  });

  it("survives the rarity endpoint failing", async () => {
    const mock = stubRoutes({});
    mock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("GetOwnedGames")) {
        return Response.json({ response: { games: [game({ appid: 730 })] } });
      }
      if (url.includes("GetPlayerAchievements")) {
        return Response.json({ playerstats: { achievements: FOUR } });
      }
      // A real refusal, not a fallthrough 200 — otherwise the .catch() under
      // test never runs and this passes with the catch deleted.
      return new Response("upstream down", { status: 500 });
    });
    const out = await callTool<Achievements>("get_achievements", {
      game: "730",
      filter: "all",
      limit: 60,
    });
    expect(out.total).toBe(4);
    expect(out.achievements[0].global_percent).toBeUndefined();
  });

  // Steam answers 400 with a body here rather than 200 with an empty list.
  it("explains a game with no stats instead of erroring", async () => {
    const mock = stubRoutes({
      GetOwnedGames: () => ({ response: { games: [game({ appid: 730 })] } }),
    });
    mock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("GetOwnedGames")) {
        return Response.json({ response: { games: [game({ appid: 730 })] } });
      }
      if (url.includes("GetPlayerAchievements")) {
        return Response.json({ playerstats: { error: "Requested app has no stats" } }, { status: 400 });
      }
      return Response.json({});
    });
    const out = await callTool<{ note: string }>("get_achievements", {
      game: "730",
      filter: "all",
      limit: 60,
    });
    expect(out.note).toBe("Requested app has no stats");
  });

  it("labels hidden achievements from the schema", async () => {
    stubRoutes({
      GetOwnedGames: () => ({ response: { games: [game({ appid: 730 })] } }),
      GetPlayerAchievements: () => ({
        playerstats: {
          gameName: "The Witcher 3",
          achievements: [{ ...ach(1, 0), description: "" }, ach(2, 1)],
        },
      }),
      GetSchemaForGame: () => ({
        game: { availableGameStats: { achievements: [{ name: "ACH_1", hidden: 1 }] } },
      }),
    });
    const out = await callTool<Achievements & { achievements: Array<{ hidden?: boolean }> }>(
      "get_achievements",
      { game: "730", filter: "all", limit: 60 },
    );
    // Says why the description is missing, rather than leaving a silent gap.
    expect(out.achievements[0].hidden).toBe(true);
    expect("description" in out.achievements[0]).toBe(false);
    expect(out.achievements[1].hidden).toBeUndefined();
  });

  it("still answers when the schema call fails", async () => {
    const mock = stubRoutes({});
    mock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("GetOwnedGames")) {
        return Response.json({ response: { games: [game({ appid: 730 })] } });
      }
      if (url.includes("GetPlayerAchievements")) {
        return Response.json({ playerstats: { achievements: FOUR } });
      }
      if (url.includes("GetSchemaForGame")) return new Response("nope", { status: 500 });
      return Response.json({ achievementpercentages: { achievements: [] } });
    });
    const out = await callTool<Achievements>("get_achievements", {
      game: "730",
      filter: "all",
      limit: 60,
    });
    expect(out.total).toBe(4);
    expect(out.achievements[0]).not.toHaveProperty("hidden");
  });

  // Confirmed deliberate: json() drops undefined, so a hidden achievement has
  // no description key rather than an empty one.
  it("omits an empty description entirely", async () => {
    stubAchievements([{ ...ach(1, 0), description: "" }]);
    const out = await callTool<Achievements>("get_achievements", {
      game: "730",
      filter: "all",
      limit: 60,
    });
    expect("description" in out.achievements[0]).toBe(false);
  });
});

describe("achievement_progress", () => {
  function stubProgress(gameCount: number, perGame = FOUR) {
    const games = Array.from({ length: gameCount }, (_, i) =>
      game({
        appid: 100 + i,
        name: `Game ${i}`,
        playtime_forever: (gameCount - i) * 60,
        has_community_visible_stats: true,
      }),
    );
    return stubRoutes({
      GetOwnedGames: () => ({ response: { games } }),
      GetPlayerAchievements: () => ({ playerstats: { achievements: perGame } }),
    });
  }

  it("reports the whole eligible population, so skip is navigable", async () => {
    stubProgress(25);
    const out = await callTool<{ count: number; examined: number; total_with_stats: number }>(
      "achievement_progress",
      { count: 5, skip: 0 },
    );
    expect(out.count).toBe(5);
    expect(out.examined).toBe(5);
    expect(out.total_with_stats).toBe(25);
  });

  it("an empty page past the end is distinguishable from a failure", async () => {
    stubProgress(3);
    const out = await callTool<{ count: number; total_with_stats: number; games: unknown[] }>(
      "achievement_progress",
      { count: 5, skip: 10 },
    );
    expect(out.games).toEqual([]);
    expect(out.total_with_stats).toBe(3);
  });

  it("skips games without community stats", async () => {
    stubRoutes({
      GetOwnedGames: () => ({
        response: {
          games: [
            game({ appid: 1, has_community_visible_stats: true }),
            game({ appid: 2, has_community_visible_stats: false }),
          ],
        },
      }),
      GetPlayerAchievements: () => ({ playerstats: { achievements: FOUR } }),
    });
    const out = await callTool<{ total_with_stats: number }>("achievement_progress", {
      count: 10,
      skip: 0,
    });
    expect(out.total_with_stats).toBe(1);
  });

  it("never exceeds the fan-out cap of 15", async () => {
    const mock = stubProgress(40);
    await callTool("achievement_progress", { count: 15, skip: 0 });
    const perGame = mock.mock.calls.filter(([u]) => String(u).includes("GetPlayerAchievements"));
    expect(perGame).toHaveLength(15);
  });

  it("says how many examined games reported nothing", async () => {
    stubProgress(3, []);
    const out = await callTool<{ count: number; examined: number; failed?: number; note?: string }>(
      "achievement_progress",
      { count: 3, skip: 0 },
    );
    expect(out.count).toBe(0);
    expect(out.examined).toBe(3);
    expect(out.failed).toBeUndefined();
    expect(out.note).toBe("3 reported no achievements.");
  });

  // Steam refusing and a game having nothing are different facts. Reporting a
  // total outage as "reported no achievements" is a false claim about the data.
  it("separates games Steam would not answer for from games with nothing", async () => {
    const games = Array.from({ length: 3 }, (_, i) =>
      game({ appid: 100 + i, playtime_forever: 60, has_community_visible_stats: true }),
    );
    const mock = stubRoutes({});
    mock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("GetOwnedGames")) return Response.json({ response: { games } });
      if (url.includes("GetPlayerAchievements")) return new Response("down", { status: 500 });
      return Response.json({});
    });
    const out = await callTool<{ count: number; failed: number; note?: string }>(
      "achievement_progress",
      { count: 3, skip: 0 },
    );
    expect(out.count).toBe(0);
    expect(out.failed).toBe(3);
    expect(out.note).toBe("3 of the 3 games examined could not be read from Steam.");
  });
});

describe("game_stats", () => {
  type Stats = {
    game: string | null;
    appid: number;
    count: number;
    matched?: number;
    total_stats: number;
    note?: string;
    stats: Record<string, number>;
  };

  const CS2 = [
    { name: "total_kills", value: 54930 },
    { name: "total_deaths", value: 37061 },
    { name: "total_time_played", value: 2008933 },
    { name: "total_kills_ak47", value: 12000 },
    { name: "total_wins_map_de_dust2", value: 900 },
  ];

  function stubStats(stats = CS2, gameName = "Counter-Strike 2") {
    return stubRoutes({
      GetOwnedGames: () => ({ response: { games: [game({ appid: 730, name: "CS2" })] } }),
      GetUserStatsForGame: () => ({ playerstats: { gameName, stats } }),
    });
  }

  it("returns counters as an object keyed by stat name", async () => {
    stubStats();
    const out = await callTool<Stats>("game_stats", { game: "730", limit: 40 });
    expect(out.stats.total_kills).toBe(54930);
    expect(out.total_stats).toBe(5);
    expect(out.count).toBe(5);
  });

  it("keeps Steam's own order, which leads with the headline totals", async () => {
    stubStats();
    const out = await callTool<Stats>("game_stats", { game: "730", limit: 3 });
    expect(Object.keys(out.stats)).toEqual(["total_kills", "total_deaths", "total_time_played"]);
  });

  it("names the game from Steam's payload for a bare appid", async () => {
    stubStats();
    const out = await callTool<Stats>("game_stats", { game: "730", limit: 40 });
    expect(out.game).toBe("Counter-Strike 2");
  });

  it("narrows on a substring and reports how many matched", async () => {
    stubStats();
    const out = await callTool<Stats>("game_stats", { game: "730", match: "kills", limit: 40 });
    expect(out.matched).toBe(2);
    expect(Object.keys(out.stats)).toEqual(["total_kills", "total_kills_ak47"]);
  });

  it("matches case-insensitively", async () => {
    stubStats();
    const out = await callTool<Stats>("game_stats", { game: "730", match: "KILLS", limit: 40 });
    expect(out.matched).toBe(2);
  });

  it("says so when the limit cut the matches short", async () => {
    stubStats();
    const out = await callTool<Stats>("game_stats", { game: "730", limit: 2 });
    expect(out.count).toBe(2);
    expect(out.note).toBe("Showing 2 of 5 matching counters.");
  });

  it("suggests dropping the filter when nothing matched", async () => {
    stubStats();
    const out = await callTool<Stats>("game_stats", { game: "730", match: "zzz", limit: 40 });
    expect(out.count).toBe(0);
    expect(out.matched).toBe(0);
    expect(out.note).toContain("No stat name contains");
  });

  it("omits matched when no filter was given", async () => {
    stubStats();
    const out = await callTool<Stats>("game_stats", { game: "730", limit: 40 });
    expect(out.matched).toBeUndefined();
    expect(out.note).toBeUndefined();
  });

  // Half-Life 2 answers 200 with gameName present and the stats array absent.
  it("explains a game Steam keeps no stats for", async () => {
    stubStats([], "Half-Life 2");
    const out = await callTool<Stats>("game_stats", { game: "730", limit: 40 });
    expect(out.game).toBe("Half-Life 2");
    expect(out.note).toContain("keeps no stats");
  });

  // An unknown appid answers 400 with an empty body; that is an answer, not a
  // transport failure, so dataStatuses must carry 400.
  it("explains an unknown appid instead of throwing", async () => {
    const mock = stubStats();
    mock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("GetOwnedGames")) {
        return Response.json({ response: { games: [game({ appid: 730 })] } });
      }
      if (url.includes("GetUserStatsForGame")) return Response.json({}, { status: 400 });
      return Response.json({});
    });
    const out = await callTool<Stats>("game_stats", { game: "999999", limit: 40 });
    expect(out.note).toContain("keeps no stats");
  });

  it("costs one upstream call beyond resolving the name", async () => {
    const mock = stubStats();
    await callTool("game_stats", { game: "730", limit: 40 });
    const calls = mock.mock.calls.filter(([u]) => String(u).includes("GetUserStatsForGame"));
    expect(calls).toHaveLength(1);
  });
});
