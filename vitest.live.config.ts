import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Live suites: real network, opt-in only. Run via `pnpm test:live` or `pnpm test:live:paid`. */
export default defineConfig({
  resolve: {
    alias: { remotion: path.join(here, "tests", "fixtures", "remotion-stub.tsx") },
  },
  test: {
    environment: "node",
    include: ["tests/live/**/*.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    passWithNoTests: false,
  },
});
