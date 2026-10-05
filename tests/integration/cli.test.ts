import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end CLI tests against the built binary and a fake MediaProvider.
 * Everything is observable output: exit codes, JSON on stdout, files on disk,
 * hashes, and the fake provider's recorded call counts.
 */

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliPath = path.join(repoRoot, "dist", "bin", "hf.js");
const fixturePath = path.join(repoRoot, "tests", "fixtures", "fake-provider.mjs");

const sha256Hex = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AL+2gAAAABJRU5ErkJggg==",
  "base64",
);

interface FakeState {
  generate?: number;
  upload?: number;
  motions?: number;
  status?: number;
  downloads?: number;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  parsed?: Record<string, unknown>;
  state: FakeState;
  cwd: string;
}

interface RunOptions {
  scenario?: string;
  downloadFails?: number;
  motionsFails?: number;
  credentials?: boolean;
  cwd?: string;
}

// The CLI under test is the built artifact; `pnpm test` builds it first.
beforeAll(async () => {
  await access(cliPath);
  await access(fixturePath);
}, 30_000);

async function runCli(args: string[], options: RunOptions = {}): Promise<RunResult> {
  const cwd = options.cwd ?? (await mkdtemp(path.join(tmpdir(), "hf-cli-")));
  const stateFile = path.join(cwd, "provider-state.json");
  // Counts accumulate across runs that share a directory: tests assert that a rerun
  // performs zero provider submissions.
  if (!existsSync(stateFile)) await writeFile(stateFile, "{}");

  const env: Record<string, string | undefined> = { ...process.env };
  delete env.HF_DEBUG;
  if (options.credentials === false) {
    delete env.HF_API_KEY;
    delete env.HF_SECRET;
  } else {
    env.HF_API_KEY = "integration-api-key-000";
    env.HF_SECRET = "integration-api-secret-000";
  }
  env.HF_TEST_PROVIDER_MODULE = fixturePath;
  env.HF_FAKE_SCENARIO = options.scenario ?? "image-completed";
  env.HF_FAKE_STATE = stateFile;
  env.HF_FAKE_DOWNLOAD_FAILS = String(options.downloadFails ?? 0);
  env.HF_FAKE_MOTIONS_FAILS = String(options.motionsFails ?? 0);
  env.HF_RETRY_BACKOFF_MS = "10";
  env.HF_RETRY_MAX_BACKOFF_MS = "20";

  let code = 0;
  let stdout = "";
  let stderr = "";
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd,
      env,
      timeout: 60_000,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    code = failure.code ?? 1;
    stdout = failure.stdout ?? "";
    stderr = failure.stderr ?? "";
  }

  const state = JSON.parse(await readFile(stateFile, "utf8")) as FakeState;
  const parsed =
    stdout.trim().length > 0 ? (JSON.parse(stdout.trim()) as Record<string, unknown>) : undefined;
  return { code, stdout, stderr, parsed, state, cwd };
}

function expectSingleJsonLine(result: RunResult): Record<string, unknown> {
  expect(result.stdout.endsWith("\n")).toBe(true);
  expect(result.stdout.trimEnd().includes("\n")).toBe(false);
  expect(result.parsed).toBeDefined();
  return result.parsed as Record<string, unknown>;
}

async function listFiles(directory: string): Promise<string[]> {
  return (await readdir(directory).catch(() => [] as string[])).sort();
}

describe("credential-free commands", () => {
  it("validates a dry run without credentials, writes nothing, and calls no provider", async () => {
    const result = await runCli(
      [
        "image",
        "--prompt",
        "Editorial portrait",
        "--preset",
        "portrait-hd",
        "--output",
        "assets/shot-001",
        "--dry-run",
        "--json",
      ],
      { credentials: false },
    );

    const payload = expectSingleJsonLine(result);
    expect(result.code).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      operation: "text-to-image",
      status: "validated",
      logicalModel: "soul-image",
      dryRun: true,
      outputDirectory: "assets/shot-001",
    });
    expect(payload.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.state).toEqual({});
    expect(await listFiles(result.cwd)).toEqual(["provider-state.json"]);
  });

  it("fails doctor with the authentication exit code and a structured payload", async () => {
    const result = await runCli(["doctor", "--json"], { credentials: false });
    const payload = expectSingleJsonLine(result);

    expect(result.code).toBe(10);
    expect(payload).toMatchObject({
      ok: false,
      error: { code: "AUTHENTICATION_FAILED", retryable: false },
    });
    const details = (payload.error as { details: Record<string, unknown> }).details;
    expect(details).toMatchObject({ providerSupported: true, nodeCompatible: true });
  });

  it("reports a healthy doctor when credentials and provider are available", async () => {
    const result = await runCli(["doctor", "--json"]);
    const payload = expectSingleJsonLine(result);

    expect(result.code).toBe(0);
    expect(payload).toMatchObject({ ok: true, operation: "doctor", status: "completed" });
    expect(payload.details).toMatchObject({
      credentials: { apiKey: true, apiSecret: true },
      discovery: { ok: true, motions: 1 },
    });
    expect(result.state.motions).toBe(1);
  });
});

describe("generation lifecycle", () => {
  it("downloads real media, writes a manifest, and reuses it on an identical rerun", async () => {
    const first = await runCli([
      "image",
      "--prompt",
      "Editorial portrait",
      "--preset",
      "portrait-hd",
      "--output",
      "assets/shot-001",
      "--seed",
      "42",
      "--json",
    ]);

    const firstPayload = expectSingleJsonLine(first);
    expect(first.code).toBe(0);
    expect(firstPayload).toMatchObject({
      ok: true,
      status: "completed",
      requestId: "fake-request-1",
    });
    expect(first.state.generate).toBe(1);

    const outputDirectory = path.join(first.cwd, "assets", "shot-001");
    const files = await listFiles(outputDirectory);
    expect(files).toEqual(["generation.json", "image-01.png"]);
    expect(await readFile(path.join(outputDirectory, "image-01.png"))).toEqual(PNG_1PX);

    const manifest = JSON.parse(
      await readFile(path.join(outputDirectory, "generation.json"), "utf8"),
    ) as {
      fingerprint: string;
      logicalModel: string;
      capability: string;
      outputs: { sha256: string; path: string; bytes: number; mimeType: string }[];
    };
    expect(manifest.fingerprint).toBe(firstPayload.fingerprint);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      logicalModel: "soul-image",
      capability: "text-to-image",
    });
    expect(manifest.outputs[0]).toMatchObject({
      path: "image-01.png",
      bytes: PNG_1PX.byteLength,
      mimeType: "image/png",
    });
    // The manifest must describe the bytes that actually landed on disk.
    expect(manifest.outputs[0]?.sha256).toBe(
      sha256Hex(await readFile(path.join(outputDirectory, "image-01.png"))),
    );

    const second = await runCli(
      [
        "image",
        "--prompt",
        "Editorial portrait",
        "--preset",
        "portrait-hd",
        "--output",
        "assets/shot-001",
        "--seed",
        "42",
        "--json",
      ],
      { cwd: first.cwd },
    );

    const secondPayload = expectSingleJsonLine(second);
    expect(second.code).toBe(0);
    expect(secondPayload).toMatchObject({
      ok: true,
      reused: true,
      fingerprint: manifest.fingerprint,
    });
    expect((secondPayload.assets as { path: string }[])[0]?.path).toBe(
      "assets/shot-001/image-01.png",
    );
    expect(second.state.generate).toBe(1);
    expect(await listFiles(outputDirectory)).toEqual(["generation.json", "image-01.png"]);
  });

  it("refuses to overwrite a different completed generation without --force", async () => {
    const first = await runCli([
      "image",
      "--prompt",
      "First idea",
      "--preset",
      "square-hd",
      "--output",
      "assets/shot-002",
      "--json",
    ]);
    expect(first.code).toBe(0);

    const conflict = await runCli(
      [
        "image",
        "--prompt",
        "Second idea",
        "--preset",
        "square-hd",
        "--output",
        "assets/shot-002",
        "--json",
      ],
      { cwd: first.cwd },
    );
    const payload = expectSingleJsonLine(conflict);
    expect(conflict.code).toBe(12);
    expect(payload).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(conflict.state.generate).toBe(1);

    const forced = await runCli(
      [
        "image",
        "--prompt",
        "Second idea",
        "--preset",
        "square-hd",
        "--output",
        "assets/shot-002",
        "--force",
        "--json",
      ],
      { cwd: first.cwd },
    );
    const forcedPayload = expectSingleJsonLine(forced);
    expect(forced.code).toBe(0);
    expect(forced.state.generate).toBe(2);
    expect(forcedPayload.reused).toBe(false);
  });

  it("names every image of a batch deterministically", async () => {
    const result = await runCli(
      [
        "image",
        "--prompt",
        "Four variants",
        "--preset",
        "square-hd",
        "--batch",
        "4",
        "--output",
        "assets/shot-004",
        "--json",
      ],
      { scenario: "image-completed" },
    );

    expect(result.code).toBe(0);
    expect(await listFiles(path.join(result.cwd, "assets", "shot-004"))).toEqual([
      "generation.json",
      "image-01.png",
      "image-02.png",
      "image-03.png",
      "image-04.png",
    ]);
  });

  it("uploads a local keyframe once and reuses the cached upload URL", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "hf-cli-video-"));
    await mkdir(path.join(cwd, "keyframes"), { recursive: true });
    await writeFile(path.join(cwd, "keyframes", "shot-01.png"), PNG_1PX);

    const args = (output: string) => [
      "video",
      "--input",
      "keyframes/shot-01.png",
      "--prompt",
      "Slow cinematic push-in",
      "--preset",
      "cinematic",
      "--output",
      output,
      "--json",
    ];

    const first = await runCli(args("assets/shot-003"), {
      cwd,
      scenario: "video-completed",
    });
    const payload = expectSingleJsonLine(first);
    expect(first.code).toBe(0);
    expect(payload).toMatchObject({ operation: "image-to-video", status: "completed" });
    expect(first.state.upload).toBe(1);

    const manifest = JSON.parse(
      await readFile(path.join(cwd, "assets", "shot-003", "generation.json"), "utf8"),
    ) as { capability: string; inputs: { localPath: string; sha256: string }[] };
    expect(manifest.capability).toBe("image-to-video");
    expect(manifest.inputs[0]?.localPath).toBe("keyframes/shot-01.png");
    expect(await listFiles(path.join(cwd, "assets", "shot-003"))).toEqual([
      "generation.json",
      "video.mp4",
    ]);

    const second = await runCli(args("assets/shot-004"), {
      cwd,
      scenario: "video-completed",
    });
    expect(second.code).toBe(0);
    expect(second.state.upload).toBe(1);
    expect(second.state.generate).toBe(2);
  });

  it("runs the generic escape hatch and records its capability", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "hf-cli-generic-"));
    await writeFile(path.join(cwd, "request.json"), JSON.stringify({ prompt: "custom" }));

    const result = await runCli(
      [
        "generate",
        "--endpoint",
        "/v1/custom/thing",
        "--input",
        "request.json",
        "--output",
        "assets/custom-001",
        "--json",
      ],
      { cwd, scenario: "generic-completed" },
    );

    const payload = expectSingleJsonLine(result);
    expect(result.code).toBe(0);
    expect(payload).toMatchObject({
      operation: "generic",
      logicalModel: "generic-v1",
      status: "completed",
    });
    const manifest = JSON.parse(
      await readFile(path.join(cwd, "assets", "custom-001", "generation.json"), "utf8"),
    ) as { capability: string; request: { endpoint: string } };
    expect(manifest.capability).toBe("generic");
    expect(manifest.request.endpoint).toBe("/v1/custom/thing");
  });
});

describe("terminal and failure outcomes", () => {
  const scenarios: { scenario: string; code: number; errorCode: string }[] = [
    { scenario: "failed", code: 30, errorCode: "GENERATION_FAILED" },
    { scenario: "nsfw", code: 31, errorCode: "MODERATION_REJECTED" },
    { scenario: "canceled", code: 30, errorCode: "CANCELED" },
    { scenario: "auth-error", code: 10, errorCode: "AUTHENTICATION_FAILED" },
    { scenario: "credits-error", code: 11, errorCode: "INSUFFICIENT_CREDITS" },
    { scenario: "rate-limited", code: 21, errorCode: "RATE_LIMITED" },
    { scenario: "provider-down", code: 20, errorCode: "PROVIDER_UNAVAILABLE" },
  ];

  for (const testCase of scenarios) {
    it(`emits ${testCase.errorCode} with exit ${testCase.code} and no local output`, async () => {
      const result = await runCli(
        [
          "image",
          "--prompt",
          "Editorial portrait",
          "--preset",
          "portrait-hd",
          "--output",
          "assets/shot-fail",
          "--json",
        ],
        { scenario: testCase.scenario },
      );

      const payload = expectSingleJsonLine(result);
      expect(result.code).toBe(testCase.code);
      expect(payload).toMatchObject({ ok: false, error: { code: testCase.errorCode } });
      // Generation is submitted once; only read-only operations may be retried.
      expect(result.state.generate).toBe(1);
      expect(await listFiles(path.join(result.cwd, "assets", "shot-fail"))).toEqual([]);
    });
  }

  it("retries a transient download failure and still writes the manifest", async () => {
    const result = await runCli(
      [
        "image",
        "--prompt",
        "Editorial portrait",
        "--preset",
        "portrait-hd",
        "--output",
        "assets/shot-flaky",
        "--json",
      ],
      { scenario: "flaky-download", downloadFails: 2 },
    );

    const payload = expectSingleJsonLine(result);
    expect(result.code).toBe(0);
    expect(payload).toMatchObject({ ok: true, status: "completed" });
    expect(result.state.downloads).toBe(3);
    expect(await listFiles(path.join(result.cwd, "assets", "shot-flaky"))).toEqual([
      "generation.json",
      "image-01.png",
    ]);
  });

  it("does not retry a permanent download failure and leaves no partial files", async () => {
    const result = await runCli(
      [
        "image",
        "--prompt",
        "Editorial portrait",
        "--preset",
        "portrait-hd",
        "--output",
        "assets/shot-missing",
        "--json",
      ],
      { scenario: "missing-asset", downloadFails: 0 },
    );

    const payload = expectSingleJsonLine(result);
    expect(result.code).toBe(40);
    expect(payload).toMatchObject({ ok: false, error: { code: "DOWNLOAD_FAILED" } });
    expect(result.state.downloads).toBe(1);
    expect(await listFiles(path.join(result.cwd, "assets", "shot-missing"))).toEqual([]);
  });

  it("rejects downloaded content of the wrong media kind", async () => {
    const result = await runCli(
      [
        "image",
        "--prompt",
        "Editorial portrait",
        "--preset",
        "portrait-hd",
        "--output",
        "assets/shot-wrong",
        "--json",
      ],
      { scenario: "wrong-kind" },
    );

    const payload = expectSingleJsonLine(result);
    expect(result.code).toBe(40);
    expect(payload).toMatchObject({
      ok: false,
      error: { code: "DOWNLOAD_FAILED", retryable: false },
    });
    expect(await listFiles(path.join(result.cwd, "assets", "shot-wrong"))).toEqual([]);
  });
});

describe("discovery, status, and usage errors", () => {
  it("caches motions and refreshes on request", async () => {
    const first = await runCli(["motions", "--json"]);
    expect(first.code).toBe(0);
    expect(first.state.motions).toBe(1);

    const cached = await runCli(["motions", "--json"], { cwd: first.cwd });
    const payload = expectSingleJsonLine(cached);
    expect(cached.state.motions).toBe(1);
    expect(payload.details).toMatchObject({ count: 1, fromCache: true, stale: false });

    const refreshed = await runCli(["motions", "--refresh", "--json"], { cwd: first.cwd });
    expect(refreshed.state.motions).toBe(2);
  });

  it("serves a stale cache when a refresh fails", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "hf-cli-stale-"));
    const warm = await runCli(["motions", "--json"], { cwd });
    expect(warm.code).toBe(0);

    const stale = await runCli(["motions", "--refresh", "--json"], { cwd, motionsFails: 5 });
    const payload = expectSingleJsonLine(stale);
    expect(stale.code).toBe(0);
    expect(payload.details).toMatchObject({ stale: true, fromCache: true, count: 1 });
    expect(stale.stderr).toContain("stale cached motions");
  });

  it("inspects a request id without touching local state", async () => {
    const result = await runCli(["status", "fake-request-1", "--json"]);
    const payload = expectSingleJsonLine(result);

    expect(result.code).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      operation: "status",
      requestId: "fake-request-1",
      status: "in_progress",
    });
    expect(result.state.status).toBe(1);
    expect(await listFiles(result.cwd)).toEqual(["provider-state.json"]);
  });

  it("creates and lists character references", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "hf-cli-char-"));
    await writeFile(path.join(cwd, "face.png"), PNG_1PX);

    const created = await runCli(
      ["characters", "create", "--name", "Hero", "--reference", "face.png", "--json"],
      { cwd },
    );
    const payload = expectSingleJsonLine(created);
    expect(created.code).toBe(0);
    expect(payload).toMatchObject({ operation: "character-reference", status: "completed" });
    expect(created.state.upload).toBe(1);

    const listed = await runCli(["characters", "list", "--json"], { cwd });
    const listedPayload = expectSingleJsonLine(listed);
    expect(listedPayload.details).toMatchObject({ total: 1, page: 1, pageSize: 20 });
  });

  it("uses exit code 2 for invalid usage and unknown commands", async () => {
    const badFlag = await runCli([
      "image",
      "--prompt",
      "x",
      "--preset",
      "portrait-hd",
      "--output",
      "o",
      "--batch",
      "3",
      "--json",
    ]);
    expect(badFlag.code).toBe(2);
    expect(expectSingleJsonLine(badFlag)).toMatchObject({ ok: false });

    const unknown = await runCli(["nope", "--json"]);
    expect(unknown.code).toBe(2);

    const missingRequired = await runCli([
      "image",
      "--preset",
      "portrait-hd",
      "--output",
      "o",
      "--json",
    ]);
    expect(missingRequired.code).toBe(2);
  });

  it("rejects unsupported providers through the config validator", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "hf-cli-provider-"));
    const result = await runCli(["doctor", "--json"], { cwd, credentials: false });
    expect(result.code).toBe(10);

    const stateFile = path.join(cwd, "provider-state.json");
    await writeFile(stateFile, "{}");
    let code = 0;
    let stdout = "";
    try {
      const run = await execFileAsync(process.execPath, [cliPath, "doctor", "--json"], {
        cwd,
        env: { ...process.env, HF_PROVIDER: "higgsfield-v9", HF_FAKE_STATE: stateFile },
      });
      stdout = run.stdout;
    } catch (error) {
      const failure = error as { code?: number; stdout?: string };
      code = failure.code ?? 1;
      stdout = failure.stdout ?? "";
    }
    expect(code).toBe(12);
    expect(JSON.parse(stdout.trim())).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
  });
});
