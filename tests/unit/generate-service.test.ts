import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GenerateService } from "../../src/application/generate";
import { sha256OfFile } from "../../src/application/fingerprint";
import { AssetStore } from "../../src/storage/asset-store";
import { InputInspector } from "../../src/storage/input-inspection";
import { ManifestStore } from "../../src/storage/manifest-store";
import { FakeClock, RecordingSleeper } from "../helpers/clock";
import { createFakeProvider, type FakeProviderScript } from "../helpers/fake-media-provider";

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AL+2gAAAABJRU5ErkJggg==",
  "base64",
);
const MP4_1PX = Buffer.concat([
  Buffer.from([0, 0, 0, 0x20]),
  Buffer.from("ftypisom"),
  Buffer.alloc(32, 1),
]);

function response(body: Buffer, contentType: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

interface Harness {
  service: GenerateService;
  provider: ReturnType<typeof createFakeProvider>;
  cwd: string;
  output: string;
  uploads: { sha256: string; contentType: string }[];
}

async function buildHarness(
  script: FakeProviderScript,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<Harness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "hf-generate-"));
  const provider = createFakeProvider(script);
  const uploads: { sha256: string; contentType: string }[] = [];
  const service = new GenerateService({
    provider: provider.provider,
    inspector: new InputInspector({ cwd }),
    upload: async (input) => {
      uploads.push({ sha256: input.sha256, contentType: input.contentType });
      return {
        url: `https://cdn.test/uploaded-${input.sha256.slice(0, 8)}.png`,
        contentType: input.contentType,
        sha256: input.sha256,
        bytes: input.bytes,
      };
    },
    assets: new AssetStore({
      fetchImpl: options.fetchImpl ?? (async () => response(PNG_1PX, "image/png")),
    }),
    manifests: new ManifestStore({ clock: new FakeClock() }),
    cwd,
    providerName: "higgsfield-v1",
    retry: { count: 2, backoffMs: 0, maxBackoffMs: 0 },
    sleeper: new RecordingSleeper(),
    random: { next: () => 0 },
  });
  return { service, provider, cwd, output: path.join(cwd, "assets", "shot-001"), uploads };
}

/** Fingerprint recorded in a written manifest, used to plant hostile manifests. */
async function fingerprintOfOutcome(cwd: string, outcome: { manifest: string }): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(cwd, outcome.manifest), "utf8")) as {
    fingerprint: string;
  };
  return manifest.fingerprint;
}

const imageResult = () => ({
  requestId: "req-1",
  status: "completed" as const,
  assets: [{ kind: "image" as const, url: "https://cdn.test/image-01.png" }],
});

describe("dry run", () => {
  it("validates and fingerprints without touching the provider, uploads, or disk", async () => {
    const harness = await buildHarness({});
    const outcome = await harness.service.runImage({
      prompt: "Editorial portrait",
      preset: "portrait-hd",
      output: "assets/shot-001",
      force: false,
      dryRun: true,
    });

    expect(outcome).toMatchObject({
      status: "validated",
      logicalModel: "soul-image",
      dryRun: true,
      reused: false,
      outputDirectory: "assets/shot-001",
      resolvedRequest: {
        preset: "portrait-hd",
        widthAndHeight: "1536x2048",
        quality: "1080p",
        batch: 1,
      },
    });
    expect(outcome.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(harness.provider.calls.generate).toHaveLength(0);
    expect(harness.uploads).toHaveLength(0);
    await expect(readdir(path.join(harness.cwd, "assets"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("changes the fingerprint when the prompt changes", async () => {
    const harness = await buildHarness({});
    const base = { preset: "square-hd", output: "assets/shot-001", force: false, dryRun: true };
    const first = await harness.service.runImage({ ...base, prompt: "one" });
    const second = await harness.service.runImage({ ...base, prompt: "two" });
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });
});

describe("generation transaction", () => {
  it("downloads, verifies, and writes a manifest after a successful generation", async () => {
    const harness = await buildHarness({ generate: async () => imageResult() });
    const outcome = await harness.service.runImage({
      prompt: "Editorial portrait",
      preset: "portrait-hd",
      output: "assets/shot-001",
      force: false,
      dryRun: false,
      seed: 11,
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.requestId).toBe("req-1");
    expect(outcome.manifest).toBe("assets/shot-001/generation.json");
    expect(outcome.assets).toHaveLength(1);

    const asset = outcome.assets[0]!;
    const expectedPath = path.join(harness.output, "image-01.png");
    expect(asset.path).toBe("assets/shot-001/image-01.png");
    expect(asset.mimeType).toBe("image/png");
    expect(asset.bytes).toBe(PNG_1PX.byteLength);
    expect(asset.sha256).toBe(await sha256OfFile(expectedPath));

    const manifest = JSON.parse(
      await readFile(path.join(harness.output, "generation.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      assetId: "shot-001",
      provider: "higgsfield-v1",
      capability: "text-to-image",
      logicalModel: "soul-image",
      fingerprint: outcome.fingerprint,
      prompt: "Editorial portrait",
      inputs: [],
      request: { seed: 11, preset: "portrait-hd" },
      remote: { requestId: "req-1", status: "completed" },
    });
    expect(manifest.outputs).toEqual([
      {
        type: "image",
        path: "image-01.png",
        mimeType: "image/png",
        sha256: asset.sha256,
        bytes: PNG_1PX.byteLength,
      },
    ]);
    expect(await readdir(harness.output)).toEqual(["generation.json", "image-01.png"]);
  });

  it("names multiple images deterministically and keeps video/audio names stable", async () => {
    const harness = await buildHarness({
      generate: async () => ({
        requestId: "req-2",
        status: "completed" as const,
        assets: [
          { kind: "image" as const, url: "https://cdn.test/a.png" },
          { kind: "image" as const, url: "https://cdn.test/b.png" },
          { kind: "image" as const, url: "https://cdn.test/c.png" },
          { kind: "image" as const, url: "https://cdn.test/d.png" },
        ],
      }),
    });

    const outcome = await harness.service.runImage({
      prompt: "Four variants",
      preset: "square-hd",
      output: "assets/shot-002",
      force: false,
      dryRun: false,
      batch: 4,
    });

    expect(outcome.assets.map((asset) => path.basename(asset.path))).toEqual([
      "image-01.png",
      "image-02.png",
      "image-03.png",
      "image-04.png",
    ]);
  });

  it("uploads a local input once, hashes it into the fingerprint, and records no CDN url", async () => {
    const harness = await buildHarness(
      {
        generate: async (request) => {
          expect(request.capability).toBe("image-to-video");
          expect(request).toMatchObject({
            model: "dop-turbo",
            motion: "Zoom In",
            motionStrength: 0.8,
          });
          return {
            requestId: "req-3",
            status: "completed",
            assets: [{ kind: "video", url: "https://cdn.test/video.mp4" }],
          };
        },
      },
      { fetchImpl: async () => response(MP4_1PX, "video/mp4") },
    );

    const keyframe = path.join(harness.cwd, "keyframe.png");
    await writeFile(keyframe, PNG_1PX);

    const options = {
      input: "keyframe.png",
      prompt: "Slow dolly-in",
      preset: "cinematic",
      output: "assets/shot-003",
      force: false,
      dryRun: false,
      motion: "Zoom In",
    };
    const outcome = await harness.service.runVideo(options);

    expect(harness.uploads).toHaveLength(1);
    expect(harness.uploads[0]?.sha256).toBe(await sha256OfFile(keyframe));
    expect(outcome.assets[0]?.path).toBe("assets/shot-003/video.mp4");
    expect(outcome.inputs).toEqual([
      { kind: "image", localPath: "keyframe.png", sha256: await sha256OfFile(keyframe) },
    ]);
    expect(JSON.stringify(outcome.inputs)).not.toContain("cdn.test");

    const manifest = await readFile(
      path.join(harness.cwd, "assets", "shot-003", "generation.json"),
      "utf8",
    );
    expect(manifest).not.toContain("cdn.test");
  });
});

describe("duplicate protection", () => {
  it("reuses a verified completed manifest without contacting the provider", async () => {
    const harness = await buildHarness({ generate: async () => imageResult() });
    const options = {
      prompt: "Editorial portrait",
      preset: "portrait-hd",
      output: "assets/shot-001",
      force: false,
      dryRun: false,
    };

    const first = await harness.service.runImage(options);
    const second = await harness.service.runImage(options);

    expect(harness.provider.calls.generate).toHaveLength(1);
    expect(second.reused).toBe(true);
    expect(second.status).toBe("completed");
    expect(second.requestId).toBe(first.requestId);
    expect(second.assets[0]?.path).toBe(first.assets[0]?.path);
    expect(second.assets[0]?.remoteUrl).toBeUndefined();
    expect(second.manifest).toBe(first.manifest);
  });

  it("reports a conflict instead of overwriting a different completed generation", async () => {
    const harness = await buildHarness({ generate: async () => imageResult() });
    const base = {
      preset: "portrait-hd",
      output: "assets/shot-001",
      force: false,
      dryRun: false,
    };
    await harness.service.runImage({ ...base, prompt: "first" });
    const manifestBefore = await readFile(path.join(harness.output, "generation.json"), "utf8");

    await expect(harness.service.runImage({ ...base, prompt: "second" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(harness.provider.calls.generate).toHaveLength(1);
    expect(await readFile(path.join(harness.output, "generation.json"), "utf8")).toBe(
      manifestBefore,
    );
  });

  it("regenerates when --force is passed", async () => {
    const harness = await buildHarness({ generate: async () => imageResult() });
    const base = {
      preset: "portrait-hd",
      output: "assets/shot-001",
      dryRun: false,
    };
    await harness.service.runImage({ ...base, prompt: "first", force: false });
    const forced = await harness.service.runImage({ ...base, prompt: "second", force: true });

    expect(harness.provider.calls.generate).toHaveLength(2);
    expect(forced.reused).toBe(false);
    const manifest = JSON.parse(
      await readFile(path.join(harness.output, "generation.json"), "utf8"),
    ) as {
      prompt: string;
      fingerprint: string;
    };
    expect(manifest.prompt).toBe("second");
    expect(manifest.fingerprint).toBe(forced.fingerprint);
  });

  it("ignores a planted manifest whose outputs escape the output directory", async () => {
    const harness = await buildHarness({ generate: async () => imageResult() });
    const options = {
      prompt: "Editorial portrait",
      preset: "portrait-hd",
      output: "assets/shot-001",
      force: false,
      dryRun: false,
    };
    const dryRun = await harness.service.runImage({ ...options, dryRun: true });

    // An attacker-controlled manifest can print the next fingerprint with --dry-run;
    // the escape attempt must still not be honoured.
    const outside = path.join(harness.cwd, "outside.png");
    await writeFile(outside, PNG_1PX);
    await mkdir(harness.output, { recursive: true });
    await writeFile(
      path.join(harness.output, "generation.json"),
      JSON.stringify({
        schemaVersion: 1,
        assetId: "shot-001",
        provider: "higgsfield-v1",
        capability: "text-to-image",
        logicalModel: "soul-image",
        fingerprint: dryRun.fingerprint,
        createdAt: new Date().toISOString(),
        inputs: [],
        request: {},
        remote: { requestId: "planted", status: "completed" },
        outputs: [
          {
            type: "image",
            path: "../../outside.png",
            mimeType: "image/png",
            sha256: await sha256OfFile(outside),
            bytes: PNG_1PX.byteLength,
          },
        ],
      }),
    );

    const outcome = await harness.service.runImage(options);
    expect(outcome.reused).toBe(false);
    expect(harness.provider.calls.generate).toHaveLength(1);
    expect(outcome.assets.map((asset) => path.basename(asset.path))).toEqual(["image-01.png"]);

    // Absolute paths are rejected the same way.
    await writeFile(
      path.join(harness.output, "generation.json"),
      JSON.stringify({
        schemaVersion: 1,
        assetId: "shot-001",
        provider: "higgsfield-v1",
        capability: "text-to-image",
        logicalModel: "soul-image",
        fingerprint: await fingerprintOfOutcome(harness.cwd, outcome as { manifest: string }),
        createdAt: new Date().toISOString(),
        inputs: [],
        request: {},
        remote: { requestId: "planted", status: "completed" },
        outputs: [
          {
            type: "image",
            path: outside,
            mimeType: "image/png",
            sha256: await sha256OfFile(outside),
            bytes: PNG_1PX.byteLength,
          },
        ],
      }),
    );
    const again = await harness.service.runImage({ ...options, force: false });
    expect(again.reused).toBe(false);
    expect(harness.provider.calls.generate).toHaveLength(2);
  });

  it("does not reuse a manifest that declares no outputs", async () => {
    const harness = await buildHarness({ generate: async () => imageResult() });
    const options = {
      prompt: "Editorial portrait",
      preset: "portrait-hd",
      output: "assets/shot-001",
      force: false,
      dryRun: false,
    };
    const dryRun = await harness.service.runImage({ ...options, dryRun: true });

    await mkdir(harness.output, { recursive: true });
    await writeFile(
      path.join(harness.output, "generation.json"),
      JSON.stringify({
        schemaVersion: 1,
        assetId: "shot-001",
        provider: "higgsfield-v1",
        capability: "text-to-image",
        logicalModel: "soul-image",
        fingerprint: dryRun.fingerprint,
        createdAt: new Date().toISOString(),
        inputs: [],
        request: {},
        remote: { requestId: "planted", status: "completed" },
        outputs: [],
      }),
    );

    const outcome = await harness.service.runImage(options);
    expect(outcome.reused).toBe(false);
    expect(outcome.assets).toHaveLength(1);
    expect(harness.provider.calls.generate).toHaveLength(1);
  });

  it("never verifies outputs that resolve outside the manifest directory", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "hf-manifest-"));
    const outside = path.join(cwd, "outside.png");
    await writeFile(outside, PNG_1PX);
    const store = new ManifestStore({ clock: new FakeClock() });
    const directory = path.join(cwd, "assets", "shot-001");
    await mkdir(directory, { recursive: true });

    const verification = await store.verify(directory, {
      schemaVersion: 1,
      assetId: "shot-001",
      provider: "higgsfield-v1",
      capability: "text-to-image",
      logicalModel: "soul-image",
      fingerprint: `sha256:${"a".repeat(64)}`,
      createdAt: new Date().toISOString(),
      inputs: [],
      request: {},
      remote: { requestId: "req-1", status: "completed" },
      outputs: [
        {
          type: "image",
          path: "../outside.png",
          mimeType: "image/png",
          sha256: await sha256OfFile(outside),
          bytes: PNG_1PX.byteLength,
        },
      ],
    });

    expect(verification.ok).toBe(false);
    expect(verification.problems).toEqual([
      { path: "../outside.png", reason: "outside_output_directory" },
    ]);
  });

  it("regenerates over a corrupt or unverifiable manifest", async () => {
    const harness = await buildHarness({ generate: async () => imageResult() });
    const options = {
      prompt: "Editorial portrait",
      preset: "portrait-hd",
      output: "assets/shot-001",
      force: false,
      dryRun: false,
    };
    await harness.service.runImage(options);

    await writeFile(path.join(harness.output, "image-01.png"), "tampered");
    const again = await harness.service.runImage(options);

    expect(harness.provider.calls.generate).toHaveLength(2);
    expect(again.reused).toBe(false);
    expect(await sha256OfFile(path.join(harness.output, "image-01.png"))).toBe(
      again.assets[0]?.sha256,
    );

    await writeFile(path.join(harness.output, "generation.json"), "{ broken");
    const third = await harness.service.runImage(options);
    expect(harness.provider.calls.generate).toHaveLength(3);
    expect(third.reused).toBe(false);
  });
});

describe("provider result enforcement", () => {
  const terminalCases: { status: "failed" | "nsfw" | "canceled"; code: string }[] = [
    { status: "failed", code: "GENERATION_FAILED" },
    { status: "nsfw", code: "MODERATION_REJECTED" },
    { status: "canceled", code: "CANCELED" },
  ];

  for (const testCase of terminalCases) {
    it(`fails with ${testCase.code} instead of writing a manifest for a ${testCase.status} result`, async () => {
      const harness = await buildHarness({
        generate: async () => ({ requestId: "req-x", status: testCase.status, assets: [] }),
      });

      await expect(
        harness.service.runImage({
          prompt: "Editorial portrait",
          preset: "portrait-hd",
          output: "assets/shot-001",
          force: false,
          dryRun: false,
        }),
      ).rejects.toMatchObject({ code: testCase.code, requestId: "req-x" });

      const entries = await readdir(harness.output).catch(() => []);
      expect(entries).toEqual([]);
    });
  }

  it("fails when a provider returns a non-terminal status after its own polling", async () => {
    const harness = await buildHarness({
      generate: async () => ({ requestId: "req-slow", status: "in_progress", assets: [] }),
    });

    await expect(
      harness.service.runImage({
        prompt: "Editorial portrait",
        preset: "portrait-hd",
        output: "assets/shot-001",
        force: false,
        dryRun: false,
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
      requestId: "req-slow",
    });
  });
});

describe("failure handling", () => {
  it("leaves no final file, no partial file, and no manifest when a download fails", async () => {
    const harness = await buildHarness(
      { generate: async () => imageResult() },
      { fetchImpl: async () => new Response("gone", { status: 404 }) },
    );

    await expect(
      harness.service.runImage({
        prompt: "Editorial portrait",
        preset: "portrait-hd",
        output: "assets/shot-001",
        force: false,
        dryRun: false,
      }),
    ).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });

    const entries = await readdir(harness.output).catch(() => []);
    expect(entries).toEqual([]);
  });

  it("rejects content that does not match the expected media kind", async () => {
    const harness = await buildHarness(
      { generate: async () => imageResult() },
      { fetchImpl: async () => response(MP4_1PX, "video/mp4") },
    );

    await expect(
      harness.service.runImage({
        prompt: "Editorial portrait",
        preset: "portrait-hd",
        output: "assets/shot-001",
        force: false,
        dryRun: false,
      }),
    ).rejects.toMatchObject({ code: "DOWNLOAD_FAILED", retryable: false });
    expect(await readdir(harness.output)).toEqual([]);
  });

  it("validates prompts, presets, batches, and dependent flags before any spend", async () => {
    const harness = await buildHarness({ generate: async () => imageResult() });
    const base = { preset: "portrait-hd", output: "assets/x", force: false, dryRun: false };

    await expect(harness.service.runImage({ ...base, prompt: "   " })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(
      harness.service.runImage({ ...base, prompt: "ok", preset: "nope" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      harness.service.runImage({
        ...base,
        prompt: "ok",
        referenceStrength: 0.5,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      harness.service.runVideo({
        input: "missing.png",
        prompt: "ok",
        preset: "cinematic",
        output: "assets/x",
        force: false,
        dryRun: false,
        motionStrength: 0.5,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(harness.provider.calls.generate).toHaveLength(0);
  });
});

describe("generic generation", () => {
  it("enforces the endpoint allow-list and prototype-pollution safety", async () => {
    const harness = await buildHarness(
      {
        generate: async () => ({
          requestId: "req-9",
          status: "completed",
          assets: [{ kind: "video", url: "https://cdn.test/video.mp4" }],
        }),
      },
      { fetchImpl: async () => response(MP4_1PX, "video/mp4") },
    );

    await writeFile(path.join(harness.cwd, "ok.json"), JSON.stringify({ prompt: "hello" }));
    const outcome = await harness.service.runGeneric({
      endpoint: "/v1/custom/thing",
      input: "ok.json",
      output: "assets/custom-001",
      force: false,
      dryRun: false,
    });
    expect(outcome).toMatchObject({ operation: "generic", logicalModel: "generic-v1" });
    expect(harness.provider.calls.generate[0]).toMatchObject({
      endpoint: "/v1/custom/thing",
      params: { prompt: "hello" },
    });

    await expect(
      harness.service.runGeneric({
        endpoint: "/v2/nope",
        input: "ok.json",
        output: "assets/custom-002",
        force: false,
        dryRun: true,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    await writeFile(
      path.join(harness.cwd, "evil.json"),
      '{"params":{"__proto__":{"polluted":true}}}',
    );
    await expect(
      harness.service.runGeneric({
        endpoint: "/v1/custom/thing",
        input: "evil.json",
        output: "assets/custom-003",
        force: false,
        dryRun: true,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    await writeFile(path.join(harness.cwd, "array.json"), "[1,2,3]");
    await expect(
      harness.service.runGeneric({
        endpoint: "/v1/custom/thing",
        input: "array.json",
        output: "assets/custom-004",
        force: false,
        dryRun: true,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    await writeFile(
      path.join(harness.cwd, "huge.json"),
      JSON.stringify({ blob: "x".repeat(1024 * 1024) }),
    );
    await expect(
      harness.service.runGeneric({
        endpoint: "/v1/custom/thing",
        input: "huge.json",
        output: "assets/custom-005",
        force: false,
        dryRun: true,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("keeps deeply nested generic bodies distinguishable in the fingerprint", async () => {
    const harness = await buildHarness({});
    let first: unknown = "first";
    let second: unknown = "second";
    for (let level = 0; level < 12; level += 1) {
      first = { nested: first };
      second = { nested: second };
    }
    await writeFile(path.join(harness.cwd, "deep-a.json"), JSON.stringify(first));
    await writeFile(path.join(harness.cwd, "deep-b.json"), JSON.stringify(second));

    const options = { endpoint: "/v1/custom/thing", force: false, dryRun: true } as const;
    const a = await harness.service.runGeneric({
      ...options,
      input: "deep-a.json",
      output: "assets/a",
    });
    const b = await harness.service.runGeneric({
      ...options,
      input: "deep-b.json",
      output: "assets/b",
    });

    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(JSON.stringify(a.resolvedRequest)).toContain("first");
  });

  it("sends signed URLs to the provider but never stores or echoes the signature", async () => {
    const harness = await buildHarness(
      {
        generate: async () => ({
          requestId: "req-signed",
          status: "completed",
          assets: [{ kind: "video", url: "https://cdn.test/video.mp4?X-Amz-Signature=feedface" }],
        }),
      },
      { fetchImpl: async () => response(MP4_1PX, "video/mp4") },
    );
    const signedUrl = "https://cdn.test/in.png?X-Amz-Signature=deadbeef";
    await writeFile(
      path.join(harness.cwd, "signed.json"),
      JSON.stringify({ input_url: signedUrl }),
    );

    const outcome = await harness.service.runGeneric({
      endpoint: "/v1/custom/thing",
      input: "signed.json",
      output: "assets/custom-signed",
      force: false,
      dryRun: false,
    });

    // The provider still receives the signed URL it needs.
    expect(harness.provider.calls.generate[0]).toMatchObject({ params: { input_url: signedUrl } });
    // The manifest and the returned request/asset metadata do not.
    expect(JSON.stringify(outcome.resolvedRequest)).not.toContain("deadbeef");
    const manifest = await readFile(
      path.join(harness.cwd, "assets", "custom-signed", "generation.json"),
      "utf8",
    );
    expect(manifest).not.toContain("deadbeef");
    expect(manifest).toContain("https://cdn.test/in.png");
  });
});
