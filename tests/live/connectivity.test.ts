import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Live, non-billable checks against the real Higgsfield API.
 *
 * Gated twice: `HF_LIVE_TEST=1` must be set AND credentials must be present.
 * Nothing here generates or uploads; only doctor, discovery, and a status probe
 * (which is expected to answer or fail with a normalized error) run.
 */

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliPath = path.join(repoRoot, "dist", "bin", "hf.js");

const liveEnabled = process.env.HF_LIVE_TEST === "1";
const hasCredentials =
  (process.env.HF_API_KEY ?? "").length > 0 && (process.env.HF_SECRET ?? "").length > 0;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[]): Promise<RunResult> {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env: process.env,
      timeout: 240_000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

function parseJson(result: RunResult): Record<string, unknown> {
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

beforeAll(async () => {
  if (!liveEnabled || !hasCredentials) return;
  await access(cliPath); // build first: `pnpm build`
}, 30_000);

describe.skipIf(!liveEnabled || !hasCredentials)("live connectivity", () => {
  it("passes doctor against the real API", async () => {
    const result = await runCli(["doctor", "--json"]);
    const payload = parseJson(result);

    expect(result.code).toBe(0);
    expect(payload).toMatchObject({ ok: true, operation: "doctor", status: "completed" });
    expect(payload.details).toMatchObject({
      credentials: { apiKey: true, apiSecret: true },
      discovery: { ok: true },
    });
  });

  it("lists motions and styles", async () => {
    const motions = await runCli(["motions", "--refresh", "--json"]);
    expect(motions.code).toBe(0);
    const motionPayload = parseJson(motions);
    expect(motionPayload.details).toMatchObject({ stale: false });
    expect((motionPayload.details as { count: number }).count).toBeGreaterThan(0);

    const styles = await runCli(["styles", "--refresh", "--json"]);
    expect(styles.code).toBe(0);
    expect(parseJson(styles).details).toMatchObject({ stale: false });
  });

  it("answers for an unknown request id with a normalized error or a status", async () => {
    const result = await runCli(["status", "00000000-0000-0000-0000-000000000000", "--json"]);
    const payload = parseJson(result);

    expect([0, 20]).toContain(result.code);
    if (result.code === 0) {
      expect(payload).toMatchObject({ ok: true, operation: "status" });
    } else {
      expect(payload).toMatchObject({ ok: false });
      expect([
        "UNKNOWN_PROVIDER_ERROR",
        "PROVIDER_UNAVAILABLE",
        "VALIDATION_FAILED",
        "AUTHENTICATION_FAILED",
      ]).toContain((payload.error as { code: string }).code);
    }
  });
});
