import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "bin/hf": "bin/hf.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  dts: { entry: { index: "src/index.ts" } },
  sourcemap: true,
  splitting: false,
  shims: false,
  banner: { js: "" },
  external: ["@higgsfield/client"],
});
