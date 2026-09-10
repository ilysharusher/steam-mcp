import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  day,
  inBatches,
  json,
  MAX_FANOUT,
  storeDetails,
  storeItems,
  wishlist,
  type AppDetails,
  type StoreItem,
  type WishlistEntry,
} from "../steam";
import type { ToolContext } from "./context";
import { CC } from "./format";

/**
 * Upper bound on wishlist entries we look up in one call. GetItems handles this
 * many in a single request, but the response is ~3 KB per game and parsing it
 * is what actually costs CPU, so we never enrich more than we return.
 */
const WISHLIST_ENRICH_CAP = 50;

export function registerWishlistTools(server: McpServer, { cfg }: ToolContext) {
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
}

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
