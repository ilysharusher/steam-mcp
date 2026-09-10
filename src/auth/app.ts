/**
 * GitHub as the identity provider for the OAuth 2.1 flow.
 *
 *   GET  /authorize  -> validate the OAuth request, render a consent page
 *   POST /authorize  -> sign the request into `state`, redirect to GitHub
 *   GET  /callback   -> verify the state, exchange the code, check the
 *                       allowlist, complete authorization
 *
 * The pending authorization request travels in a signed `state` parameter
 * rather than a cookie: no cookie parsing, and nothing to leak if a redirect is
 * replayed, because the HMAC covers the whole payload. The envelope also carries
 * an issue time, so a captured state stops being usable after STATE_TTL_MS.
 */
import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { Env, Props } from "../types";
import { allowlist } from "./allowlist";
import { authorizeUrl, exchangeCode, fetchProfile } from "./github";
import { decodeState, encodeState } from "./state";
import { escapeHtml, page } from "./ui";

const app = new Hono<{ Bindings: Env }>();

/**
 * The consent form is the only human gate in this flow. Without this check a
 * cross-site auto-submitting form walks straight through it and the resulting
 * code lands on the attacker's redirect_uri — PKCE does not help, because the
 * attacker generated the challenge. Browsers always send Origin on a form POST,
 * so the absence of both signals is treated as suspicious rather than fine.
 */
const requireSameOrigin = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const site = c.req.header("sec-fetch-site");
  const ok = site
    ? site === "same-origin"
    : c.req.header("origin") === new URL(c.req.url).origin;
  if (!ok) {
    return page("Bad request", "<p>This request did not come from the consent page.</p>", 400);
  }
  await next();
});

app.get("/", () =>
  page(
    "Steam MCP server",
    `<p>Remote MCP endpoint: <code>/mcp</code></p>
         <p class="muted">Connect an MCP client to this URL; it will walk you through GitHub sign-in.</p>`,
  ),
);

app.get("/authorize", async (c) => {
  const oauthRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) return page("Unknown client", "<p>This OAuth client is not recognised.</p>", 400);

  const name = escapeHtml(client.clientName ?? oauthRequest.clientId);
  return page(
    "Authorize access",
    `<p><strong>${name}</strong> is requesting access to this Steam MCP server.</p>
         <p class="muted">You will sign in with GitHub. Access is granted only to allow-listed accounts.</p>
         <form method="POST"><button type="submit">Continue with GitHub</button></form>`,
  );
});

app.post("/authorize", requireSameOrigin, async (c) => {
  const oauthRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) return page("Unknown client", "<p>This OAuth client is not recognised.</p>", 400);

  const state = await encodeState(oauthRequest, c.env.AUTH_STATE_SECRET);
  const callbackUrl = new URL("/callback", c.req.url).toString();
  return c.redirect(authorizeUrl(c.env, callbackUrl, state), 302);
});

app.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return page("Bad request", "<p>Missing code or state.</p>", 400);

  const envelope = await decodeState(state, c.env.AUTH_STATE_SECRET);
  if (!envelope) {
    return page("Bad request", "<p>This sign-in link is invalid or expired.</p>", 400);
  }

  const callbackUrl = new URL("/callback", c.req.url).toString();
  const token = await exchangeCode(c.env, code, callbackUrl);
  if (!token) {
    return page("Sign-in failed", "<p>GitHub did not return an access token.</p>", 400);
  }

  const user = await fetchProfile(token);
  if (!user) return page("Sign-in failed", "<p>Could not read the GitHub profile.</p>", 400);

  const allowed = allowlist(c.env);
  if (allowed.length && !allowed.includes(user.login.toLowerCase())) {
    return page(
      "Access denied",
      `<p>The GitHub account <code>${escapeHtml(user.login)}</code> is not on this server's allowlist.</p>`,
      403,
    );
  }

  const props: Props = { login: user.login, name: user.name ?? user.login, githubId: user.id };
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: envelope.r,
    userId: String(user.id),
    metadata: { login: user.login },
    scope: envelope.r.scope,
    props,
  });
  return c.redirect(redirectTo, 302);
});

app.notFound(() => new Response("Not found", { status: 404 }));

/**
 * CIMD documents are fetched live on every /authorize, so a slow or broken one
 * is the client's problem and must not surface as a 500. AuthorizationError
 * carries its own redirect target when the client supplied a usable one.
 */
app.onError((error) => {
  if (error instanceof CimdFetchError) {
    return page(
      "Client metadata unavailable",
      "<p>This client's metadata document could not be fetched. Try again shortly.</p>",
      502,
    );
  }
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
});

export default app;
