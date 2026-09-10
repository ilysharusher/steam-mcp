import type { Env } from "../types";

const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";
const GITHUB_USER = "https://api.github.com/user";

export interface GithubUser {
  login: string;
  name?: string;
  id: number;
}

/** Where the consent form sends the browser. */
export function authorizeUrl(env: Env, callbackUrl: string, state: string): string {
  const url = new URL(GITHUB_AUTHORIZE);
  url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("scope", "read:user");
  url.searchParams.set("state", state);
  return url.toString();
}

/** Null when GitHub declines: the caller turns that into a 400, never a 500. */
export async function exchangeCode(
  env: Env,
  code: string,
  callbackUrl: string,
): Promise<string | null> {
  const res = await fetch(GITHUB_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl,
    }),
  });
  const body = (await res.json()) as { access_token?: string };
  return body.access_token ?? null;
}

export async function fetchProfile(token: string): Promise<GithubUser | null> {
  const res = await fetch(GITHUB_USER, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "steam-mcp",
    },
  });
  if (!res.ok) return null;
  return (await res.json()) as GithubUser;
}
