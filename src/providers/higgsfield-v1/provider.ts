import { InputImage } from "@higgsfield/client";
import {
  MAX_CHARACTER_IMAGES,
  MAX_CHARACTER_PAGE_SIZE,
  MIN_CHARACTER_IMAGES,
} from "../../config/defaults";
import type { ToolConfig } from "../../config/env";
import type {
  CharacterReference,
  CharacterReferencePage,
  CharacterReferenceRequest,
  MotionPreset,
  StylePreset,
  UploadRequest,
  UploadedAsset,
} from "../../domain/asset";
import { ToolError } from "../../domain/errors";
import type {
  AssetKind,
  Capability,
  GenerationResult,
  GenerationStatus,
  ProviderGenerationRequest,
  RemoteAsset,
} from "../../domain/generation";
import { isTerminalStatus } from "../../domain/generation";
import type { MediaProvider, ProviderName } from "../../domain/media-provider";
import type { Clock, RandomSource, Sleeper } from "../../domain/runtime";
import type { HiggsfieldSdk, V1HttpClient } from "./client";
import { jobSetRoute } from "./endpoints";
import { isSafeToRetry, withRequestId } from "../../domain/errors";
import { normalizeProviderError } from "./errors";
import { mapGenerationRequest, requiresDiscovery } from "./mapper";
import {
  jobListSchema,
  jobSetSchema,
  motionListSchema,
  parsePayload,
  soulIdPageSchema,
  soulIdSchema,
  styleListSchema,
  type V1Job,
} from "./payloads";
import { withRetry, type RetryDependencies, type RetryPolicy } from "../../domain/retry";
import { createV1Uploader, type V1UploadFunction } from "./upload";

/**
 * Higgsfield V1 provider (§8): the only module that touches the SDK, the raw
 * status route, and V1 polling.
 *
 * Paid submissions are sent exactly once. Retries are used only for read-only
 * or idempotent operations (status, discovery, uploads), never for generation.
 */

export interface HiggsfieldV1ProviderOptions {
  config: ToolConfig;
  sdk: HiggsfieldSdk;
  http: V1HttpClient;
  clock: Clock;
  sleeper: Sleeper;
  random: RandomSource;
}

const NORMALIZED_JOB_STATUSES: Record<string, GenerationStatus> = {
  queued: "queued",
  in_progress: "in_progress",
  completed: "completed",
  failed: "failed",
  nsfw: "nsfw",
  canceled: "canceled",
};

const CHARACTER_STATUSES: Record<string, CharacterReference["status"]> = {
  not_ready: "not_ready",
  queued: "queued",
  in_progress: "in_progress",
  completed: "completed",
  failed: "failed",
};

const ASSET_KIND_BY_RESULT_TYPE: Record<string, AssetKind> = {
  image: "image",
  video: "video",
  audio: "audio",
};

const ASSET_KIND_BY_EXTENSION: Record<string, AssetKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  avif: "image",
  mp4: "video",
  webm: "video",
  mov: "video",
  wav: "audio",
  mp3: "audio",
};

const DEFAULT_KIND_BY_CAPABILITY: Record<Capability, AssetKind> = {
  "text-to-image": "image",
  "character-reference": "image",
  "image-to-video": "video",
  "speech-to-video": "video",
  // Generic endpoints are untyped; the URL extension is preferred and video is
  // the conservative default for V1 generation endpoints.
  generic: "video",
};

const DEFAULT_PAGE_SIZE = 20;

export class HiggsfieldV1Provider implements MediaProvider {
  readonly name: ProviderName = "higgsfield-v1";

  private readonly config: ToolConfig;
  private readonly sdk: HiggsfieldSdk;
  private readonly http: V1HttpClient;
  private readonly clock: Clock;
  private readonly sleeper: Sleeper;
  private readonly retryPolicy: RetryPolicy;
  private readonly retryDependencies: RetryDependencies;
  private readonly uploadFn: V1UploadFunction;

  constructor(options: HiggsfieldV1ProviderOptions) {
    this.config = options.config;
    this.sdk = options.sdk;
    this.http = options.http;
    this.clock = options.clock;
    this.sleeper = options.sleeper;
    this.retryPolicy = {
      count: options.config.retryCount,
      backoffMs: options.config.retryBackoffMs,
      maxBackoffMs: options.config.retryMaxBackoffMs,
    };
    this.retryDependencies = { sleeper: options.sleeper, random: options.random };
    this.uploadFn = createV1Uploader({
      sdk: options.sdk,
      retryPolicy: this.retryPolicy,
      dependencies: this.retryDependencies,
      apiBaseUrl: options.config.apiBaseUrl,
    });
  }

  // ---------------------------------------------------------------- uploads

  async upload(request: UploadRequest): Promise<UploadedAsset> {
    return this.uploadFn(request);
  }

  // ------------------------------------------------------------ generation

  async generate(request: ProviderGenerationRequest): Promise<GenerationResult> {
    const mapped = mapGenerationRequest(request, await this.mapperContext(request));
    const submitted = await this.submit(mapped.endpoint, mapped.params);
    const { status, jobs } = await this.awaitTerminal(
      submitted.id,
      submitted.jobs,
      request.capability,
    );
    return this.resultFromJobs(submitted.id, status, jobs, request.capability);
  }

  private async submit(
    endpoint: string,
    params: Record<string, unknown>,
  ): Promise<{ id: string; jobs: V1Job[] }> {
    try {
      const jobSet = await this.sdk.generate(endpoint, params, { withPolling: false });
      return parsePayload(jobSetSchema, jobSet, "job set");
    } catch (error) {
      const normalized = normalizeProviderError(error, `Higgsfield rejected ${endpoint}.`);
      // A retryable classification (timeout, socket reset, gateway 5xx) means the
      // POST may already have been accepted and billed. Submission is therefore
      // never advertised as retryable, whatever the transport reported.
      if (normalized.retryable) {
        throw new ToolError({
          code: normalized.code,
          message:
            "Higgsfield did not confirm the generation submission. Whether the request was accepted is unknown, so it is not safe to resubmit automatically.",
          details: normalized.details,
          retryable: false,
          cause: error,
        });
      }
      throw normalized;
    }
  }

  /** Poll the V1 job-set route until the aggregate status is terminal (§12/§13). */
  private async awaitTerminal(
    requestId: string,
    initialJobs: V1Job[],
    capability: Capability,
  ): Promise<{ status: GenerationStatus; jobs: V1Job[] }> {
    const limitMs =
      capability === "text-to-image" ? this.config.imagePollLimitMs : this.config.videoPollLimitMs;
    const deadline = this.clock.now().getTime() + limitMs;
    let jobs = initialJobs;

    for (;;) {
      let status: GenerationStatus;
      try {
        status = this.aggregateStatus(jobs);
      } catch (error) {
        // An unrecognized status is still about a job we already paid for.
        throw withRequestId(error, requestId);
      }
      if (isTerminalStatus(status)) return { status, jobs };

      if (this.clock.now().getTime() >= deadline) {
        throw new ToolError({
          code: "TIMEOUT",
          message: `Higgsfield job ${requestId} did not reach a terminal state within ${limitMs}ms. The job may still be running.`,
          requestId,
          retryable: true,
          details: { limitMs, lastStatus: status, resumeWith: `hf status ${requestId}` },
        });
      }

      await this.sleeper.sleep(this.config.pollIntervalMs);
      try {
        jobs = await this.fetchJobs(requestId);
      } catch (error) {
        // The job is already paid for: the caller must keep the id so it can be
        // inspected with `hf status` instead of blindly resubmitting.
        throw withRequestId(error, requestId);
      }
    }
  }

  private async fetchJobs(requestId: string): Promise<V1Job[]> {
    const response = await withRetry(
      async () => {
        try {
          return await this.http.get(jobSetRoute(requestId));
        } catch (error) {
          // Normalize before classifying: retry eligibility depends on the
          // taxonomy, not on the transport's error class.
          throw normalizeProviderError(error, `Higgsfield status request for ${requestId} failed.`);
        }
      },
      this.retryPolicy,
      this.retryDependencies,
      isSafeToRetry,
    );
    return parsePayload(jobListSchema, response.body, "job set").jobs;
  }

  /**
   * Aggregate all jobs into one normalized status. Failure and moderation
   * dominate completion, so partially failed job sets are never reported as
   * success.
   */
  private aggregateStatus(jobs: V1Job[]): GenerationStatus {
    const statuses = jobs.map((job) => this.normalizeJobStatus(job.status));
    if (statuses.includes("nsfw")) return "nsfw";
    if (statuses.includes("failed")) return "failed";
    if (statuses.includes("canceled")) return "canceled";
    if (statuses.length > 0 && statuses.every((status) => status === "completed")) {
      return "completed";
    }
    if (statuses.length > 0 && statuses.every((status) => status === "queued")) return "queued";
    // An empty job set means "not materialized yet", never "done": keep polling so an
    // already-submitted job is awaited rather than failed immediately.
    return "in_progress";
  }

  private normalizeJobStatus(status: string): GenerationStatus {
    const normalized = NORMALIZED_JOB_STATUSES[status.toLowerCase()];
    if (normalized === undefined) {
      throw new ToolError({
        code: "UNKNOWN_PROVIDER_ERROR",
        message: `Higgsfield reported an unrecognized job status "${status}".`,
        details: { status },
      });
    }
    return normalized;
  }

  private resultFromJobs(
    requestId: string,
    status: GenerationStatus,
    jobs: V1Job[],
    capability: Capability,
  ): GenerationResult {
    switch (status) {
      case "nsfw":
        throw new ToolError({
          code: "MODERATION_REJECTED",
          message: "Higgsfield rejected the generation as NSFW/moderated content.",
          requestId,
          details: { jobIds: jobs.map((job) => job.id) },
        });
      case "failed":
        throw new ToolError({
          code: "GENERATION_FAILED",
          message: "Higgsfield reported the generation as failed.",
          requestId,
          details: { jobIds: jobs.map((job) => job.id) },
        });
      case "canceled":
        throw new ToolError({
          code: "CANCELED",
          message: "The Higgsfield generation was canceled.",
          requestId,
          details: { jobIds: jobs.map((job) => job.id) },
        });
      case "completed": {
        const assets = this.collectAssets(jobs, capability);
        if (assets.length === 0) {
          throw new ToolError({
            code: "GENERATION_FAILED",
            message: "Higgsfield reported completion without any result URL.",
            requestId,
            details: { jobIds: jobs.map((job) => job.id) },
          });
        }
        return { requestId, status, assets };
      }
      default:
        throw new ToolError({
          code: "PROVIDER_UNAVAILABLE",
          message: `Higgsfield job ${requestId} is still ${status} after polling stopped.`,
          requestId,
          details: { status },
          retryable: true,
        });
    }
  }

  private collectAssets(jobs: V1Job[], capability: Capability): RemoteAsset[] {
    const assets: RemoteAsset[] = [];
    const seen = new Set<string>();
    for (const job of jobs) {
      const results = job.results;
      if (results === undefined || results === null) continue;
      const chosen = results.raw ?? results.min;
      if (chosen === undefined) continue;
      if (seen.has(chosen.url)) continue;
      seen.add(chosen.url);
      assets.push({ kind: this.assetKind(chosen.type, chosen.url, capability), url: chosen.url });
    }
    return assets;
  }

  private assetKind(type: string | undefined, url: string, capability: Capability): AssetKind {
    if (type !== undefined) {
      const byType = ASSET_KIND_BY_RESULT_TYPE[type.toLowerCase()];
      if (byType !== undefined) return byType;
    }
    const match = /\.([a-zA-Z0-9]{1,5})(?:\?|#|$)/.exec(url);
    const extension = match?.[1]?.toLowerCase();
    if (extension !== undefined) {
      const byExtension = ASSET_KIND_BY_EXTENSION[extension];
      if (byExtension !== undefined) return byExtension;
    }
    return DEFAULT_KIND_BY_CAPABILITY[capability];
  }

  // --------------------------------------------------------------- status

  async getStatus(requestId: string): Promise<GenerationStatus> {
    return this.aggregateStatus(await this.fetchJobs(requestId));
  }

  // ------------------------------------------------------------ discovery

  async listMotions(): Promise<MotionPreset[]> {
    const response = await this.callSdk(() => this.sdk.getMotions(), "motions");
    return parsePayload(motionListSchema, response, "motions").map((motion) => ({
      id: motion.id,
      name: motion.name,
      ...(motion.description === undefined ? {} : { description: motion.description }),
      ...(motion.preview_url === undefined ? {} : { previewUrl: motion.preview_url }),
      ...(motion.start_end_frame === undefined ? {} : { startEndFrame: motion.start_end_frame }),
    }));
  }

  async listStyles(): Promise<StylePreset[]> {
    const response = await this.callSdk(() => this.sdk.getSoulStyles(), "styles");
    return parsePayload(styleListSchema, response, "styles").map((style) => ({
      id: style.id,
      name: style.name,
      ...(style.description === undefined ? {} : { description: style.description }),
      ...(style.preview_url === undefined ? {} : { previewUrl: style.preview_url }),
    }));
  }

  /** Read-only SDK calls retry on safe failures; creation calls never retry. */
  private async callSdk<T>(operation: () => Promise<T>, what: string): Promise<T> {
    return withRetry(
      async () => {
        try {
          return await operation();
        } catch (error) {
          throw normalizeProviderError(error, `Higgsfield ${what} request failed.`);
        }
      },
      this.retryPolicy,
      this.retryDependencies,
      isSafeToRetry,
    );
  }

  // ----------------------------------------------------------- characters

  async createCharacter(request: CharacterReferenceRequest): Promise<CharacterReference> {
    if (
      request.images.length < MIN_CHARACTER_IMAGES ||
      request.images.length > MAX_CHARACTER_IMAGES
    ) {
      throw new ToolError({
        code: "VALIDATION_FAILED",
        message: `Character references require between ${MIN_CHARACTER_IMAGES} and ${MAX_CHARACTER_IMAGES} images (received ${request.images.length}).`,
        details: { images: request.images.length },
      });
    }

    const parsed = parsePayload(
      soulIdSchema,
      await this.createSoulId({
        name: request.name,
        input_images: request.images.map((image) => InputImage.fromUrl(image.url)),
      }),
      "custom reference",
    );

    return {
      id: parsed.id,
      name: parsed.name,
      status: this.characterStatus(parsed.status),
    };
  }

  private async createSoulId(data: {
    name: string;
    input_images: { type: string; image_url: string }[];
  }): Promise<unknown> {
    try {
      // Polling inside the SDK is safe here: creating a reference is idempotent
      // enough to observe, and the SDK does not resubmit (maxRetries: 0).
      return await this.sdk.createSoulId(data, true);
    } catch (error) {
      throw normalizeProviderError(error, "Higgsfield custom reference creation failed.");
    }
  }

  async listCharacters(page = 1, pageSize = DEFAULT_PAGE_SIZE): Promise<CharacterReferencePage> {
    if (!Number.isInteger(page) || page < 1) {
      throw new ToolError({
        code: "VALIDATION_FAILED",
        message: `page must be a positive integer (received ${page}).`,
        details: { page },
      });
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_CHARACTER_PAGE_SIZE) {
      throw new ToolError({
        code: "VALIDATION_FAILED",
        message: `page-size must be an integer between 1 and ${MAX_CHARACTER_PAGE_SIZE} (received ${pageSize}).`,
        details: { pageSize },
      });
    }

    const raw = await this.callSdk(
      () => this.sdk.listSoulIds(page, pageSize),
      "custom reference list",
    );
    const parsed = parsePayload(soulIdPageSchema, raw, "custom reference list");

    return {
      total: parsed.total,
      page: parsed.page,
      pageSize: parsed.page_size,
      totalPages: parsed.total_pages,
      items: parsed.items.map((item) => ({
        id: item.id,
        name: item.name,
        status: this.characterStatus(item.status),
      })),
    };
  }

  private characterStatus(status: string): CharacterReference["status"] {
    const normalized = CHARACTER_STATUSES[status.toLowerCase()];
    if (normalized === undefined) {
      throw new ToolError({
        code: "UNKNOWN_PROVIDER_ERROR",
        message: `Higgsfield reported an unrecognized custom reference status "${status}".`,
        details: { status },
      });
    }
    return normalized;
  }

  /** Discovery is fetched only when the request actually references a preset by name. */
  private async mapperContext(request: ProviderGenerationRequest): Promise<{
    motions: MotionPreset[];
    styles: StylePreset[];
  }> {
    if (!requiresDiscovery(request)) return { motions: [], styles: [] };
    if (request.capability === "image-to-video") {
      return { motions: await this.listMotions(), styles: [] };
    }
    return { motions: [], styles: await this.listStyles() };
  }
}
