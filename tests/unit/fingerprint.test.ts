import { describe, expect, it } from "vitest";
import { canonicalJson, fingerprintRequest, sha256Hex } from "../../src/application/fingerprint";
import { ToolError } from "../../src/domain/errors";
import { InputInspector } from "../../src/storage/input-inspection";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AL+2gAAAABJRU5ErkJggg==",
  "base64",
);

describe("canonical JSON", () => {
  it("is independent of object key order and preserves array order", () => {
    const a = canonicalJson({ b: 1, a: { d: [1, 2], c: "x" } });
    const b = canonicalJson({ a: { c: "x", d: [1, 2] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":"x","d":[1,2]},"b":1}');

    expect(canonicalJson({ a: [1, 2, 3] })).not.toBe(canonicalJson({ a: [3, 2, 1] }));
  });

  it("rejects values JSON cannot represent", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(ToolError);
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(ToolError);
    expect(() => canonicalJson({ a: 1n })).toThrow(ToolError);
  });
});

describe("fingerprints", () => {
  const parts = {
    provider: "higgsfield-v1",
    logicalModel: "soul-image",
    capability: "text-to-image" as const,
    normalizedParameters: { preset: "portrait-hd", batch: 1, quality: "1080p" },
    prompt: "Editorial portrait",
    inputs: [{ kind: "image", sha256: sha256Hex(PNG_1PX) }],
  };

  it("is stable across parameter ordering and input ordering", () => {
    const reordered = {
      ...parts,
      normalizedParameters: { quality: "1080p", batch: 1, preset: "portrait-hd" },
    };
    expect(fingerprintRequest(parts)).toBe(fingerprintRequest(reordered));
    expect(fingerprintRequest(parts)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes with the prompt, parameters, provider, model, and input hash", () => {
    const base = fingerprintRequest(parts);
    expect(fingerprintRequest({ ...parts, prompt: "Different" })).not.toBe(base);
    expect(fingerprintRequest({ ...parts, logicalModel: "dop-video" })).not.toBe(base);
    expect(fingerprintRequest({ ...parts, provider: "other" })).not.toBe(base);
    expect(
      fingerprintRequest({
        ...parts,
        normalizedParameters: { ...parts.normalizedParameters, batch: 4 },
      }),
    ).not.toBe(base);
    expect(
      fingerprintRequest({ ...parts, inputs: [{ kind: "image", sha256: sha256Hex("other") }] }),
    ).not.toBe(base);
  });

  it("distinguishes URL inputs from local hashes", () => {
    const byUrl = fingerprintRequest({
      ...parts,
      inputs: [{ kind: "image", url: "https://x/y.png" }],
    });
    const byHash = fingerprintRequest({
      ...parts,
      inputs: [{ kind: "image", sha256: sha256Hex("https://x/y.png") }],
    });
    expect(byUrl).not.toBe(byHash);
  });
});

describe("input inspection", () => {
  it("detects content by magic bytes, not extension", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hf-inputs-"));
    const misleading = path.join(directory, "actually-a-video.mp4");
    await writeFile(misleading, PNG_1PX);
    const inspector = new InputInspector({ cwd: directory });

    const inspected = await inspector.inspectImage("actually-a-video.mp4");
    expect(inspected.contentType).toBe("image/png");
    expect(inspected.format).toBe("png");
    expect(inspected.displayPath).toBe("actually-a-video.mp4");
  });

  it("rejects unsupported, missing, empty, and oversized inputs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hf-inputs-"));
    await writeFile(
      path.join(directory, "notes.txt"),
      "not media at all, but long enough to sniff",
    );
    await writeFile(path.join(directory, "empty.png"), "");
    // A valid PNG that exceeds only the *image* limit: it must be rejected for size,
    // never accepted under the larger audio allowance.
    await writeFile(path.join(directory, "big.png"), Buffer.concat([PNG_1PX, Buffer.alloc(64, 1)]));
    const inspector = new InputInspector({
      cwd: directory,
      maxImageBytes: PNG_1PX.byteLength + 8,
    });

    await expect(inspector.inspectImage("notes.txt")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(inspector.inspectImage("missing.png")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(inspector.inspectImage("empty.png")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(inspector.inspectImage("actually-a-video.mp4")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(inspector.inspectImage(directory)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(inspector.inspectImage("big.png")).rejects.toMatchObject({
      code: "INVALID_INPUT",
      details: { maxBytes: PNG_1PX.byteLength + 8 },
    });
    // The auto-detecting path used by `hf upload` applies the same per-kind limit.
    await expect(inspector.inspectUnknown("big.png")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("rejects non-http URL schemes", async () => {
    const inspector = new InputInspector({ cwd: process.cwd() });
    await expect(inspector.inspectImage("file:///etc/passwd")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});
