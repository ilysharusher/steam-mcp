import type { Env } from "../types";

/**
 * Who may sign in. An empty or missing ALLOWED_GITHUB_LOGINS denies everyone.
 *
 * It used to admit everyone. That made a single dropped variable — a typo, an
 * edit to wrangler.jsonc, a deploy from an environment where vars did not load
 * — silently open this Steam account to anyone with a GitHub login, with no
 * error and nothing in any log. Locking yourself out is recoverable with one
 * deploy and is obvious the moment it happens; the other direction is neither.
 *
 * Called from two places on purpose: at sign-in, and again in SteamMcp.fetch on
 * every request, because grants outlive a config change. Keeping the rule in
 * this predicate rather than in a list the callers interpret is what stops the
 * two sites from drifting apart.
 */
export function isAllowed(env: Env, login: string): boolean {
  const allowed = (env.ALLOWED_GITHUB_LOGINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(login.toLowerCase());
}
