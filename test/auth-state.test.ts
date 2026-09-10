import { describe, expect, it } from "vitest";
import { authHandler } from "../src/auth";
import { fakeEnv } from "./helpers";

describe("landing page", () => {
  it("serves the endpoint hint and is never cached", async () => {
    const res = await authHandler.fetch(new Request("https://mcp.example/"), fakeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("/mcp");
  });

  it("404s an unknown path", async () => {
    const res = await authHandler.fetch(new Request("https://mcp.example/nope"), fakeEnv());
    expect(res.status).toBe(404);
  });
});
