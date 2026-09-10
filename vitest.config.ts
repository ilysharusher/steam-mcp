import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Tests run in workerd, not Node. Required, not a preference:
  // @cloudflare/workers-oauth-provider imports "cloudflare:workers", which no
  // Node loader resolves. Running here also means the suite exercises the same
  // runtime as production, with the same compatibility flags.
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
