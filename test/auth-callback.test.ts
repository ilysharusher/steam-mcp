import { afterEach, describe, expect, it, vi } from "vitest";
import authHandler from "../src/auth/app";
import { AUTH_REQUEST, fakeEnv, signState } from "./helpers";

const SECRET = "test-secret-value";

function callback(params: Record<string, string>): Request {
  const url = new URL("https://mcp.example/callback");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url.toString());
}

/** GitHub returns a token, then a profile. Two calls, in that order. */
function stubGithub(login: string): void {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ access_token: "gho_test" }))
    .mockResolvedValueOnce(Response.json({ login, name: "Test User", id: 42 }));
  vi.stubGlobal("fetch", fetchMock);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /callback state validation", () => {
  it("400s with no code or state", async () => {
    expect((await authHandler.fetch(callback({}), fakeEnv())).status).toBe(400);
  });

  it("400s on a forged signature", async () => {
    const res = await authHandler.fetch(
      callback({ code: "x", state: "payload.notasignature" }),
      fakeEnv(),
    );
    expect(res.status).toBe(400);
  });

  // atob throws on non-base64, and this runs on unauthenticated input.
  it("400s rather than 500s on a non-base64 signature", async () => {
    const res = await authHandler.fetch(callback({ code: "x", state: "a.!!!!" }), fakeEnv());
    expect(res.status).toBe(400);
  });

  it("400s on a state with no separator at all", async () => {
    const res = await authHandler.fetch(callback({ code: "x", state: "nodot" }), fakeEnv());
    expect(res.status).toBe(400);
  });

  // The signature here is genuine, so this is the only case in this block that
  // reaches the TTL branch. The message assertion below does not prove that —
  // decodeState answers "invalid or expired" for all four failure modes on
  // purpose, since an unauthenticated caller learns nothing from the difference.
  it("400s on a correctly signed but expired state", async () => {
    const eleven = Date.now() - 11 * 60_000;
    const state = await signState(AUTH_REQUEST, SECRET, eleven);
    const res = await authHandler.fetch(callback({ code: "x", state }), fakeEnv());
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("expired");
  });
});

describe("GET /callback allowlist", () => {
  it("403s a login that is not allow-listed", async () => {
    stubGithub("someone-else");
    const state = await signState(AUTH_REQUEST, SECRET);
    const res = await authHandler.fetch(callback({ code: "x", state }), fakeEnv());
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("someone-else");
  });

  it("escapes the rejected login in the denial page", async () => {
    stubGithub("<img src=x>");
    const state = await signState(AUTH_REQUEST, SECRET);
    const res = await authHandler.fetch(callback({ code: "x", state }), fakeEnv());
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).not.toContain("<img src=x>");
    expect(body).toContain("&lt;img");
  });

  it("never caches the denial page", async () => {
    stubGithub("someone-else");
    const state = await signState(AUTH_REQUEST, SECRET);
    const res = await authHandler.fetch(callback({ code: "x", state }), fakeEnv());
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("denies sign-in entirely when the allowlist is empty", async () => {
    stubGithub("anyone-at-all");
    const state = await signState(AUTH_REQUEST, SECRET);
    const res = await authHandler.fetch(
      callback({ code: "x", state }),
      fakeEnv({ ALLOWED_GITHUB_LOGINS: "" }),
    );
    expect(res.status).toBe(403);
  });

  it("completes authorization for an allow-listed login", async () => {
    stubGithub("ilysharusher");
    const state = await signState(AUTH_REQUEST, SECRET);
    const res = await authHandler.fetch(callback({ code: "x", state }), fakeEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://client.example/callback?code=abc");
  });
});

/**
 * encodeState and decodeState were otherwise each pinned only against the
 * independent signer in test/helpers.ts, never against each other. A drift in
 * the envelope shape would satisfy both halves separately and still break the
 * live flow.
 */
describe("state survives a round trip through the server's own signer", () => {
  it("accepts a state the consent POST just produced", async () => {
    const env = fakeEnv();
    const consent = await authHandler.fetch(
      new Request("https://mcp.example/authorize?client_id=test-client", {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
      }),
      env,
    );
    const state = new URL(consent.headers.get("location") ?? "").searchParams.get("state");
    expect(state).toBeTruthy();

    stubGithub("ilysharusher");
    const res = await authHandler.fetch(callback({ code: "x", state: state! }), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://client.example/callback?code=abc");
  });
});
