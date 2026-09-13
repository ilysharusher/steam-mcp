import { afterEach, describe, expect, it, vi } from "vitest";
import { callTool } from "./helpers";

type Wishlist = {
  count: number;
  matched?: number;
  examined?: number;
  total_on_wishlist: number;
  note?: string;
  items: Array<{ appid: number; name?: string; discount_percent?: number }>;
};

/**
 * A wishlist of `n` entries, of which `onSale` come back discounted. This keeps
 * its own fetch mock rather than using stubRoutes from helpers, because GetItems
 * must answer for exactly the appids it was asked about — the point of several
 * tests below is which ids the tool requests.
 */
function stubSteam(n: number, onSale = 0) {
  const items = Array.from({ length: n }, (_, i) => ({
    appid: 1000 + i,
    priority: i + 1,
    date_added: 1_700_000_000,
  }));
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("GetWishlist")) return Response.json({ response: { items } });
    if (url.includes("GetItems")) {
      const payload = JSON.parse(new URL(url).searchParams.get("input_json") ?? "{}");
      const ids: number[] = (payload.ids ?? []).map((x: { appid: number }) => x.appid);
      return Response.json({
        response: {
          store_items: ids.map((appid, i) => ({
            id: appid,
            appid,
            success: 1,
            name: `Game ${appid}`,
            best_purchase_option:
              i < onSale
                ? {
                    formatted_final_price: "50\u20b4",
                    formatted_original_price: "100\u20b4",
                    discount_pct: 50,
                  }
                : { formatted_final_price: "100\u20b4" },
          })),
        },
      });
    }
    return Response.json({});
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

const callWishlist = (args: Record<string, unknown>) => callTool<Wishlist>("wishlist", args);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("wishlist counts", () => {
  it("count is what was returned, not the size of the whole list", async () => {
    stubSteam(30);
    const out = await callWishlist({ on_sale_only: false, limit: 5 });
    expect(out.count).toBe(5);
    expect(out.items).toHaveLength(5);
    expect(out.total_on_wishlist).toBe(30);
  });

  it("says it truncated, and says it accurately", async () => {
    stubSteam(30);
    const out = await callWishlist({ on_sale_only: false, limit: 5 });
    expect(out.note).toBe("Showing the 5 highest-priority entries of 30.");
    // The old note claimed the tail came back with an appid and no name. It
    // never came back at all — the limit had already discarded it.
    expect(out.items.every((i: { name?: string }) => Boolean(i.name))).toBe(true);
  });

  it("stays silent when nothing was left out", async () => {
    stubSteam(5);
    const out = await callWishlist({ on_sale_only: false, limit: 25 });
    expect(out.count).toBe(5);
    expect(out.total_on_wishlist).toBe(5);
    expect(out.note).toBeUndefined();
  });

  it("returns entries in priority order", async () => {
    stubSteam(30);
    const out = await callWishlist({ on_sale_only: false, limit: 3 });
    expect(out.items.map((i: { appid: number }) => i.appid)).toEqual([1000, 1001, 1002]);
  });
});

describe("wishlist on_sale_only", () => {
  it("separates matches from what fitted in the page", async () => {
    stubSteam(80, 12);
    const out = await callWishlist({ on_sale_only: true, limit: 5 });
    expect(out.count).toBe(5);
    expect(out.matched).toBe(12);
    expect(out.examined).toBe(50);
    expect(out.total_on_wishlist).toBe(80);
  });

  it("admits both limits it hit", async () => {
    stubSteam(80, 12);
    const out = await callWishlist({ on_sale_only: true, limit: 5 });
    expect(out.note).toContain("Checked the 50 highest-priority entries of 80");
    expect(out.note).toContain("Showing 5 of 12 matches.");
  });

  it("every returned entry actually carries a discount", async () => {
    stubSteam(80, 12);
    const out = await callWishlist({ on_sale_only: true, limit: 25 });
    expect(out.items).toHaveLength(12);
    expect(out.items.every((i: { discount_percent?: number }) => (i.discount_percent ?? 0) > 0)).toBe(
      true,
    );
  });
});

describe("wishlist budget", () => {
  // The happy path is two subrequests whatever the wishlist size: one
  // GetWishlist, one batched GetItems. CLAUDE.md treats this as load-bearing.
  it("costs two subrequests on a 300-entry wishlist", async () => {
    stubSteam(300);
    const fetchMock = globalThis.fetch as unknown as { mock: { calls: unknown[] } };
    await callWishlist({ on_sale_only: false, limit: 25 });
    expect(fetchMock.mock.calls).toHaveLength(2);
  });

  it("asks the store for no more than it will return", async () => {
    stubSteam(300);
    await callWishlist({ on_sale_only: false, limit: 10 });
    const fetchMock = globalThis.fetch as unknown as { mock: { calls: Array<[string]> } };
    const items = fetchMock.mock.calls.map(([u]) => String(u)).find((u) => u.includes("GetItems"))!;
    const payload = JSON.parse(new URL(items).searchParams.get("input_json") ?? "{}");
    expect(payload.ids).toHaveLength(10);
  });
});

describe("wishlist empty", () => {
  it("answers with zeroes rather than an error", async () => {
    stubSteam(0);
    const out = await callWishlist({ on_sale_only: false, limit: 25 });
    expect(out).toEqual({ count: 0, total_on_wishlist: 0, items: [] });
  });
});
