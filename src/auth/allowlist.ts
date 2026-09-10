import type { Env } from "../types";

/**
 * Logins permitted to sign in. Empty means anyone — deliberate, and deliberately
 * risky: keep a value in ALLOWED_GITHUB_LOGINS. Shared with the API handler,
 * which re-checks it on every request, because grants outlive a config change.
 */
export function allowlist(env: Env): string[] {
  return (env.ALLOWED_GITHUB_LOGINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
