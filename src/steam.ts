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

/** GetPlayerSummaries accepts this many comma-separated ids in one call. */
export const SUMMARY_BATCH = 100;

/** Max games we will fan out over in one tool call. Keeps us far under 50. */
export const MAX_FANOUT = 15;
/** Parallel batch size. Workers allow 6 simultaneous outgoing connections. */
export const BATCH = 5;

export interface SteamConfig {
  apiKey: string;
  steamId: string;
}

export class SteamError extends Error {
  /** HTTP status behind this failure, when there was one. */
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

type Params = Record<string, string | number | boolean | undefined>;

/**
 * Steam signals "there is no data for this" with a non-2xx status and a
 * populated body, not with 200 and an empty one — `GetPlayerAchievements`
 * answers 400 with `{"error":"Requested app has no stats"}`. `dataStatuses`
 * lets a caller declare which of those are answers rather than failures, so the
 * explanatory branches downstream can actually run.
 */
async function getJson<T>(url: URL, dataStatuses: number[] = []): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": "steam-mcp/1.0" },
    });
  } catch (error) {
    // AbortSignal.timeout throws a bare TimeoutError; don't leak it unwrapped.
    throw new SteamError(
      (error as Error | undefined)?.name === "TimeoutError"
        ? `Steam did not respond within ${TIMEOUT_MS / 1000}s.`
        : "Could not reach Steam.",
    );
  }

  if (!res.ok && !dataStatuses.includes(res.status)) {
    if (res.status === 401 || res.status === 403) {
      throw new SteamError(
        "Steam refused the request (401/403). Either STEAM_API_KEY is wrong, or the data is " +
          "private — check the profile, its 'Game details' setting, and its friends-list privacy.",
        res.status,
      );
    }
    throw new SteamError(`Steam API returned ${res.status}`, res.status);
  }

  try {
    return (await res.json()) as T;
  } catch {
    // A storefront endpoint answering 200 with HTML is how the retired
    // wishlistdata path failed. Say so instead of throwing a bare SyntaxError.
    throw new SteamError(
      `Steam returned a non-JSON response (${res.headers.get("content-type") ?? "unknown type"}).`,
    );
  }
}

export function api<T>(
  cfg: SteamConfig,
  path: string,
  params: Params = {},
  dataStatuses: number[] = [],
): Promise<T> {
  const url = new URL(`${API}/${path}`);
  url.searchParams.set("key", cfg.apiKey);
  url.searchParams.set("format", "json");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return getJson<T>(url, dataStatuses);
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
  /** 0 when Steam could not serve this item — read `id` for the real appid. */
  appid: number;
  /** Always the requested appid, including on failure. Key maps on this. */
  id?: number;
  /** 1 on success; anything else means the item is unavailable here. */
  success?: number;
  visible?: boolean;
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
  // Decide on the rounded value, or 599 minutes prints "10.0h" while 600
  // prints "10h" — same number, two formats.
  const oneDecimal = Number(h.toFixed(1));
  return oneDecimal < 10 ? `${oneDecimal.toFixed(1)}h` : `${Math.round(h)}h`;
}

/** UTC, deliberately: an evening session east of UTC may read as the next day. */
export function day(unix?: number): string | null {
  return unix ? new Date(unix * 1000).toISOString().slice(0, 10) : null;
}

/** Compact JSON. Indented output would waste the 10 ms CPU budget. */
export function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
