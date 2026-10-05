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

/**
 * Credential variables, in the names the provider and its SDK document.
 *
 * The dashboard hands out a single `KEY_ID:KEY_SECRET` value, so a combined
 * variable is the preferred form; the separate pair (including the SDK's own
 * `HF_API_SECRET` name) stays supported.
 */
export const COMBINED_CREDENTIAL_VARIABLES = ["HF_CREDENTIALS", "HF_KEY"] as const;
export const API_KEY_VARIABLES = ["HF_API_KEY"] as const;
export const API_SECRET_VARIABLES = ["HF_SECRET", "HF_API_SECRET"] as const;

export type CredentialSource = "separate" | "combined" | "missing" | "incomplete";

export interface Credentials {
  apiKey?: string;
  apiSecret?: string;
  source: CredentialSource;
  /** Variable name(s) the credentials were read from; never the values. */
  sourceVariable: string;
  /** Credential variables that were set, even when the configuration is incomplete. */
  presentVariables: string[];
}

const ALL_CREDENTIAL_VARIABLES = [
  ...API_KEY_VARIABLES,
  ...API_SECRET_VARIABLES,
  ...COMBINED_CREDENTIAL_VARIABLES,
];

function presentCredentialVariables(env: Record<string, string | undefined>): string[] {
  return ALL_CREDENTIAL_VARIABLES.filter((name) => {
    const value = env[name];
    return value !== undefined && value.trim() !== "";
  });
}

function findVariable(
  env: Record<string, string | undefined>,
  names: readonly string[],
): { name: string; value: string } | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.trim() !== "") return { name, value: value.trim() };
  }
  return undefined;
}

/**
 * Resolve credentials from the environment.
 *
 * Precedence: a complete separate pair, then a combined `KEY_ID:KEY_SECRET`
 * value (which also rescues a half-configured pair), then diagnose what is
 * missing. A malformed combined value is a configuration error, not an auth
 * failure: the message says what shape was expected.
 */
export function resolveCredentials(env: Record<string, string | undefined>): Credentials {
  const presentVariables = presentCredentialVariables(env);
  const keyVariable = findVariable(env, API_KEY_VARIABLES);
  const secretVariable = findVariable(env, API_SECRET_VARIABLES);
  if (keyVariable !== undefined && secretVariable !== undefined) {
    return {
      apiKey: keyVariable.value,
      apiSecret: secretVariable.value,
      source: "separate",
      sourceVariable: `${keyVariable.name}+${secretVariable.name}`,
      presentVariables,
    };
  }

  const combinedVariable = findVariable(env, COMBINED_CREDENTIAL_VARIABLES);
  if (combinedVariable !== undefined) {
    const separator = combinedVariable.value.indexOf(":");
    const keyId = separator === -1 ? "" : combinedVariable.value.slice(0, separator).trim();
    const keySecret = separator === -1 ? "" : combinedVariable.value.slice(separator + 1).trim();
    if (keyId === "" || keySecret === "") {
      throw new ToolError({
        code: "VALIDATION_FAILED",
        message: `${combinedVariable.name} must be "<key_id>:<key_secret>" (split on the first colon); the configured value does not match that shape.`,
        details: { variable: combinedVariable.name },
      });
    }
    return {
      apiKey: keyId,
      apiSecret: keySecret,
      source: "combined",
      sourceVariable: combinedVariable.name,
      presentVariables,
    };
  }

  if (keyVariable !== undefined || secretVariable !== undefined) {
    return {
      source: "incomplete",
      sourceVariable: [keyVariable?.name, secretVariable?.name].filter(Boolean).join("+"),
      presentVariables,
    };
  }

  return { source: "missing", sourceVariable: "", presentVariables };
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
  credentialSource: z.enum(["separate", "combined", "missing", "incomplete"]).default("missing"),
  credentialSourceVariable: z.preprocess(emptyToUndefined, z.string().optional()),
  credentialPresentVariables: z.array(z.string()).default([]),
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
  // Credential overrides short-circuit environment resolution: an injected apiKey
  // without a secret stays incomplete rather than silently mixing sources.
  const hasCredentialOverride =
    options.overrides?.apiKey !== undefined || options.overrides?.apiSecret !== undefined;
  const resolved: Credentials = hasCredentialOverride
    ? {
        ...(options.overrides?.apiKey === undefined ? {} : { apiKey: options.overrides.apiKey }),
        ...(options.overrides?.apiSecret === undefined
          ? {}
          : { apiSecret: options.overrides.apiSecret }),
        source:
          options.overrides?.apiKey !== undefined && options.overrides?.apiSecret !== undefined
            ? "separate"
            : "incomplete",
        sourceVariable: "config overrides",
        presentVariables: ["config overrides"],
      }
    : resolveCredentials(env);

  const raw: Record<string, unknown> = {
    provider: env.HF_PROVIDER ?? DEFAULT_PROVIDER,
    apiBaseUrl: env.HF_API_BASE_URL ?? DEFAULT_API_BASE_URL,
    apiKey: resolved.apiKey,
    apiSecret: resolved.apiSecret,
    credentialSource: resolved.source,
    credentialSourceVariable: resolved.sourceVariable,
    credentialPresentVariables: resolved.presentVariables,
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

  const credentials: Credentials = {
    source: data.credentialSource,
    sourceVariable: data.credentialSourceVariable ?? "",
    presentVariables: data.credentialPresentVariables,
    ...(data.apiKey === undefined ? {} : { apiKey: data.apiKey }),
    ...(data.apiSecret === undefined ? {} : { apiSecret: data.apiSecret }),
  };
  // Registered for redaction so no credential can appear in a message, a JSON
  // envelope, a manifest, or a cache file — for either credential form.
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

const CREDENTIAL_HELP =
  'Set HF_CREDENTIALS="<key_id>:<key_secret>" (the single value the Higgsfield dashboard gives you), ' +
  "or the separate pair HF_API_KEY and HF_API_SECRET (HF_SECRET is also accepted). See .env.example.";

/**
 * One canonical description of a credentials problem, shared by `requireCredentials`
 * and `hf doctor` so both report the same diagnosis and the same fix.
 */
export function describeCredentialProblem(credentials: Credentials): string {
  if (credentials.source === "incomplete") {
    return `Higgsfield credentials are incomplete: ${credentials.sourceVariable} is set but its counterpart is not. ${CREDENTIAL_HELP}`;
  }
  if (credentials.presentVariables.length > 0) {
    return `Higgsfield credentials are missing (set: ${credentials.presentVariables.join(", ")}). ${CREDENTIAL_HELP}`;
  }
  return `Higgsfield credentials are missing. ${CREDENTIAL_HELP}`;
}

/** Credentials are demand-loaded: only commands that contact the provider need them. */
export function requireCredentials(config: ToolConfig): RequiredCredentials {
  const { apiKey, apiSecret, source, sourceVariable, presentVariables } = config.credentials;
  if (apiKey === undefined || apiSecret === undefined) {
    throw new ToolError({
      code: "AUTHENTICATION_FAILED",
      message: describeCredentialProblem(config.credentials),
      details: {
        hasApiKey: apiKey !== undefined,
        hasApiSecret: apiSecret !== undefined,
        source,
        presentVariables,
        ...(sourceVariable === "" ? {} : { sourceVariable }),
      },
    });
  }
  return { apiKey, apiSecret };
}

export function hasCredentials(config: ToolConfig): boolean {
  return config.credentials.apiKey !== undefined && config.credentials.apiSecret !== undefined;
}
