import {
  APIError,
  AuthenticationError,
  BadInputError,
  CredentialsMissedError,
  NotEnoughCreditsError,
  TimeoutError,
  ValidationError,
} from "@higgsfield/client";
import { ToolError } from "../../domain/errors";

/**
 * SDK/HTTP failure normalization (§18). Only codes that provably did not commit
 * a paid request are marked retryable.
 */

const NETWORK_ERROR_CODES: Record<string, true> = {
  ECONNRESET: true,
  ECONNREFUSED: true,
  ETIMEDOUT: true,
  ENOTFOUND: true,
  EAI_AGAIN: true,
  EPIPE: true,
  EHOSTUNREACH: true,
  ENETUNREACH: true,
  UND_ERR_SOCKET: true,
  UND_ERR_CONNECT_TIMEOUT: true,
  UND_ERR_HEADERS_TIMEOUT: true,
  UND_ERR_BODY_TIMEOUT: true,
};

interface ErrorLike {
  code?: unknown;
  statusCode?: unknown;
  response?: { status?: unknown } | undefined;
  details?: unknown;
}

function asErrorLike(error: unknown): ErrorLike {
  return typeof error === "object" && error !== null ? (error as ErrorLike) : {};
}

function statusOf(error: unknown): number | undefined {
  if (error instanceof APIError && typeof error.statusCode === "number") return error.statusCode;
  const like = asErrorLike(error);
  if (typeof like.statusCode === "number") return like.statusCode;
  const responseStatus = like.response?.status;
  return typeof responseStatus === "number" ? responseStatus : undefined;
}

function errorCodeOf(error: unknown): string | undefined {
  const code = asErrorLike(error).code;
  return typeof code === "string" ? code : undefined;
}

const TIMEOUT_ERROR_CODES: Record<string, true> = {
  // axios reports its own request timeout as ECONNABORTED.
  ECONNABORTED: true,
  ETIMEDOUT: true,
  UND_ERR_CONNECT_TIMEOUT: true,
  UND_ERR_HEADERS_TIMEOUT: true,
  UND_ERR_BODY_TIMEOUT: true,
};

function isTimeoutError(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  const code = errorCodeOf(error);
  return code !== undefined && TIMEOUT_ERROR_CODES[code] === true;
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return fallback;
}

/**
 * Where a failed upload actually failed.
 *
 * The SDK raises one error class for both the provider API and the signed storage URL.
 * `unknown` means the transport carried no request metadata, in which case the API
 * taxonomy is preserved rather than guessed.
 */
export type UploadFailureStage = "api" | "storage" | "unknown";

export function uploadFailureStage(error: unknown, apiBaseUrl: string): UploadFailureStage {
  const config = (error as { config?: { url?: unknown; baseURL?: unknown } }).config;
  if (config === undefined) return "unknown";
  const requestUrl = typeof config.url === "string" ? config.url : "";
  const baseUrl = typeof config.baseURL === "string" ? config.baseURL : "";
  if (requestUrl === "" && baseUrl === "") return "unknown";
  const target = requestUrl.startsWith("http") ? requestUrl : `${baseUrl}${requestUrl}`;
  try {
    return new URL(target).host === new URL(apiBaseUrl).host ? "api" : "storage";
  } catch {
    return "unknown";
  }
}

/** Extract the storage error code (e.g. SignatureDoesNotMatch) from an S3 XML body. */
export function storageErrorCode(body: unknown): string | undefined {
  if (typeof body !== "string") return undefined;
  const match = /<Code>([^<]+)<\/Code>/.exec(body);
  return match?.[1];
}

export interface UploadFailureContext {
  apiBaseUrl: string;
  filename: string;
}

/**
 * Normalize a failed upload.
 *
 * Failures from the provider API keep the API taxonomy (auth, credits, validation).
 * Failures from the signed storage URL become UPLOAD_FAILED with the storage status,
 * host, and provider error code, because a storage rejection is not an account state
 * and must not be reported as one.
 */
export function normalizeUploadFailure(error: unknown, context: UploadFailureContext): ToolError {
  const normalized = normalizeProviderError(error, `Upload of ${context.filename} failed.`);
  if (uploadFailureStage(error, context.apiBaseUrl) !== "storage") {
    return normalized.code === "UNKNOWN_PROVIDER_ERROR"
      ? new ToolError({
          code: "UPLOAD_FAILED",
          message: `Upload of ${context.filename} failed: ${normalized.message}`,
          details: normalized.details,
          retryable: normalized.retryable,
          cause: error,
        })
      : normalized;
  }

  const like = error as {
    config?: { url?: unknown };
    response?: { status?: unknown; data?: unknown };
  };
  const status = typeof like.response?.status === "number" ? like.response.status : undefined;
  const requestUrl = typeof like.config?.url === "string" ? like.config.url : "";
  let storageHost = "storage";
  try {
    storageHost = new URL(requestUrl).host;
  } catch {
    // Keep the generic label when the URL is unavailable.
  }
  const providerCode = storageErrorCode(like.response?.data);
  const retryable = status !== undefined && (status === 408 || status === 429 || status >= 500);
  const rejection = [status === undefined ? undefined : `HTTP ${status}`, providerCode]
    .filter((part) => part !== undefined)
    .join(", ");

  return new ToolError({
    code: "UPLOAD_FAILED",
    message:
      `Upload of ${context.filename} was rejected by the provider's storage endpoint` +
      `${rejection === "" ? "" : ` (${rejection})`}. ` +
      "This is a storage-level rejection of the signed upload URL, not an account or credits problem.",
    details: {
      stage: "signed-url-put",
      ...(status === undefined ? {} : { status }),
      ...(providerCode === undefined ? {} : { providerCode }),
      storageHost,
    },
    retryable,
    cause: error,
  });
}

/** Map an HTTP status to a normalized error, used by the adapter's own fetch paths. */
export function toolErrorFromHttpStatus(
  status: number,
  context: { path: string; message?: string },
): ToolError {
  const base =
    context.message ?? `Higgsfield request to ${context.path} failed with HTTP ${status}.`;
  if (status === 401) {
    return new ToolError({
      code: "AUTHENTICATION_FAILED",
      message: base,
      details: { status, path: context.path },
    });
  }
  if (status === 402 || status === 403) {
    return new ToolError({
      code: "INSUFFICIENT_CREDITS",
      message: base,
      details: { status, path: context.path },
    });
  }
  if (status === 422) {
    return new ToolError({
      code: "VALIDATION_FAILED",
      message: base,
      details: { status, path: context.path },
    });
  }
  if (status === 400) {
    return new ToolError({
      code: "INVALID_INPUT",
      message: base,
      details: { status, path: context.path },
    });
  }
  if (status === 429) {
    return new ToolError({
      code: "RATE_LIMITED",
      message: base,
      details: { status, path: context.path },
    });
  }
  if (status >= 500) {
    return new ToolError({
      code: "PROVIDER_UNAVAILABLE",
      message: base,
      details: { status, path: context.path },
    });
  }
  return new ToolError({
    code: "UNKNOWN_PROVIDER_ERROR",
    message: base,
    details: { status, path: context.path },
  });
}

/** Normalize any SDK/axios/native failure into a `ToolError`. */
export function normalizeProviderError(
  error: unknown,
  fallbackMessage = "Higgsfield request failed.",
): ToolError {
  if (error instanceof ToolError) return error;

  if (error instanceof CredentialsMissedError || error instanceof AuthenticationError) {
    return new ToolError({
      code: "AUTHENTICATION_FAILED",
      message:
        "Higgsfield rejected the configured credentials. Check HF_CREDENTIALS (or HF_API_KEY + HF_API_SECRET); the key id must be the UUID from the dashboard.",
      details: { reason: messageOf(error, "authentication failed") },
      cause: error,
    });
  }

  if (error instanceof NotEnoughCreditsError) {
    return new ToolError({
      code: "INSUFFICIENT_CREDITS",
      message: "Higgsfield account does not have enough API credits.",
      cause: error,
    });
  }

  if (error instanceof ValidationError || error instanceof BadInputError) {
    const validationDetails = asErrorLike(error).details;
    const code = error instanceof ValidationError ? "VALIDATION_FAILED" : "INVALID_INPUT";
    return new ToolError({
      code,
      message: messageOf(error, fallbackMessage),
      details:
        validationDetails === undefined
          ? { status: statusOf(error) }
          : { cause: validationDetails },
      cause: error,
    });
  }

  const status = statusOf(error);
  const providerMessage = messageOf(error, fallbackMessage);

  if (status !== undefined)
    return toolErrorFromHttpStatus(status, { path: "provider", message: providerMessage });

  if (isTimeoutError(error)) {
    return new ToolError({
      code: "TIMEOUT",
      message: `Higgsfield request timed out: ${providerMessage}`,
      details: { code: errorCodeOf(error) },
      retryable: true,
      cause: error,
    });
  }

  const code = errorCodeOf(error);
  if (code !== undefined && NETWORK_ERROR_CODES[code] === true) {
    return new ToolError({
      code: "PROVIDER_UNAVAILABLE",
      message: `Higgsfield is unreachable: ${providerMessage}`,
      details: { code },
      retryable: true,
      cause: error,
    });
  }

  return new ToolError({
    code: "UNKNOWN_PROVIDER_ERROR",
    message: providerMessage,
    details: { code },
    cause: error,
  });
}
