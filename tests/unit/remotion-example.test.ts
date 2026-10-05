import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Remotion boundary proof: the example must build, must resolve only Remotion/React,
 * and must expose the approved-only filtering used by compositions.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const examplePath = path.join(repoRoot, "examples", "remotion-consumption.tsx");
const shotsPath = path.join(repoRoot, "examples", "shots.json");

describe("remotion example", () => {
  it("compiles as TSX and bundles nothing but itself", async () => {
    const result = await build({
      entryPoints: [examplePath],
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      external: ["remotion", "react", "react/jsx-runtime", "react/jsx-dev-runtime"],
      loader: { ".tsx": "tsx" },
      jsx: "automatic",
      metafile: true,
      absWorkingDir: repoRoot,
      logLevel: "silent",
    });

    // Nothing but the example itself may be pulled in: no provider SDK, no HTTP client.
    expect(Object.keys(result.metafile.inputs)).toEqual([path.relative(repoRoot, examplePath)]);

    const output = Object.values(result.metafile.outputs)[0];
    const importedPaths = (output?.imports ?? []).map((entry) => entry.path);
    for (const importedPath of importedPaths) {
      expect(["remotion", "react", "react/jsx-runtime", "react/jsx-dev-runtime"]).toContain(
        importedPath,
      );
    }
    expect(importedPaths).toContain("remotion");
    expect(result.outputFiles[0]?.text).toContain("staticFile");
  });

  it("filters to approved shots with a local asset and reads local files only", async () => {
    const module = (await import(pathToFileURL(examplePath).href)) as {
      approvedShots: (list: { project: string; shots: unknown[] }) => { id: string }[];
      DemoLaunchFilm: unknown;
    };
    const shotList = JSON.parse(
      await (await import("node:fs/promises")).readFile(shotsPath, "utf8"),
    ) as { project: string; shots: { id: string; status: string }[] };

    const approved = module.approvedShots(shotList);

    expect(approved.map((shot) => shot.id)).toEqual(["shot-001", "shot-003"]);
    expect(module.DemoLaunchFilm).toBeTypeOf("function");
    for (const shot of approved) {
      expect(shotList.shots.find((entry) => entry.id === shot.id)?.status).toBe("approved");
    }
  });

  it("keeps the documented shot lifecycle and uses it in the example data", async () => {
    const shotList = JSON.parse(
      await (await import("node:fs/promises")).readFile(shotsPath, "utf8"),
    ) as { shots: { status: string }[] };

    const lifecycle = ["planned", "needs_asset", "generating", "generated", "approved", "rejected"];
    for (const shot of shotList.shots) expect(lifecycle).toContain(shot.status);
    expect(shotList.shots.some((shot) => shot.status === "approved")).toBe(true);
    expect(shotList.shots.some((shot) => shot.status === "needs_asset")).toBe(true);
  });
});
