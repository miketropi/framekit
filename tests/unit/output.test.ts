import { describe, expect, it } from "vitest";
import { CliOutput, renderEnvelopeHuman, type WritableLike } from "../../src/cli/output";
import { EXIT_CODES, EXIT_CODE_BY_ERROR, exitCodeForErrorCode } from "../../src/cli/exit-codes";
import { TOOL_ERROR_CODES, ToolError } from "../../src/domain/errors";

class CapturingWritable implements WritableLike {
  chunks: string[] = [];

  write(chunk: string): unknown {
    this.chunks.push(chunk);
    return true;
  }

  get text(): string {
    return this.chunks.join("");
  }
}

function buildOutput(json: boolean, debug = false) {
  const stdout = new CapturingWritable();
  const stderr = new CapturingWritable();
  return { stdout, stderr, output: new CliOutput({ stdout, stderr, json, debug }) };
}

describe("JSON output contract", () => {
  it("writes exactly one compact JSON document plus a newline to stdout", () => {
    const { stdout, stderr, output } = buildOutput(true);
    output.result({
      envelope: {
        ok: true,
        operation: "text-to-image",
        provider: "higgsfield-v1",
        status: "completed",
        requestId: "req-1",
        fingerprint: `sha256:${"a".repeat(64)}`,
        outputDirectory: "assets/shot-001",
        manifest: "assets/shot-001/generation.json",
        assets: [
          {
            type: "image",
            path: "assets/shot-001/image-01.png",
            mimeType: "image/png",
            sha256: "b".repeat(64),
            bytes: 12,
          },
        ],
      },
    });

    expect(stdout.text.endsWith("\n")).toBe(true);
    expect(stdout.text.trimEnd().includes("\n")).toBe(false);
    expect(JSON.parse(stdout.text)).toMatchObject({ ok: true, operation: "text-to-image" });
    expect(stderr.text).toBe("");
  });

  it("keeps stdout JSON-only while progress goes to stderr", () => {
    const { stdout, stderr, output } = buildOutput(true);
    output.progress("preparing text-to-image");
    output.warn("careful");
    output.result({
      envelope: { ok: true, operation: "image", provider: "higgsfield-v1", status: "completed" },
    });

    expect(JSON.parse(stdout.text)).toMatchObject({ ok: true });
    expect(stderr.text).toContain("[info] preparing text-to-image");
    expect(stderr.text).toContain("[warn] careful");
  });

  it("serializes failures as one JSON failure envelope on stdout", () => {
    const { stdout, stderr, output } = buildOutput(true);
    output.failure(
      new ToolError({ code: "INSUFFICIENT_CREDITS", message: "no credits", retryable: false }),
      EXIT_CODES.INSUFFICIENT_CREDITS,
    );

    const parsed = JSON.parse(stdout.text) as { ok: boolean; error: Record<string, unknown> };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatchObject({ code: "INSUFFICIENT_CREDITS", retryable: false });
    expect(parsed).not.toHaveProperty("details");
    expect(stderr.text).toContain("exit 11");
  });

  it("prints human diagnostics to stderr and hides stacks unless debugging", () => {
    const quiet = buildOutput(false);
    quiet.output.failure(new ToolError({ code: "PROVIDER_UNAVAILABLE", message: "down" }), 20);
    expect(quiet.stdout.text).toBe("");
    expect(quiet.stderr.text).toContain("PROVIDER_UNAVAILABLE: down");

    const verbose = buildOutput(false, true);
    const error = new ToolError({
      code: "PROVIDER_UNAVAILABLE",
      message: "down",
      details: { status: 503 },
    });
    verbose.output.failure(error, 20);
    expect(verbose.stderr.text).toContain('"status": 503');
    expect(verbose.stderr.text.length).toBeGreaterThan(quiet.stderr.text.length);
  });

  it("renders a compact human summary", () => {
    const lines = renderEnvelopeHuman({
      ok: true,
      operation: "image-to-video",
      provider: "higgsfield-v1",
      status: "completed",
      requestId: "req-1",
      fingerprint: `sha256:${"a".repeat(64)}`,
      outputDirectory: "assets/shot-003",
      manifest: "assets/shot-003/generation.json",
      inputs: [{ kind: "image", localPath: "keyframe.png", sha256: "c".repeat(64) }],
      assets: [
        {
          type: "video",
          path: "assets/shot-003/video.mp4",
          mimeType: "video/mp4",
          sha256: "d".repeat(64),
          bytes: 99,
        },
      ],
    });

    expect(lines.join("\n")).toContain("image-to-video: completed");
    expect(lines.join("\n")).toContain("assets/shot-003/video.mp4");
    expect(lines.join("\n")).toContain("keyframe.png");
  });
});

describe("exit codes", () => {
  it("maps every error code exactly once", () => {
    for (const code of TOOL_ERROR_CODES) {
      expect(EXIT_CODE_BY_ERROR[code]).toBeTypeOf("number");
      expect(exitCodeForErrorCode(code)).toBe(EXIT_CODE_BY_ERROR[code]);
    }
  });

  it("follows the documented §27 values", () => {
    expect(exitCodeForErrorCode("AUTHENTICATION_FAILED")).toBe(10);
    expect(exitCodeForErrorCode("INSUFFICIENT_CREDITS")).toBe(11);
    expect(exitCodeForErrorCode("INVALID_INPUT")).toBe(12);
    expect(exitCodeForErrorCode("VALIDATION_FAILED")).toBe(12);
    expect(exitCodeForErrorCode("PROVIDER_UNAVAILABLE")).toBe(20);
    expect(exitCodeForErrorCode("RATE_LIMITED")).toBe(21);
    expect(exitCodeForErrorCode("TIMEOUT")).toBe(22);
    expect(exitCodeForErrorCode("GENERATION_FAILED")).toBe(30);
    expect(exitCodeForErrorCode("CANCELED")).toBe(30);
    expect(exitCodeForErrorCode("MODERATION_REJECTED")).toBe(31);
    expect(exitCodeForErrorCode("UPLOAD_FAILED")).toBe(40);
    expect(exitCodeForErrorCode("DOWNLOAD_FAILED")).toBe(40);
    expect(exitCodeForErrorCode("LOCAL_IO_ERROR")).toBe(50);
    expect(exitCodeForErrorCode("UNKNOWN_PROVIDER_ERROR")).toBe(20);
    expect(EXIT_CODES.SUCCESS).toBe(0);
    expect(EXIT_CODES.INVALID_USAGE).toBe(2);
  });
});
