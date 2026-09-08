/**
 * Steam Web API client.
 *
 * Workers free-plan constraints this module is written against:
 *  - 10 ms CPU per request  -> no pretty-printed JSON, no heavy loops
 *  - 50 external subrequests -> callers must cap fan-out (see BATCH/MAX_FANOUT)
 *  - 6 simultaneous outgoing connections -> fan-out runs in batches of 5
 */

const API = "https://api.steampowered.com";
const STORE = "https://store.steampowered.com";
const TIMEOUT_MS = 10_000;

/** Max games we will fan out over in one tool call. Keeps us far under 50. */
export const MAX_FANOUT = 15;
/** Parallel batch size. Workers allow 6 simultaneous outgoing connections. */
export const BATCH = 5;

export interface SteamConfig {
  apiKey: string;
  steamId: string;
}

export class SteamError extends Error {}

type Params = Record<string, string | number | boolean | undefined>;

async function getJson<T>(url: URL): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "User-Agent": "steam-mcp/1.0" },
  });

  if (res.status === 401 || res.status === 403) {
    throw new SteamError(
      "Steam rejected the request (401/403). Check STEAM_API_KEY and that the profile is public.",
    );
  }
  if (!res.ok) throw new SteamError(`Steam API returned ${res.status}`);
  return (await res.json()) as T;
}

export function api<T>(cfg: SteamConfig, path: string, params: Params = {}): Promise<T> {
  const url = new URL(`${API}/${path}`);
  url.searchParams.set("key", cfg.apiKey);
  url.searchParams.set("format", "json");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return getJson<T>(url);
}

/** Undocumented storefront endpoints. Valve may change these without notice. */
export function storeSearch(term: string, cc: string) {
  const url = new URL(`${STORE}/api/storesearch/`);
  url.searchParams.set("term", term);
  url.searchParams.set("cc", cc);
  url.searchParams.set("l", "english");
  return getJson<{ items?: Array<{ id: number; name: string }> }>(url);
}

export function storeDetails(appid: number, cc: string) {
  const url = new URL(`${STORE}/api/appdetails`);
  url.searchParams.set("appids", String(appid));
  url.searchParams.set("cc", cc);
  url.searchParams.set("l", "english");
  return getJson<Record<string, { success: boolean; data?: AppDetails }>>(url);
}

/**
 * Wishlist contents. The storefront path `/wishlist/profiles/<id>/wishlistdata/`
 * is dead — Valve now 302s it to HTML — so this goes through the documented
 * service instead. It returns appids only; names and prices come from
 * storeItems().
 */
export function wishlist(cfg: SteamConfig) {
  return api<{ response: { items?: WishlistEntry[] } }>(
    cfg,
    "IWishlistService/GetWishlist/v1/",
    { steamid: cfg.steamId },
  );
}

/**
 * Names, prices and release state for many appids in one request. This is what
 * keeps wishlist enrichment at a single subrequest instead of one per game.
 * Takes no key; the payload goes in `input_json`.
 */
export function storeItems(appids: number[], cc: string) {
  const url = new URL(`${API}/IStoreBrowseService/GetItems/v1/`);
  url.searchParams.set(
    "input_json",
    JSON.stringify({
      ids: appids.map((appid) => ({ appid })),
      context: { language: "english", country_code: cc.toUpperCase() },
      data_request: {
        include_basic_info: true,
        include_release: true,
        include_all_purchase_options: true,
      },
    }),
  );
  return getJson<{ response: { store_items?: StoreItem[] } }>(url);
}

/** Run an async mapper over items in small batches to respect the connection cap. */
export async function inBatches<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  size = BATCH,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

// --- shapes we actually read -------------------------------------------------

export interface OwnedGame {
  appid: number;
  name?: string;
  playtime_forever: number;
  playtime_2weeks?: number;
  rtime_last_played?: number;
  has_community_visible_stats?: boolean;
}

export interface AppDetails {
  name: string;
  short_description?: string;
  release_date?: { date?: string };
  developers?: string[];
  publishers?: string[];
  genres?: Array<{ description: string }>;
  metacritic?: { score: number };
  price_overview?: { final_formatted?: string; discount_percent?: number };
  categories?: Array<{ description: string }>;
}

export interface WishlistEntry {
  appid: number;
  /** 1 is the most wanted; 0 means the entry was never prioritised. */
  priority?: number;
  date_added?: number;
}

/** The subset of IStoreBrowseService/GetItems this server reads. */
export interface StoreItem {
  appid: number;
  name?: string;
  is_free?: boolean;
  release?: { steam_release_date?: number; is_coming_soon?: boolean };
  /** Absent for free and unreleased titles; discount fields appear only on sale. */
  best_purchase_option?: {
    formatted_final_price?: string;
    formatted_original_price?: string;
    discount_pct?: number;
  };
}

export interface PlayerAchievement {
  apiname: string;
  achieved: number;
  unlocktime: number;
  name?: string;
  description?: string;
}

// --- formatting --------------------------------------------------------------

export function hours(minutes: number): string {
  if (!minutes) return "0h";
  const h = minutes / 60;
  return h < 10 ? `${h.toFixed(1)}h` : `${Math.round(h)}h`;
}

export function day(unix?: number): string | null {
  return unix ? new Date(unix * 1000).toISOString().slice(0, 10) : null;
}

/** Compact JSON. Indented output would waste the 10 ms CPU budget. */
export function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
