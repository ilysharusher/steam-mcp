# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versioning is [SemVer](https://semver.org/).

## [0.1.0] — unreleased

### Added
- Remote MCP server on Cloudflare Workers, stateless Streamable HTTP via `createMcpHandler`.
- OAuth 2.1 with GitHub as identity provider, CIMD enabled with DCR fallback.
- GitHub login allowlist (`ALLOWED_GITHUB_LOGINS`).
- 14 Steam tools: library, stats, recent, backlog, lookup, store details,
  achievements, cross-game achievement progress, perfect games, news,
  player count, profile, friends, wishlist.
