import { randomBytes } from "node:crypto";
import { z } from "zod";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { ALLOWED_IMAGE_BATCHES, MAX_GENERIC_INPUT_BYTES, MAX_SEED } from "../config/defaults";
import type {
  GeneratedAsset,
  GenerationManifest,
  ManifestInput,
  ManifestOutput,
} from "../domain/asset";
import { MANIFEST_SCHEMA_VERSION } from "../domain/asset";
import { ToolError, isSafeToRetry, withRequestId } from "../domain/errors";
import { UNSAFE_OBJECT_KEYS, scrubForStorage } from "../domain/redact";
import { isTerminalStatus } from "../domain/generation";
import type { GenerationResult } from "../domain/generation";
import { withRetry, type RetryPolicy } from "../domain/retry";
import type { RandomSource, Sleeper } from "../domain/runtime";
import type { AssetKind, Capability, ProviderGenerationRequest } from "../domain/generation";
import type { MediaProvider } from "../domain/media-provider";
import {
  GENERIC_LOGICAL_MODEL,
  listImagePresets,
  listSpeechPresets,
  listVideoPresets,
  resolveImagePreset,
  resolveSpeechPreset,
  resolveVideoPreset,
} from "../domain/model-registry";
import { outputFilename, type AssetStore } from "../storage/asset-store";
import { parseInputReference, type InputInspector } from "../storage/input-inspection";
import type { ManifestStore } from "../storage/manifest-store";
import { stripQueryString, toDisplayPath } from "../storage/paths";
import { assertWritableDirectory } from "../storage/writable";
import { fingerprintRequest, type FingerprintInputRef, type FingerprintParts } from "./fingerprint";
import type { LocalUploader } from "./upload-media";

/**
 * Canonical generation transaction (§12), shared by the typed image/video/speech
 * commands and the generic endpoint escape hatch:
 *
 *   validate -> resolve preset/model -> resolve+hash inputs -> fingerprint ->
 *   reuse/conflict check -> submit (exactly once) -> download -> verify ->
 *   write manifest atomically -> return JSON
 *
 * Dry runs stop after validation and the fingerprint: no uploads, no provider
 * calls, no cache or output writes.
 */

export type GenerationOperation =
  "text-to-image" | "image-to-video" | "speech-to-video" | "generic";

export interface GenerationOutcome {
  operation: GenerationOperation;
  capability: Capability;
  provider: string;
  status: "validated" | GenerationManifest["remote"]["status"];
  fingerprint: string;
  logicalModel: string;
  outputDirectory: string;
  manifest?: string;
  requestId?: string;
  assets: GeneratedAsset[];
  inputs: ManifestInput[];
  resolvedRequest: Record<string, unknown>;
  reused: boolean;
  dryRun: boolean;
}

export interface CommonGenerateOptions {
  output: string;
  force: boolean;
  dryRun: boolean;
}

export interface ImageGenerateOptions extends CommonGenerateOptions {
  prompt: string;
  preset: string;
  style?: string;
  seed?: number;
  batch?: 1 | 4;
  reference?: string;
  referenceStrength?: number;
  character?: string;
}

export interface VideoGenerateOptions extends CommonGenerateOptions {
  input: string;
  prompt: string;
  preset: string;
  model?: string;
  motion?: string;
  motionStrength?: number;
}

export interface SpeechGenerateOptions extends CommonGenerateOptions {
  prompt: string;
  preset: string;
  image: string;
  audio: string;
}

export interface GenericGenerateOptions extends CommonGenerateOptions {
  endpoint: string;
  /** Path to a JSON file containing the V1 parameter object. */
  input: string;
}

export interface GenerateServiceOptions {
  provider: MediaProvider;
  inspector: InputInspector;
  upload: LocalUploader;
  assets: AssetStore;
  manifests: ManifestStore;
  cwd: string;
  providerName: string;
  /** Download retry policy; a paid result must survive a transient CDN failure. */
  retry: RetryPolicy;
  sleeper: Sleeper;
  random: RandomSource;
}

interface PreparedInput {
  kind: "image" | "audio";
  fingerprintRef: FingerprintInputRef;
  manifestInput: ManifestInput;
  /** Uploads on first call and memoizes the URL. Never called on dry runs. */
  remoteUrl: () => Promise<string>;
}

interface ExecuteParams {
  operation: GenerationOperation;
  capability: Capability;
  logicalModel: string;
  prompt?: string;
  output: string;
  force: boolean;
  dryRun: boolean;
  /** Normalized, user-facing request fields; also stored in the manifest. */
  normalizedRequest: Record<string, unknown>;
  inputs: PreparedInput[];
  buildRequest: () => Promise<ProviderGenerationRequest>;
}

function assertNoPrototypePollution(value: unknown, pathHint = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPrototypePollution(entry, `${pathHint}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) {
      throw new ToolError({
        code: "VALIDATION_FAILED",
        message: `Generic input contains a forbidden key "${key}" at ${pathHint}.`,
        details: { key, path: pathHint },
      });
    }
    assertNoPrototypePollution(entry, `${pathHint}.${key}`);
  }
}

function assertNonEmptyPrompt(prompt: string): void {
  if (prompt.trim().length === 0) {
    throw new ToolError({ code: "VALIDATION_FAILED", message: "A non-empty prompt is required." });
  }
}

export class GenerateService {
  private readonly provider: MediaProvider;
  private readonly inspector: InputInspector;
  private readonly upload: LocalUploader;
  private readonly assets: AssetStore;
  private readonly manifests: ManifestStore;
  private readonly cwd: string;
  private readonly providerName: string;
  private readonly retryPolicy: RetryPolicy;
  private readonly sleeper: Sleeper;
  private readonly random: RandomSource;

  constructor(options: GenerateServiceOptions) {
    this.provider = options.provider;
    this.inspector = options.inspector;
    this.upload = options.upload;
    this.assets = options.assets;
    this.manifests = options.manifests;
    this.cwd = options.cwd;
    this.providerName = options.providerName;
    this.retryPolicy = options.retry;
    this.sleeper = options.sleeper;
    this.random = options.random;
  }

  // ------------------------------------------------------------- typed runs

  async runImage(options: ImageGenerateOptions): Promise<GenerationOutcome> {
    assertNonEmptyPrompt(options.prompt);
    const preset = resolveImagePreset(options.preset);
    if (preset === undefined) {
      throw new ToolError({
        code: "VALIDATION_FAILED",
        message: `Unknown image preset "${options.preset}". Available presets: ${listPresetNames("image")}.`,
        details: { preset: options.preset },
      });
    }
    if (
      options.seed !== undefined &&
      (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > MAX_SEED)
    ) {
      throw new ToolError({
        code: "VALIDATION_FAILED",
        message: `--seed must be an integer between 0 and ${MAX_SEED}.`,
        details: { seed: options.seed },
      });
    }
    if (options.batch !== undefined && !ALLOWED_IMAGE_BATCHES.includes(options.batch)) {
      throw new ToolError({
        code: "VALIDATION_FAILED",
        message: `--batch must be one of ${ALLOWED_IMAGE_BATCHES.join(", ")}.`,
        details: { batch: options.batch },
      });
    }
    if (options.referenceStrength !== undefined && options.reference === undefined) {
      throw new ToolError({
        code: "VALIDATION_FAILED",
        message: "--reference-strength requires --reference.",
      });
    }

    const inputs: PreparedInput[] = [];
    if (options.reference !== undefined)
      inputs.push(await this.prepareInput(options.reference, "image"));
    const reference = inputs[0];
    const batch = options.batch ?? preset.batch;

    const normalizedRequest: Record<string, unknown> = {
      preset: preset.name,
      logicalModel: preset.logicalModel,
      widthAndHeight: preset.widthAndHeight,
      quality: preset.quality,
      batch,
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.style === undefined ? {} : { style: options.style }),
      ...(options.character === undefined ? {} : { character: options.character }),
      ...(options.reference === undefined
        ? {}
        : { referenceSource: reference?.manifestInput.localPath ?? reference?.manifestInput.url }),
      ...(options.referenceStrength === undefined
        ? {}
        : { referenceStrength: options.referenceStrength }),
    };

    return this.execute({
      operation: "text-to-image",
      capability: "text-to-image",
      logicalModel: preset.logicalModel,
      prompt: options.prompt,
      output: options.output,
      force: options.force,
      dryRun: options.dryRun,
      normalizedRequest,
      inputs,
      buildRequest: async () => ({
        capability: "text-to-image",
        logicalModel: preset.logicalModel,
        prompt: options.prompt,
        preset: preset.name,
        widthAndHeight: preset.widthAndHeight,
        quality: preset.quality,
        batch,
        ...(options.seed === undefined ? {} : { seed: options.seed }),
        ...(options.style === undefined ? {} : { style: options.style }),
        ...(options.reference === undefined || reference === undefined
          ? {}
          : { reference: { kind: "image", url: await reference.remoteUrl() } }),
        ...(options.referenceStrength === undefined
          ? {}
          : { referenceStrength: options.referenceStrength }),
        ...(options.character === undefined ? {} : { characterId: options.character }),
      }),
    });
  }

  async runVideo(options: VideoGenerateOptions): Promise<GenerationOutcome> {
    assertNonEmptyPrompt(options.prompt);
    const preset = resolveVideoPreset(options.preset);
    if (preset === undefined) {
      throw new ToolError({
        code: "VALIDATION_FAILED",
        message: `Unknown video preset "${options.preset}". Available presets: ${listPresetNames("video")}.`,
        details: { preset: options.preset },
      });
    }
    if (options.motionStrength !== undefined && options.motion === undefined) {
      throw new ToolError({
        code: "VALIDATION_FAILED",
        message: "--motion-strength requires --motion.",
      });
    }

    const model = options.model ?? preset.model;
    const motionStrength =
      options.motion === undefined ? undefined : (options.motionStrength ?? preset.motionStrength);
    const inputs = [await this.prepareInput(options.input, "image")];

    const normalizedRequest: Record<string, unknown> = {
      preset: preset.name,
      logicalModel: preset.logicalModel,
      model,
      ...(options.motion === undefined ? {} : { motion: options.motion }),
      ...(motionStrength === undefined ? {} : { motionStrength }),
      inputSource: inputs[0]?.manifestInput.localPath ?? inputs[0]?.manifestInput.url,
    };

    return this.execute({
      operation: "image-to-video",
      capability: "image-to-video",
      logicalModel: preset.logicalModel,
      prompt: options.prompt,
      output: options.output,
      force: options.force,
      dryRun: options.dryRun,
      normalizedRequest,
      inputs,
      buildRequest: async () => ({
        capability: "image-to-video",
        logicalModel: preset.logicalModel,
        model,
        prompt: options.prompt,
        preset: preset.name,
        inputImages: [{ kind: "image", url: await inputs[0]!.remoteUrl() }],
        ...(options.motion === undefined ? {} : { motion: options.motion }),
        ...(motionStrength === undefined ? {} : { motionStrength }),
      }),
    });
  }

  async runSpeech(options: SpeechGenerateOptions): Promise<GenerationOutcome> {
    assertNonEmptyPrompt(options.prompt);
    const preset = resolveSpeechPreset(options.preset);
    if (preset === undefined) {
      throw new ToolError({
        code: "VALIDATION_FAILED",
        message: `Unknown speech preset "${options.preset}". Available presets: ${listPresetNames("speech")}.`,
        details: { preset: options.preset },
      });
    }

    const image = await this.prepareInput(options.image, "image");
    const audio = await this.prepareInput(options.audio, "audio");

    const normalizedRequest: Record<string, unknown> = {
      preset: preset.name,
      logicalModel: preset.logicalModel,
      quality: preset.quality,
      duration: preset.duration,
      imageSource: image.manifestInput.localPath ?? image.manifestInput.url,
      audioSource: audio.manifestInput.localPath ?? audio.manifestInput.url,
    };

    return this.execute({
      operation: "speech-to-video",
      capability: "speech-to-video",
      logicalModel: preset.logicalModel,
      prompt: options.prompt,
      output: options.output,
      force: options.force,
      dryRun: options.dryRun,
      normalizedRequest,
      inputs: [image, audio],
      buildRequest: async () => ({
        capability: "speech-to-video",
        logicalModel: preset.logicalModel,
        prompt: options.prompt,
        preset: preset.name,
        image: { kind: "image", url: await image.remoteUrl() },
        audio: { kind: "audio", url: await audio.remoteUrl() },
        quality: preset.quality,
        duration: preset.duration,
      }),
    });
  }

  async runGeneric(options: GenericGenerateOptions): Promise<GenerationOutcome> {
    if (!options.endpoint.startsWith("/v1/")) {
      throw new ToolError({
        code: "VALIDATION_FAILED",
        message: `--endpoint must start with "/v1/" (received "${options.endpoint}").`,
        details: { endpoint: options.endpoint },
      });
    }

    const inputPath = path.resolve(this.cwd, options.input);
    let raw: Buffer;
    try {
      raw = await readFile(inputPath);
    } catch (error) {
      throw new ToolError({
        code: "INVALID_INPUT",
        message: `Cannot read generic request body ${options.input}.`,
        details: { path: options.input },
        cause: error,
      });
    }
    if (raw.byteLength === 0) {
      throw new ToolError({ code: "INVALID_INPUT", message: "Generic request body is empty." });
    }
    if (raw.byteLength > MAX_GENERIC_INPUT_BYTES) {
      throw new ToolError({
        code: "VALIDATION_FAILED",
        message: `Generic request body exceeds ${MAX_GENERIC_INPUT_BYTES} bytes.`,
        details: { bytes: raw.byteLength, maxBytes: MAX_GENERIC_INPUT_BYTES },
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8")) as unknown;
    } catch (error) {
      throw new ToolError({
        code: "INVALID_INPUT",
        message: "Generic request body is not valid JSON.",
        details: { path: options.input },
        cause: error,
      });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ToolError({
        code: "VALIDATION_FAILED",
        message: "Generic request body must be a JSON object of V1 parameters.",
      });
    }
    assertNoPrototypePollution(parsed);
    /** Sent to the provider verbatim: signatures/query parameters may be required. */
    const params = z.record(z.string(), z.unknown()).parse(parsed);
    /** Stored and echoed: signed query strings and secrets are removed. */
    let storedParams: Record<string, unknown>;
    try {
      storedParams = z.record(z.string(), z.unknown()).parse(scrubForStorage(params));
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      throw new ToolError({
        code: "VALIDATION_FAILED",
        message: "Generic request body is nested too deeply.",
        cause: error,
      });
    }

    return this.execute({
      operation: "generic",
      capability: "generic",
      logicalModel: GENERIC_LOGICAL_MODEL,
      output: options.output,
      force: options.force,
      dryRun: options.dryRun,
      normalizedRequest: { endpoint: options.endpoint, params: storedParams },
      inputs: [],
      buildRequest: async () => ({
        capability: "generic",
        logicalModel: GENERIC_LOGICAL_MODEL,
        endpoint: options.endpoint,
        params,
      }),
    });
  }

  // ------------------------------------------------------------- transaction

  private async execute(params: ExecuteParams): Promise<GenerationOutcome> {
    if (params.output.trim().length === 0) {
      throw new ToolError({ code: "VALIDATION_FAILED", message: "--output is required." });
    }

    const outputDirectory = path.resolve(this.cwd, params.output);
    const displayOutput = toDisplayPath(this.cwd, outputDirectory);
    const fingerprintParts: FingerprintParts = {
      provider: this.providerName,
      logicalModel: params.logicalModel,
      capability: params.capability,
      normalizedParameters: params.normalizedRequest,
      prompt: params.prompt,
      inputs: params.inputs.map((input) => input.fingerprintRef),
    };
    const fingerprint = fingerprintRequest(fingerprintParts);
    const manifestInputs = params.inputs.map((input) => input.manifestInput);

    const base = {
      operation: params.operation,
      capability: params.capability,
      provider: this.providerName,
      fingerprint,
      logicalModel: params.logicalModel,
      outputDirectory: displayOutput,
      inputs: manifestInputs,
      resolvedRequest: params.normalizedRequest,
    } as const;

    if (params.dryRun) {
      return { ...base, status: "validated", assets: [], reused: false, dryRun: true };
    }

    const existing = await this.manifests.read(outputDirectory);
    if (existing !== undefined && existing.fingerprint === fingerprint && !params.force) {
      const verification = await this.manifests.verify(outputDirectory, existing);
      if (verification.ok && existing.remote.status === "completed") {
        return {
          ...base,
          status: existing.remote.status,
          requestId: existing.remote.requestId,
          manifest: toDisplayPath(this.cwd, this.manifests.pathFor(outputDirectory)),
          assets: existing.outputs.map((output) =>
            this.assetFromManifestEntry(outputDirectory, output),
          ),
          reused: true,
          dryRun: false,
        };
      }
    }

    if (
      existing !== undefined &&
      existing.fingerprint !== fingerprint &&
      existing.remote.status === "completed" &&
      !params.force
    ) {
      const verification = await this.manifests.verify(outputDirectory, existing);
      if (verification.ok) {
        throw new ToolError({
          code: "VALIDATION_FAILED",
          message: `Output directory ${displayOutput} already holds a completed generation with fingerprint ${existing.fingerprint}. Pass --force to replace it, or choose a different --output.`,
          details: {
            output: displayOutput,
            existingFingerprint: existing.fingerprint,
            requestedFingerprint: fingerprint,
          },
        });
      }
    }

    // A paid submission is only made once we know the result can be stored.
    await assertWritableDirectory(outputDirectory);

    const request = await params.buildRequest();
    const result = this.requireCompleted(await this.provider.generate(request));

    try {
      return await this.persistResult({
        base,
        params,
        fingerprint,
        manifestInputs,
        result,
        outputDirectory,
      });
    } catch (error) {
      // The generation is paid for: never lose the job id on a local or download failure.
      throw withRequestId(error, result.requestId);
    }
  }

  /** Download, verify, finalize, and record the result of a paid generation. */
  private async persistResult(context: {
    base: Omit<GenerationOutcome, "status" | "assets" | "reused" | "dryRun">;
    params: ExecuteParams;
    fingerprint: string;
    manifestInputs: ManifestInput[];
    result: GenerationResult;
    outputDirectory: string;
  }): Promise<GenerationOutcome> {
    const { base, params, fingerprint, manifestInputs, result, outputDirectory } = context;

    const stagingDirectory = path.join(
      outputDirectory,
      `.hf-staging-${process.pid}-${randomBytes(4).toString("hex")}`,
    );
    const downloaded: { output: ManifestOutput; absolutePath: string; remoteUrl: string }[] = [];
    const counters: Record<AssetKind, number> = { image: 0, video: 0, audio: 0 };

    try {
      await mkdir(stagingDirectory, { recursive: true });
      for (const asset of result.assets) {
        counters[asset.kind] += 1;
        const filename = outputFilename(asset.kind, counters[asset.kind], asset.url);
        const download = await withRetry(
          () =>
            this.assets.download({
              url: asset.url,
              kind: asset.kind,
              directory: stagingDirectory,
              filename,
            }),
          this.retryPolicy,
          { sleeper: this.sleeper, random: this.random },
          isSafeToRetry,
        );
        downloaded.push({
          output: {
            type: asset.kind,
            path: filename,
            mimeType: download.mimeType,
            sha256: download.sha256,
            bytes: download.bytes,
          },
          absolutePath: download.absolutePath,
          remoteUrl: asset.url,
        });
      }

      // Replace only after every download verified: final names are touched last.
      for (const entry of downloaded) {
        await rename(entry.absolutePath, path.join(outputDirectory, entry.output.path));
      }
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }

    const manifest: GenerationManifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      assetId: path.basename(outputDirectory),
      provider: this.providerName,
      capability: params.capability,
      logicalModel: params.logicalModel,
      fingerprint,
      createdAt: this.manifests.createdAt(),
      ...(params.prompt === undefined ? {} : { prompt: params.prompt }),
      inputs: manifestInputs,
      request: params.normalizedRequest,
      remote: { requestId: result.requestId, status: result.status },
      outputs: downloaded.map((entry) => entry.output),
    };
    const manifestPath = await this.manifests.write(outputDirectory, manifest);

    return {
      ...base,
      status: result.status,
      requestId: result.requestId,
      manifest: toDisplayPath(this.cwd, manifestPath),
      assets: downloaded.map((entry) => ({
        type: entry.output.type,
        path: toDisplayPath(this.cwd, path.join(outputDirectory, entry.output.path)),
        mimeType: entry.output.mimeType,
        sha256: entry.output.sha256,
        bytes: entry.output.bytes,
        remoteUrl: entry.remoteUrl,
      })),
      reused: false,
      dryRun: false,
    };
  }

  /**
   * The provider contract is that `generate` throws for failed, moderated, or
   * canceled jobs. Enforce it here as well: a provider that returns a terminal
   * non-completed status must never produce a manifest or a "successful" command.
   */
  private requireCompleted(result: GenerationResult): GenerationResult {
    if (result.status === "completed") return result;

    const requestId = result.requestId;
    if (result.status === "nsfw") {
      throw new ToolError({
        code: "MODERATION_REJECTED",
        message: "Higgsfield rejected the generation as NSFW/moderated content.",
        requestId,
      });
    }
    if (result.status === "canceled") {
      throw new ToolError({
        code: "CANCELED",
        message: "The Higgsfield generation was canceled.",
        requestId,
      });
    }
    if (result.status === "failed") {
      throw new ToolError({
        code: "GENERATION_FAILED",
        message: "Higgsfield reported the generation as failed.",
        requestId,
      });
    }
    if (!isTerminalStatus(result.status)) {
      throw new ToolError({
        code: "PROVIDER_UNAVAILABLE",
        message: `Higgsfield request ${requestId} is still ${result.status} after polling stopped.`,
        requestId,
        retryable: true,
        details: { status: result.status, resumeWith: `hf status ${requestId}` },
      });
    }
    throw new ToolError({
      code: "GENERATION_FAILED",
      message: `Higgsfield request ${requestId} ended with status "${result.status}" and no result.`,
      requestId,
      details: { status: result.status },
    });
  }

  private assetFromManifestEntry(outputDirectory: string, output: ManifestOutput): GeneratedAsset {
    return {
      type: output.type,
      path: toDisplayPath(this.cwd, path.resolve(outputDirectory, output.path)),
      mimeType: output.mimeType,
      sha256: output.sha256,
      bytes: output.bytes,
    };
  }

  /**
   * Local inputs are hashed (never uploaded) before fingerprinting so duplicate
   * detection works without touching the network; URLs are normalized and
   * stripped of signed query parameters.
   */
  private async prepareInput(reference: string, kind: "image" | "audio"): Promise<PreparedInput> {
    const parsed = parseInputReference(reference);

    if (parsed.type === "url") {
      let normalized: string;
      try {
        normalized = stripQueryString(new URL(parsed.url).toString());
      } catch (error) {
        throw new ToolError({
          code: "INVALID_INPUT",
          message: `Input is not a valid URL: ${parsed.url}`,
          details: { reference },
          cause: error,
        });
      }
      return {
        kind,
        fingerprintRef: { kind, url: normalized },
        manifestInput: { kind, url: normalized },
        remoteUrl: async () => parsed.url,
      };
    }

    const inspected =
      kind === "image"
        ? await this.inspector.inspectImage(reference)
        : await this.inspector.inspectAudio(reference);
    let uploadedUrl: string | undefined;

    return {
      kind,
      fingerprintRef: { kind, sha256: inspected.sha256 },
      manifestInput: { kind, localPath: inspected.displayPath, sha256: inspected.sha256 },
      remoteUrl: async () => {
        if (uploadedUrl === undefined) {
          const uploaded = await this.upload(inspected);
          uploadedUrl = uploaded.url;
        }
        return uploadedUrl;
      },
    };
  }
}

function listPresetNames(kind: "image" | "video" | "speech"): string {
  if (kind === "image")
    return listImagePresets()
      .map((preset) => preset.name)
      .join(", ");
  if (kind === "video")
    return listVideoPresets()
      .map((preset) => preset.name)
      .join(", ");
  return listSpeechPresets()
    .map((preset) => preset.name)
    .join(", ");
}
