import { afterEach, describe, expect, it, vi } from "vitest";
import { createContext } from "../src/tools/context";

const CFG = { apiKey: "k", steamId: "76561198000000000" };

const GAMES = [
  { appid: 70, name: "Half-Life", playtime_forever: 10 },
  { appid: 220, name: "Half-Life 2", playtime_forever: 20 },
  { appid: 730, name: "Counter-Strike 2", playtime_forever: 30 },
];

/**
 * A fresh Response per call. Reusing one instance would let the first read
 * consume its body and make every later call look like a malformed reply.
 */
function stubLibrary(games: unknown[] = GAMES) {
  const fetchMock = vi.fn(async () => Response.json({ response: { games } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createContext", () => {
  it("memoises the library within one context", async () => {
    const fetchMock = stubLibrary();
    const ctx = createContext(CFG);
    await ctx.library();
    await ctx.library();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The whole reason createContext exists rather than a module-level memo.
  it("does not share the memo between contexts", async () => {
    const fetchMock = stubLibrary();
    await createContext(CFG).library();
    await createContext(CFG).library();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws a legible error on an empty library", async () => {
    stubLibrary([]);
    await expect(createContext(CFG).library()).rejects.toThrow(/Game details/);
  });
});

describe("resolve", () => {
  it("passes a numeric appid through without inventing a name", async () => {
    stubLibrary();
    expect(await createContext(CFG).resolve("730")).toEqual({ appid: 730, name: null });
  });

  it("prefers an exact name match", async () => {
    stubLibrary();
    expect(await createContext(CFG).resolve("Half-Life")).toEqual({
      appid: 70,
      name: "Half-Life",
    });
  });

  it("picks the shortest substring match, not the first listed", async () => {
    stubLibrary([GAMES[1], GAMES[0]]);
    expect(await createContext(CFG).resolve("half-life")).toEqual({
      appid: 70,
      name: "Half-Life",
    });
  });

  it("falls back to the store when the library is unreadable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ response: {} }))
      .mockResolvedValueOnce(Response.json({ items: [{ id: 12345, name: "Some Game" }] }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await createContext(CFG).resolve("Some Game")).toEqual({
      appid: 12345,
      name: "Some Game",
    });
  });
});
