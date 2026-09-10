import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SteamMcp } from "../src/index";
import type { Env, Props } from "../src/types";
import { fakeEnv } from "./helpers";

/**
 * The API-side half of the double allowlist check. This is the one that can
 * actually revoke a live grant: the sign-in check only runs once, so a login
 * removed from ALLOWED_GITHUB_LOGINS would keep working until its token expired.
 */
function entrypoint(login: string, allowed: string) {
  const ctx = createExecutionContext() as ExecutionContext & { props: Props };
  ctx.props = { login, name: login, githubId: 1 };
  return new SteamMcp(ctx, fakeEnv({ ALLOWED_GITHUB_LOGINS: allowed }));
}

const mcpRequest = () =>
  new Request("https://mcp.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

describe("SteamMcp re-checks the allowlist on every request", () => {
  it("403s a login that has been removed from the allowlist", async () => {
    const res = await entrypoint("revoked-user", "ilysharusher").fetch(mcpRequest());
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
  });

  it("is case-insensitive, matching the sign-in check", async () => {
    const res = await entrypoint("ILYSHARUSHER", "ilysharusher").fetch(mcpRequest());
    expect(res.status).not.toBe(403);
  });

  it("lets an allow-listed login through to the MCP handler", async () => {
    const res = await entrypoint("ilysharusher", "ilysharusher").fetch(mcpRequest());
    expect(res.status).not.toBe(403);
    // Proves the request reached the MCP layer rather than failing some other
    // way: only the handler answers tools/list, and it lists all twelve.
    const body = await res.text();
    expect(body).toContain("list_library");
    expect(body).toContain("wishlist");
  });

  // Fail-closed since 0.4.1. An empty variable is a misconfiguration, and the
  // safe reading of a misconfigured allowlist is "nobody", not "everybody".
  it("denies everyone when the allowlist is empty", async () => {
    const res = await entrypoint("nobody-in-particular", "").fetch(mcpRequest());
    expect(res.status).toBe(403);
  });

  it("denies everyone when the variable is missing entirely", async () => {
    const ctx = createExecutionContext() as ExecutionContext & { props: Props };
    ctx.props = { login: "ilysharusher", name: "Ilya", githubId: 1 };
    const env = fakeEnv();
    delete (env as Partial<Env>).ALLOWED_GITHUB_LOGINS;
    const res = await new SteamMcp(ctx, env).fetch(mcpRequest());
    expect(res.status).toBe(403);
  });

  it("ignores whitespace and empty entries around real logins", async () => {
    const res = await entrypoint("ilysharusher", " , ilysharusher ,, ").fetch(mcpRequest());
    expect(res.status).not.toBe(403);
  });
});
