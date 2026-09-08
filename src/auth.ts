/**
 * GitHub as the identity provider for the OAuth 2.1 flow.
 *
 * Flow:
 *   GET  /authorize  -> parse + validate the OAuth request, render a consent page
 *   POST /authorize  -> sign the request into `state`, redirect to GitHub
 *   GET  /callback   -> verify signature, exchange code, check the allowlist,
 *                       complete authorization, redirect back to the client
 *
 * The pending authorization request travels in a signed `state` parameter
 * rather than a cookie: no cookie parsing, and nothing to leak if a redirect
 * is replayed, because the HMAC covers the whole payload.
 */
import { AuthorizationError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env, Props } from "./types";

const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";
const GITHUB_USER = "https://api.github.com/user";

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(payload: string, secret: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

async function verify(token: string, secret: string): Promise<string | null> {
  const idx = token.lastIndexOf(".");
  if (idx < 0) return null;
  const payload = token.slice(0, idx);
  const ok = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    unb64url(token.slice(idx + 1)),
    encoder.encode(payload),
  );
  return ok ? payload : null;
}

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:12vh auto;padding:0 1.5rem;color:#111}
 h1{font-size:1.3rem;margin:0 0 1rem}
 code{background:#f2f2f2;padding:.1rem .35rem;border-radius:3px;font-size:.9em}
 button{font:inherit;background:#111;color:#fff;border:0;border-radius:6px;padding:.6rem 1.2rem;cursor:pointer}
 .muted{color:#666;font-size:.9rem}
</style>
<h1>${title}</h1>${body}`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function allowlist(env: Env): string[] {
  return (env.ALLOWED_GITHUB_LOGINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const authHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ---- /authorize --------------------------------------------------------
    if (url.pathname === "/authorize") {
      let oauthRequest: AuthRequest;
      try {
        oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      } catch (error) {
        if (!(error instanceof AuthorizationError)) throw error;
        if (!error.redirectUri) {
          return page("Authorization error", `<p>${escapeHtml(error.description)}</p>`, 400);
        }
        const redirect = new URL(error.redirectUri);
        redirect.searchParams.set("error", error.code);
        redirect.searchParams.set("error_description", error.description);
        if (error.state) redirect.searchParams.set("state", error.state);
        if (error.issuer) redirect.searchParams.set("iss", error.issuer);
        return Response.redirect(redirect.toString(), 302);
      }

      const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
      if (!client) return page("Unknown client", "<p>This OAuth client is not recognised.</p>", 400);

      const state = await sign(
        b64url(encoder.encode(JSON.stringify(oauthRequest))),
        env.AUTH_STATE_SECRET,
      );

      if (request.method === "POST") {
        const gh = new URL(GITHUB_AUTHORIZE);
        gh.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
        gh.searchParams.set("redirect_uri", new URL("/callback", request.url).toString());
        gh.searchParams.set("scope", "read:user");
        gh.searchParams.set("state", state);
        return Response.redirect(gh.toString(), 302);
      }

      const name = escapeHtml(client.clientName ?? oauthRequest.clientId);
      return page(
        "Authorize access",
        `<p><strong>${name}</strong> is requesting access to this Steam MCP server.</p>
         <p class="muted">You will sign in with GitHub. Access is granted only to allow-listed accounts.</p>
         <form method="POST"><button type="submit">Continue with GitHub</button></form>`,
      );
    }

    // ---- /callback ---------------------------------------------------------
    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) return page("Bad request", "<p>Missing code or state.</p>", 400);

      const payload = await verify(state, env.AUTH_STATE_SECRET);
      if (!payload) return page("Bad request", "<p>State signature is invalid.</p>", 400);

      const oauthRequest = JSON.parse(new TextDecoder().decode(unb64url(payload))) as AuthRequest;

      const tokenRes = await fetch(GITHUB_TOKEN, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: new URL("/callback", request.url).toString(),
        }),
      });
      const tokenJson = (await tokenRes.json()) as { access_token?: string };
      if (!tokenJson.access_token) {
        return page("Sign-in failed", "<p>GitHub did not return an access token.</p>", 400);
      }

      const userRes = await fetch(GITHUB_USER, {
        headers: {
          authorization: `Bearer ${tokenJson.access_token}`,
          accept: "application/vnd.github+json",
          "user-agent": "steam-mcp",
        },
      });
      if (!userRes.ok) return page("Sign-in failed", "<p>Could not read the GitHub profile.</p>", 400);

      const user = (await userRes.json()) as { login: string; name?: string; id: number };
      const allowed = allowlist(env);
      if (allowed.length && !allowed.includes(user.login.toLowerCase())) {
        return page(
          "Access denied",
          `<p>The GitHub account <code>${escapeHtml(user.login)}</code> is not on this server's allowlist.</p>`,
          403,
        );
      }

      const props: Props = { login: user.login, name: user.name ?? user.login, githubId: user.id };

      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthRequest,
        userId: String(user.id),
        metadata: { login: user.login },
        scope: oauthRequest.scope,
        props,
      });

      return Response.redirect(redirectTo, 302);
    }

    // ---- landing -----------------------------------------------------------
    if (url.pathname === "/") {
      return page(
        "Steam MCP server",
        `<p>Remote MCP endpoint: <code>/mcp</code></p>
         <p class="muted">Connect an MCP client to this URL; it will walk you through GitHub sign-in.</p>`,
      );
    }

    return new Response("Not found", { status: 404 });
  },
};
