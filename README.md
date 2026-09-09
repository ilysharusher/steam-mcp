# steam-mcp

Remote MCP server exposing a Steam account — library, achievements, stats, news, friends, wishlist — to any MCP client.

Runs on Cloudflare Workers. Stateless Streamable HTTP, OAuth 2.1 with GitHub sign-in and a login allowlist. No Durable Objects.

## Tools

| Tool | What it returns |
|---|---|
| `list_library` | Owned games with playtime; sort by playtime / recency / name |
| `library_stats` | Game count, total and median hours, backlog size, top 10 |
| `recently_played` | Last two weeks of activity |
| `unplayed_games` | The backlog |
| `find_game` | Name → appid, library first, then the store |
| `game_details` | Description, release date, developer, genres, Metacritic, price |
| `get_achievements` | Per-game progress plus global rarity for each achievement |
| `achievement_progress` | Completion across the most-played games (max 15 per call) |
| `perfect_games` | 100% completion candidates |
| `get_news` | News and patch notes |
| `player_count` | Concurrent players right now |
| `profile_status` | Online state, current game, Steam level, ban flags |
| `friends` | Friends with online status and current game |
| `wishlist` | Wishlist with prices and discounts |

Any tool taking a `game` accepts either an appid or a name — `"mw4"` resolves through the library.

## Setup

### 1. Prerequisites

- Node 20+
- A Cloudflare account (free plan is enough)
- `npm install`, then `npx wrangler login`

### 2. Steam credentials

- API key: <https://steamcommunity.com/dev/apikey> (requires a phone-verified account)
- SteamID64: <https://steamid.io>
- The profile and **Game details** must be set to Public, otherwise the API returns an empty library with no error.

### 3. KV namespace

The OAuth provider stores grants and tokens in KV.

```bash
npx wrangler kv namespace create "OAUTH_KV"
```

Put the returned id into `wrangler.jsonc` under `kv_namespaces[0].id`.

### 4. GitHub OAuth apps

Create two apps at <https://github.com/settings/developers> — one for local development, one for production.

| | Homepage URL | Callback URL |
|---|---|---|
| local | `http://localhost:8788` | `http://localhost:8788/callback` |
| prod | `https://steam-mcp.<subdomain>.workers.dev` | `https://steam-mcp.<subdomain>.workers.dev/callback` |

Set `ALLOWED_GITHUB_LOGINS` in `wrangler.jsonc` to your GitHub login. Leaving it empty lets **anyone** with a GitHub account in — don't.

### 5. Secrets

Local development uses `.dev.vars` (copy `.dev.vars.example`). Production uses Wrangler secrets:

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put AUTH_STATE_SECRET   # openssl rand -hex 32
npx wrangler secret put STEAM_API_KEY
npx wrangler secret put STEAM_ID
```

`AUTH_STATE_SECRET` signs the pending authorization request that travels through the GitHub redirect.

### 6. Run locally

```bash
npm run dev          # http://localhost:8788/mcp
npm run inspector    # MCP Inspector in a second terminal
```

In the Inspector: enter `http://localhost:8788/mcp`, open **OAuth Settings → Quick OAuth Flow**, sign in with GitHub, then **Connect → List Tools**.

### 7. Deploy

```bash
npm run typecheck
npm run build:check   # bundle size; the limit is 64 MiB uncompressed
npm run deploy
```

The endpoint is `https://steam-mcp.<subdomain>.workers.dev/mcp`.
This deployment lives at <https://steam-mcp.ilysharusher.workers.dev/mcp>.

### 8. Connect a client

Claude (web, desktop, mobile): Settings → Connectors → Add custom connector → paste the `/mcp` URL. Sign-in happens in the browser.

Clients without remote-MCP support:

```json
{
  "mcpServers": {
    "steam": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://steam-mcp.<subdomain>.workers.dev/mcp"]
    }
  }
}
```

## Free-plan constraints this code respects

| Limit | Free plan | How it's handled |
|---|---|---|
| CPU per request | 10 ms | Compact JSON only, no pretty-printing, no per-item loops over the full library |
| External subrequests | 50 | `achievement_progress` caps fan-out at 15 games; `wishlist` costs 2 regardless of size |
| Simultaneous connections | 6 | Fan-out runs in batches of 5 |
| Bundle size | 64 MiB uncompressed | Currently ~3.3 MiB |

CPU time excludes waiting on `fetch()`, so slow Steam responses cost nothing.

## Notes

- `game_details` and `find_game` (store path) use undocumented storefront endpoints on
  `store.steampowered.com`. Valve can change them without notice.
- `wishlist` used to go through one of those and broke when Valve retired it in 2026.
  It now reads `IWishlistService/GetWishlist`, then resolves names and prices with a
  single batched `IStoreBrowseService/GetItems` call. Do not point it back at
  `wishlistdata` — that path returns HTML now.
- Nothing in-game is available: no save files, no story progress. Steam only exposes what a game reports as achievements and stats.
- Prices come back in UAH; change `CC` in `src/tools.ts` for another region.

## Releases

`CHANGELOG.md` is written by hand and is the source of truth. Pushing a `v*` tag runs
`.github/workflows/release.yml`, which lifts that version's section out of the changelog
and publishes it as a GitHub Release.

```bash
git tag v0.1.2 && git push origin v0.1.2
```

The tag must point at a commit whose `CHANGELOG.md` already has the matching `## [x.y.z]`
heading, otherwise the job fails instead of publishing an empty release. Version numbers
live in three places: `package.json`, `CHANGELOG.md`, and the `McpServer` constructor in
`src/index.ts`.

## Development

```
src/
├── index.ts   # OAuthProvider wiring, protected /mcp entrypoint
├── auth.ts    # GitHub OAuth: /authorize, consent, /callback, allowlist
├── tools.ts   # The 14 MCP tools
├── steam.ts   # Steam Web API client, batching, formatting
└── types.ts   # Env bindings and authenticated user props
```

Add a tool by registering it in `registerTools()`. Keep an eye on the subrequest budget: one upstream call per game adds up fast.
