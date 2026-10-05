import { z } from "zod";
import { ToolError } from "../domain/errors";
import type { ProviderName } from "../domain/media-provider";
import { SUPPORTED_PROVIDERS } from "../domain/media-provider";
import { registerSecret } from "../domain/redact";
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_CACHE_ROOT,
  DEFAULT_IMAGE_POLL_LIMIT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_PROVIDER,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RETRY_BACKOFF_MS,
  DEFAULT_RETRY_COUNT,
  DEFAULT_RETRY_MAX_BACKOFF_MS,
  DEFAULT_VIDEO_POLL_LIMIT_MS,
  MAX_RETRY_COUNT,
  MIN_RETRY_COUNT,
} from "./defaults";

export interface Credentials {
  apiKey?: string;
  apiSecret?: string;
}

export interface ToolConfig {
  provider: ProviderName;
  apiBaseUrl: string;
  credentials: Credentials;
  timeoutMs: number;
  retryCount: number;
  retryBackoffMs: number;
  retryMaxBackoffMs: number;
  pollIntervalMs: number;
  imagePollLimitMs: number;
  videoPollLimitMs: number;
  /** Cache root as configured; resolved against the working directory on use. */
  cacheRoot: string;
  debug: boolean;
}

/** Typed overrides applied after environment parsing input, before validation. */
export interface ConfigOverrides {
  provider?: string;
  apiBaseUrl?: string;
  apiKey?: string;
  apiSecret?: string;
  timeoutMs?: number;
  retryCount?: number;
  retryBackoffMs?: number;
  retryMaxBackoffMs?: number;
  pollIntervalMs?: number;
  imagePollLimitMs?: number;
  videoPollLimitMs?: number;
  cacheRoot?: string;
  debug?: boolean;
}

export interface LoadConfigOptions {
  env?: Record<string, string | undefined>;
  overrides?: ConfigOverrides;
}

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalText = z.preprocess(emptyToUndefined, z.string().min(1).optional());

const boundedInt = (fallback: number, min: number, max: number) =>
  z.preprocess(
    emptyToUndefined,
    z.coerce
      .number()
      .int("must be an integer")
      .min(min, `must be >= ${min}`)
      .max(max, `must be <= ${max}`)
      .default(fallback),
  );

const absoluteUrl = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an absolute http(s) URL");

const configSchema = z.object({
  provider: z.string().min(1).default(DEFAULT_PROVIDER),
  apiBaseUrl: z.preprocess(emptyToUndefined, absoluteUrl.default(DEFAULT_API_BASE_URL)),
  apiKey: optionalText,
  apiSecret: optionalText,
  timeoutMs: boundedInt(DEFAULT_REQUEST_TIMEOUT_MS, 1_000, 3_600_000),
  retryCount: boundedInt(DEFAULT_RETRY_COUNT, MIN_RETRY_COUNT, MAX_RETRY_COUNT),
  retryBackoffMs: boundedInt(DEFAULT_RETRY_BACKOFF_MS, 0, 600_000),
  retryMaxBackoffMs: boundedInt(DEFAULT_RETRY_MAX_BACKOFF_MS, 0, 3_600_000),
  pollIntervalMs: boundedInt(DEFAULT_POLL_INTERVAL_MS, 100, 600_000),
  imagePollLimitMs: boundedInt(DEFAULT_IMAGE_POLL_LIMIT_MS, 1_000, 3_600_000),
  videoPollLimitMs: boundedInt(DEFAULT_VIDEO_POLL_LIMIT_MS, 1_000, 7_200_000),
  cacheRoot: z.preprocess(emptyToUndefined, z.string().min(1).default(DEFAULT_CACHE_ROOT)),
  debug: z.preprocess(emptyToUndefined, z.string().optional().default("0")),
});

function readRawInput(options: LoadConfigOptions): Record<string, unknown> {
  const env = options.env ?? process.env;
  const raw: Record<string, unknown> = {
    provider: env.HF_PROVIDER ?? DEFAULT_PROVIDER,
    apiBaseUrl: env.HF_API_BASE_URL ?? DEFAULT_API_BASE_URL,
    apiKey: env.HF_API_KEY,
    apiSecret: env.HF_SECRET,
    timeoutMs: env.HF_REQUEST_TIMEOUT_MS ?? DEFAULT_REQUEST_TIMEOUT_MS,
    retryCount: env.HF_RETRY_COUNT ?? DEFAULT_RETRY_COUNT,
    retryBackoffMs: env.HF_RETRY_BACKOFF_MS ?? DEFAULT_RETRY_BACKOFF_MS,
    retryMaxBackoffMs: env.HF_RETRY_MAX_BACKOFF_MS ?? DEFAULT_RETRY_MAX_BACKOFF_MS,
    pollIntervalMs: env.HF_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS,
    imagePollLimitMs: env.HF_IMAGE_POLL_LIMIT_MS ?? DEFAULT_IMAGE_POLL_LIMIT_MS,
    videoPollLimitMs: env.HF_VIDEO_POLL_LIMIT_MS ?? DEFAULT_VIDEO_POLL_LIMIT_MS,
    cacheRoot: env.HF_CACHE_ROOT ?? DEFAULT_CACHE_ROOT,
    debug: env.HF_DEBUG ?? "0",
  };
  for (const [key, value] of Object.entries(options.overrides ?? {})) {
    if (value !== undefined) raw[key] = value;
  }
  return raw;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/**
 * Parse configuration from environment plus injected overrides.
 * Credentials are validated lazily by `requireCredentials`: `--dry-run` and
 * `--help` must work without secrets.
 */
export function loadConfig(options: LoadConfigOptions = {}): ToolConfig {
  const parsed = configSchema.safeParse(readRawInput(options));
  if (!parsed.success) {
    throw new ToolError({
      code: "VALIDATION_FAILED",
      message: `Invalid configuration: ${describeIssues(parsed.error)}`,
      details: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join(".") || "(root)",
          message: issue.message,
        })),
      },
    });
  }

  const data = parsed.data;
  const provider = SUPPORTED_PROVIDERS[data.provider];
  if (provider === undefined) {
    throw new ToolError({
      code: "VALIDATION_FAILED",
      message: `Unsupported HF_PROVIDER "${data.provider}". Supported providers: ${Object.keys(
        SUPPORTED_PROVIDERS,
      ).join(", ")}.`,
      details: { provider: data.provider, supported: Object.keys(SUPPORTED_PROVIDERS) },
    });
  }

  if (data.retryMaxBackoffMs < data.retryBackoffMs) {
    throw new ToolError({
      code: "VALIDATION_FAILED",
      message: "HF_RETRY_MAX_BACKOFF_MS must be greater than or equal to HF_RETRY_BACKOFF_MS.",
      details: {
        retryBackoffMs: data.retryBackoffMs,
        retryMaxBackoffMs: data.retryMaxBackoffMs,
      },
    });
  }

  const credentials: Credentials = {};
  if (data.apiKey !== undefined) credentials.apiKey = data.apiKey;
  if (data.apiSecret !== undefined) credentials.apiSecret = data.apiSecret;
  registerSecret(credentials.apiKey);
  registerSecret(credentials.apiSecret);

  return Object.freeze({
    provider,
    apiBaseUrl: data.apiBaseUrl,
    credentials: Object.freeze(credentials),
    timeoutMs: data.timeoutMs,
    retryCount: data.retryCount,
    retryBackoffMs: data.retryBackoffMs,
    retryMaxBackoffMs: data.retryMaxBackoffMs,
    pollIntervalMs: data.pollIntervalMs,
    imagePollLimitMs: data.imagePollLimitMs,
    videoPollLimitMs: data.videoPollLimitMs,
    cacheRoot: data.cacheRoot,
    debug: data.debug === "1" || data.debug.toLowerCase() === "true",
  }) satisfies ToolConfig;
}

export interface RequiredCredentials {
  apiKey: string;
  apiSecret: string;
}

/** Credentials are demand-loaded: only commands that contact the provider need them. */
export function requireCredentials(config: ToolConfig): RequiredCredentials {
  const { apiKey, apiSecret } = config.credentials;
  if (apiKey === undefined || apiSecret === undefined) {
    throw new ToolError({
      code: "AUTHENTICATION_FAILED",
      message:
        "Higgsfield credentials are missing. Set HF_API_KEY and HF_SECRET in the environment (see .env.example).",
      details: { hasApiKey: apiKey !== undefined, hasApiSecret: apiSecret !== undefined },
    });
  }
  return { apiKey, apiSecret };
}

export function hasCredentials(config: ToolConfig): boolean {
  return config.credentials.apiKey !== undefined && config.credentials.apiSecret !== undefined;
}
