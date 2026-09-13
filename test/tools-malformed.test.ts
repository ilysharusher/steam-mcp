import { afterEach, describe, expect, it, vi } from "vitest";
import { callTool } from "./helpers";

/**
 * Steam answers 200 with a body that is missing the field the caller expects
 * more often than its documentation suggests, and the shapes vary by endpoint:
 * `{}` from GetUserStatsForGame on a 400, a bare `{"response":{}}` from the
 * player services, 403 with `{}` from the news feed. Every one of those must
 * produce a legible answer, never a TypeError.
 *
 * Four bugs of exactly this shape survived a full code review and 115 other
 * tests; this file is the fixture that would have caught all of them.
 */
const BODIES: Record<string, unknown> = {
  empty: {},
  emptyResponse: { response: {} },
  nullResponse: { response: null },
};

/** Every tool, with arguments that reach its upstream call. */
const TOOLS: Array<[string, Record<string, unknown>]> = [
  ["list_library", { limit: 5, min_hours: 0, sort: "playtime" }],
  ["library_stats", {}],
  ["recently_played", { limit: 5 }],
  ["find_game", { query: "portal" }],
  ["game_details", { game: "730" }],
  ["get_achievements", { game: "730", filter: "all", limit: 10 }],
  ["achievement_progress", { count: 3, skip: 0 }],
  ["get_news", { game: "730", count: 3 }],
  ["player_count", { game: "730" }],
  ["profile_status", {}],
  ["friends", { online_only: false, limit: 10 }],
  ["wishlist", { on_sale_only: false, limit: 5 }],
  ["game_stats", { game: "730", limit: 10 }],
];

/** Tools that legitimately refuse when the library is unreadable. */
const NEEDS_LIBRARY = new Set([
  "list_library",
  "library_stats",
  "achievement_progress",
]);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(Object.entries(BODIES))("every tool survives a %s body", (shape, body) => {
  it.each(TOOLS)("%s", async (name, args) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body)),
    );

    if (NEEDS_LIBRARY.has(name)) {
      // A private or empty library is reported, loudly and on purpose.
      await expect(callTool(name, args)).rejects.toThrow(/Game details/);
      return;
    }

    const out = await callTool<Record<string, unknown>>(name, args);
    expect(out).toBeTypeOf("object");
    // The failure mode this guards against: an internal TypeError reaching the
    // model as though it were an answer.
    expect(JSON.stringify(out)).not.toMatch(/Cannot read propert|undefined is not|is not a function/);
  });
});

describe("every tool survives a non-2xx with an empty body", () => {
  it.each(TOOLS)("%s", async (name, args) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({}, { status: 403 })),
    );
    // Either a legible answer or a SteamError — never a TypeError.
    try {
      const out = await callTool<Record<string, unknown>>(name, args);
      expect(JSON.stringify(out)).not.toMatch(/Cannot read propert|undefined is not/);
    } catch (error) {
      expect((error as Error).message).not.toMatch(/Cannot read propert|undefined is not/);
    }
  });
});
