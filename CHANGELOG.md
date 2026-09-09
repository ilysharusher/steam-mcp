# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versioning is [SemVer](https://semver.org/).

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
