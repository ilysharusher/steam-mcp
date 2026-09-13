import { afterEach, describe, expect, it, vi } from "vitest";
import { callTool, stubRoutes } from "./helpers";

type Friends = {
  count: number;
  matched?: number;
  total_friends: number;
  friends: Array<{ name: string; online: boolean; playing: string | null }>;
  note?: string;
};

/** `n` friends, the first `online` of them not offline. */
function stubFriends(n: number, online: number) {
  const friends = Array.from({ length: n }, (_, i) => ({
    steamid: String(1000 + i),
    friend_since: 1,
  }));
  return stubRoutes({
    GetFriendList: () => ({ friendslist: { friends } }),
    GetPlayerSummaries: () => ({
      response: {
        players: friends.slice(0, 100).map((f, i) => ({
          steamid: f.steamid,
          personaname: `Friend ${i}`,
          personastate: i < online ? 1 : 0,
          ...(i === 0 ? { gameextrainfo: "Counter-Strike 2" } : {}),
        })),
      },
    }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("friends", () => {
  it("count is what came back, total_friends is the whole list", async () => {
    stubFriends(77, 28);
    const out = await callTool<Friends>("friends", { online_only: false, limit: 25 });
    expect(out.count).toBe(25);
    expect(out.total_friends).toBe(77);
    expect(out.friends).toHaveLength(25);
  });

  it("says how many matches it left out", async () => {
    stubFriends(77, 28);
    const out = await callTool<Friends>("friends", { online_only: true, limit: 25 });
    expect(out.count).toBe(25);
    expect(out.matched).toBe(28);
    expect(out.note).toBe("Showing 25 of 28 matches.");
  });

  // The 0.3.0 fix: filtering must happen before slicing, or the reply reports
  // the online share of an arbitrary first page as the share of the whole list.
  it("filters before it slices", async () => {
    stubFriends(77, 28);
    const out = await callTool<Friends>("friends", { online_only: true, limit: 50 });
    expect(out.count).toBe(28);
    expect(out.friends.every((f) => f.online)).toBe(true);
  });

  it("omits matched when no filter was applied", async () => {
    stubFriends(10, 4);
    const out = await callTool<Friends>("friends", { online_only: false, limit: 25 });
    expect(out.matched).toBeUndefined();
    expect(out.note).toBeUndefined();
  });

  it("admits the 100-friend ceiling Steam imposes", async () => {
    stubFriends(150, 150);
    const out = await callTool<Friends>("friends", { online_only: false, limit: 50 });
    expect(out.total_friends).toBe(150);
    expect(out.note).toContain("Checked the first 100 of 150 friends");
  });

  it("reports what a friend is playing", async () => {
    stubFriends(3, 3);
    const out = await callTool<Friends>("friends", { online_only: false, limit: 25 });
    expect(out.friends[0].playing).toBe("Counter-Strike 2");
    expect(out.friends[1].playing).toBeNull();
  });

  // A private friends list answers 401. The API key is not the problem, so the
  // message must not blame it.
  it("explains a private list instead of erroring", async () => {
    const mock = stubRoutes({});
    mock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes("GetFriendList")) {
        return Response.json({ error: "forbidden" }, { status: 401 });
      }
      return Response.json({});
    });
    const out = await callTool<Friends>("friends", { online_only: false, limit: 25 });
    expect(out.count).toBe(0);
    expect(out.note).toContain("privacy setting is not public");
  });

  it("handles an account with no friends", async () => {
    stubRoutes({ GetFriendList: () => ({ friendslist: { friends: [] } }) });
    const out = await callTool<Friends>("friends", { online_only: false, limit: 25 });
    expect(out).toEqual({ count: 0, total_friends: 0, friends: [] });
  });
});

describe("profile_status", () => {
  function stubProfile(over: Record<string, unknown> = {}) {
    return stubRoutes({
      GetPlayerSummaries: () => ({
        response: {
          players: [
            {
              personaname: "Ilya",
              personastate: 1,
              lastlogoff: 1_700_000_000,
              timecreated: 1_300_000_000,
              ...over,
            },
          ],
        },
      }),
      GetSteamLevel: () => ({ response: { player_level: 42 } }),
      GetPlayerBans: () => ({ players: [{ VACBanned: false, NumberOfGameBans: 0 }] }),
    });
  }

  it("maps the numeric persona state to a word", async () => {
    stubProfile();
    const out = await callTool<{ state: string; steam_level: number }>("profile_status");
    expect(out.state).toBe("online");
    expect(out.steam_level).toBe(42);
  });

  it("reports the game when one is running", async () => {
    stubProfile({ gameextrainfo: "Counter-Strike 2" });
    const out = await callTool<{ playing_now: string | null }>("profile_status");
    expect(out.playing_now).toBe("Counter-Strike 2");
  });

  // Saying "offline" for an unresolvable SteamID would be a confident wrong
  // answer; unknown is the honest one.
  it("says unknown, not offline, for an empty players array", async () => {
    stubRoutes({ GetPlayerSummaries: () => ({ response: { players: [] } }) });
    const out = await callTool<{ state: string; name: string | null }>("profile_status");
    expect(out.state).toBe("unknown");
    expect(out.name).toBeNull();
  });

  it("says unknown for a persona state Steam has not documented", async () => {
    stubProfile({ personastate: 99 });
    const out = await callTool<{ state: string }>("profile_status");
    expect(out.state).toBe("unknown");
  });

  it("degrades to null when level and bans are unavailable", async () => {
    stubRoutes({
      GetPlayerSummaries: () => ({ response: { players: [{ personaname: "Ilya", personastate: 0 }] } }),
    });
    const out = await callTool<{ steam_level: number | null; vac_banned: boolean | null }>(
      "profile_status",
    );
    expect(out.steam_level).toBeNull();
    expect(out.vac_banned).toBeNull();
  });
});
