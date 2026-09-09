# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versioning is [SemVer](https://semver.org/).

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
