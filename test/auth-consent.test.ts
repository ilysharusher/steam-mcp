import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it } from "vitest";
import { authHandler } from "../src/auth";
import { fakeEnv } from "./helpers";

const AUTHORIZE = "https://mcp.example/authorize?client_id=test-client";

function post(headers: Record<string, string>): Request {
  return new Request(AUTHORIZE, { method: "POST", headers });
}

describe("GET /authorize", () => {
  it("renders the consent form naming the client", async () => {
    const res = await authHandler.fetch(new Request(AUTHORIZE), fakeEnv());
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Test Client");
    expect(body).toContain('<form method="POST">');
  });

  it("escapes a hostile client name", async () => {
    const env = fakeEnv();
    env.OAUTH_PROVIDER.lookupClient = (async () => ({
      clientId: "test-client",
      clientName: "<script>alert(1)</script>",
      redirectUris: ["https://client.example/callback"],
      tokenEndpointAuthMethod: "none",
    })) as typeof env.OAUTH_PROVIDER.lookupClient;
    const body = await (await authHandler.fetch(new Request(AUTHORIZE), env)).text();
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;");
  });

  it("answers 502, not 500, when the client metadata document is unreachable", async () => {
    const env = fakeEnv();
    env.OAUTH_PROVIDER.parseAuthRequest = (async () => {
      throw new CimdFetchError("https://client.example/cimd.json", new Error("HTTP 403"));
    }) as typeof env.OAUTH_PROVIDER.parseAuthRequest;
    const res = await authHandler.fetch(new Request(AUTHORIZE), env);
    expect(res.status).toBe(502);
  });

  it("answers 400 on an AuthorizationError with no redirect_uri", async () => {
    const env = fakeEnv();
    env.OAUTH_PROVIDER.parseAuthRequest = (async () => {
      throw new AuthorizationError("invalid_request", { description: "bad scope" });
    }) as typeof env.OAUTH_PROVIDER.parseAuthRequest;
    const res = await authHandler.fetch(new Request(AUTHORIZE), env);
    expect(res.status).toBe(400);
  });

  it("bounces the error back to a validated redirect_uri when there is one", async () => {
    const env = fakeEnv();
    env.OAUTH_PROVIDER.parseAuthRequest = (async () => {
      throw new AuthorizationError("invalid_scope", {
        description: "unknown scope",
        redirectUri: "https://client.example/callback",
        state: "client-state",
      });
    }) as typeof env.OAUTH_PROVIDER.parseAuthRequest;
    const res = await authHandler.fetch(new Request(AUTHORIZE), env);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin).toBe("https://client.example");
    expect(location.searchParams.get("error")).toBe("invalid_scope");
    expect(location.searchParams.get("error_description")).toBe("unknown scope");
    expect(location.searchParams.get("state")).toBe("client-state");
  });
});

describe("POST /authorize is origin-gated", () => {
  it("redirects a same-origin submission to GitHub", async () => {
    const res = await authHandler.fetch(post({ "sec-fetch-site": "same-origin" }), fakeEnv());
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin).toBe("https://github.com");
    expect(location.searchParams.get("client_id")).toBe("gh-client");
    expect(location.searchParams.get("state")).toBeTruthy();
  });

  it("accepts a matching Origin when Sec-Fetch-Site is absent", async () => {
    const res = await authHandler.fetch(post({ origin: "https://mcp.example" }), fakeEnv());
    expect(res.status).toBe(302);
  });

  it("refuses a cross-site submission", async () => {
    const res = await authHandler.fetch(post({ "sec-fetch-site": "cross-site" }), fakeEnv());
    expect(res.status).toBe(400);
  });

  it("refuses a foreign Origin", async () => {
    const res = await authHandler.fetch(post({ origin: "https://evil.example" }), fakeEnv());
    expect(res.status).toBe(400);
  });

  // The load-bearing one. This was a working CSRF hole through to 0.3.0.
  it("fails closed when neither header is present", async () => {
    const res = await authHandler.fetch(post({}), fakeEnv());
    expect(res.status).toBe(400);
  });
});
