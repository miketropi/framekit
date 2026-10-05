import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // The Remotion example targets a Remotion project; this repository does not
      // install Remotion or React. The stub lets the example's logic execute here.
      remotion: path.join(here, "tests", "fixtures", "remotion-stub.tsx"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/live/**", "**/node_modules/**", "**/dist/**"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    passWithNoTests: false,
  },
});
