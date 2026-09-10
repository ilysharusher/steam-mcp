# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versioning is [SemVer](https://semver.org/).

## [0.4.0] — 2026-09-10

Internal restructuring. No tool, route, status code or payload changes.

### Changed
- The web layer routes with **Hono** instead of hand-rolled `url.pathname` checks. The
  same-origin gate on the consent POST is now middleware, and the error mapping for
  `CimdFetchError` and `AuthorizationError` moved into a single `onError` handler.
  `src/auth.ts` became `src/auth/`: app, signed state, GitHub client, page rendering and
  allowlist as separate modules. Hono was chosen because Cloudflare's own
  `remote-mcp-github-oauth` demo puts a Hono app in exactly this slot — as the
  `defaultHandler` of the same OAuth provider this server already uses.
- `src/tools.ts` — 699 lines holding all 12 tools — split into `src/tools/` by domain:
  library, achievements, store, wishlist and social. The tools shared a closure over
  `libraryMemo`, `library()` and `resolve()`, so that state moved into an explicit
  `ToolContext` built once per request. `WISHLIST_ENRICH_CAP` now sits beside its only
  consumer instead of 500 lines above it.

### Added
- A vitest suite running in **workerd**, the same runtime as production. Thirty tests
  covering the auth invariants — the consent gate failing closed when neither
  `Sec-Fetch-Site` nor `Origin` is present, state signature and TTL handling answering 400
  rather than 500 on unauthenticated garbage, allowlist denial, HTML escaping of both the
  client name and a rejected login, `cache-control: no-store` — plus the per-request
  scoping of the library memo and the registration of all twelve tools.

### Notes
- Bundle grew from 3267.17 KiB to 3330.22 KiB (613.62 → 628.83 KiB gzip): +15 KiB gzip for
  Hono, 2.4%.
- Tests run in the Workers runtime out of necessity, not preference:
  `@cloudflare/workers-oauth-provider` imports `cloudflare:workers`, which no Node loader
  resolves. vitest is pinned to `^4.1` because `@cloudflare/vitest-pool-workers@0.22`
  peers it.

## [0.3.0] — 2026-09-10

Findings from a full code review. Breaking: access tokens are now audience-bound, so
existing clients must sign in again, and three tools changed their response shape.

### Security
- **The consent page was CSRF-able.** `POST /authorize` had no origin check, and
  `parseAuthRequest` reads only the query string, so a cross-site auto-submitting form was
  indistinguishable from a real submission. An attacker could host a CIMD document (no
  registration needed — it is fetched live), bounce the victim through GitHub's silent
  re-approval, and receive a working authorization code at their own `redirect_uri`; PKCE
  did not help, because the attacker generated the challenge. The POST now requires
  `Sec-Fetch-Site: same-origin`, falls back to an `Origin` match, and fails closed when
  neither header is present.
- **Access tokens are bound to this resource** via `resourceMetadata.resource`, configured
  from the new `MCP_RESOURCE_URL` var so local development keeps working. Without it,
  tokens carried no audience and nothing was validated. `scopes_supported` now appears in
  the protected-resource metadata as well.
- **The allowlist is enforced on every request,** not only at sign-in. Grants outlive a
  config change, so removing a login from `ALLOWED_GITHUB_LOGINS` previously revoked nobody
  until their token expired. Costs no extra subrequest.
- **The signed `state` now expires** after 10 minutes and carries an issue time. The HMAC
  always prevented forgery, but a captured state was replayable indefinitely.
- Auth pages send `Cache-Control: no-store`, and `page()` escapes its own title.

### Fixed
- Two unauthenticated paths returned HTTP 500 in production, both reproduced and now
  verified fixed: a malformed `state` signature (`atob` threw before the 400 branch could
  run) and an unreachable CIMD document (`CimdFetchError` was rethrown into the void; now a
  502 with an explanation).
- **`friends` counted the wrong population.** It sliced to `limit` before filtering by
  `online_only`, reporting the online share of an arbitrary first page rather than of the
  list: 14 of the first 25 where 31 of 77 were actually online. It now asks Steam about
  everyone it can in one call — `GetPlayerSummaries` takes 100 ids — filters, and slices
  last. A non-public friends list answers 401, which now yields a specific note instead of
  a message blaming the API key.
- **`get_achievements` could not report "this game has no achievements".** Steam answers
  400 with a populated body and `getJson` rejected every non-2xx, so the explanatory branch
  was dead code and callers saw `Steam API returned 400`. `getJson` now accepts a list of
  statuses that carry data rather than failure.
- **`wishlist` silently dropped discounts** beyond the 50-entry enrichment cap while
  reporting `count` as though it had checked everything, and its note described the
  unfiltered case. It now scopes the filtered call explicitly and says what it checked.
- **Unavailable wishlist entries were indistinguishable from un-enriched ones.** Steam
  returns `appid: 0` with the real id in `id` when it cannot serve an item, so keying the
  map on `appid` filed every failure under `0`. Now keyed on `id`, gated on `success`, and
  flagged with `unavailable`.
- `resolve()` no longer fails a store lookup when the library is private — only the tools
  that genuinely need the library raise that error — and prefers the shortest substring
  match over whichever candidate Steam happened to list first.
- `profile_status` reports `unknown` rather than `offline` for a SteamID Steam did not
  return, and `player_count` explains an unknown appid instead of failing on its 404.
- Network failures are classified: a timeout and a non-JSON response now raise a
  `SteamError` saying which, rather than escaping as `TimeoutError` or `SyntaxError`.
- `hours()` no longer prints both `10.0h` and `10h` around the ten-hour boundary.

### Added
- `recently_played` returns `total_count`, `friends` returns `total_friends`, and news
  excerpts have their HTML entities decoded.
- `MCP_RESOURCE_URL` var, in `wrangler.jsonc` for production and `.dev.vars` locally.

### Changed
- `@modelcontextprotocol/server` is declared in `dependencies`. Two files imported it while
  it resolved only transitively through `agents`, so a dedup or a caret bump could have
  broken the build with no change on our side.
- The release workflow passes the tag through `env` instead of interpolating it into the
  shell.

## [0.2.0] — 2026-09-09

Breaking: two tools are gone. Clients that called them need updating.

### Removed
- `perfect_games`. It listed 100% candidates by reading Steam badges, which are awarded for
  trading cards and say nothing about achievements — of the four titles it returned on this
  account, three sat at 29%, 39% and 31%. Steam has no endpoint for perfect games, and
  computing it honestly costs one request per owned game (160 here, against a 50-request
  budget). `achievement_progress` answers the same question correctly.
- `unplayed_games`. It was `list_library` with a playtime filter over the same
  `GetOwnedGames` call, and it was the only tool bypassing the memoised `library()` helper.
  Use `list_library` with `max_hours: 0`.

### Added
- `list_library` accepts `max_hours`, mirroring the existing `min_hours`.

### Fixed
- Tools taking a `game` no longer invent a title when given a numeric appid. `resolve()`
  returns `null` rather than `app 730`, and the field is reported as null.
  `get_achievements` reads the real title out of Steam's own payload, so it names the game
  either way, at no extra request.
- `library_stats` sorts the library once instead of twice and totals it in a single pass.
  Output is unchanged — the new median was checked against the old logic on the live
  160-game library and matches.

## [0.1.1] — 2026-09-09

### Fixed
- `wishlist` returned nothing usable: the storefront endpoint
  `store.steampowered.com/wishlist/profiles/<id>/wishlistdata/` was retired by Valve and
  now 302s to an HTML page instead of serving JSON. The tool reads
  `IWishlistService/GetWishlist/v1` instead, through the regular keyed `api()` helper.

### Changed
- That service returns only `appid`, `priority` and `date_added`, so names, prices,
  discounts and release state are resolved separately through a single batched
  `IStoreBrowseService/GetItems/v1` call — one subrequest regardless of wishlist size.
  If it fails, the tool falls back to per-app `storeDetails` in batches of 5, capped at
  `MAX_FANOUT` entries; anything past the cap is returned with its appid only.
- Enrichment is bounded by `WISHLIST_ENRICH_CAP` (50) and, for unfiltered calls, by the
  requested `limit` — parsing store payloads is the real CPU cost, so the tool never
  looks up more than it returns.
- `wishlist` output gained `priority`, `added`, `was` (pre-discount price) and
  `total_on_wishlist`. Prices are now Steam's formatted strings, matching `game_details`.

## [0.1.0] — 2026-09-08

### Added
- Remote MCP server on Cloudflare Workers, stateless Streamable HTTP via `createMcpHandler`.
- OAuth 2.1 with GitHub as identity provider, CIMD enabled with DCR fallback.
- GitHub login allowlist (`ALLOWED_GITHUB_LOGINS`).
- 14 Steam tools: library, stats, recent, backlog, lookup, store details,
  achievements, cross-game achievement progress, perfect games, news,
  player count, profile, friends, wishlist.
