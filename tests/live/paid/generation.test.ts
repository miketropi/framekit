import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * BILLABLE live generation. Never runs automatically: it requires
 * `HF_LIVE_PAID_TEST=1` plus credentials, and it submits one small image request.
 * Multiplied by `HF_LIVE_PAID_VARIANTS` (default 1) so operators stay in control.
 */

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const cliPath = path.join(repoRoot, "dist", "bin", "hf.js");

const paidEnabled = process.env.HF_LIVE_PAID_TEST === "1";
const hasCredentials =
  (process.env.HF_API_KEY ?? "").length > 0 && (process.env.HF_SECRET ?? "").length > 0;
const variants = Number(process.env.HF_LIVE_PAID_VARIANTS ?? "1");

beforeAll(async () => {
  if (!paidEnabled || !hasCredentials) return;
  await access(cliPath); // build first: `pnpm build`
}, 30_000);

describe.skipIf(!paidEnabled || !hasCredentials)("live paid generation", () => {
  it("generates one text-to-image asset with a manifest", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "hf-live-paid-"));
    const result = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "image",
        "--prompt",
        "Plain grey studio backdrop, soft even lighting, minimal product photography",
        "--preset",
        "square-hd",
        "--batch",
        variants === 4 ? "4" : "1",
        "--output",
        "assets/live-smoke",
        "--json",
      ],
      { cwd, env: process.env, timeout: 600_000 },
    );

    const payload = JSON.parse(result.stdout.trim()) as {
      ok: boolean;
      status: string;
      assets: { path: string; sha256: string; bytes: number }[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.status).toBe("completed");

    const files = (await readdir(path.join(cwd, "assets", "live-smoke"))).sort();
    expect(files).toContain("generation.json");
    for (const asset of payload.assets) {
      expect(asset.bytes).toBeGreaterThan(0);
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(await readFile(path.join(cwd, asset.path))).toBeTruthy();
    }

    const manifest = JSON.parse(
      await readFile(path.join(cwd, "assets", "live-smoke", "generation.json"), "utf8"),
    ) as { schemaVersion: number; outputs: unknown[] };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.outputs).toHaveLength(payload.assets.length);
  });
});
