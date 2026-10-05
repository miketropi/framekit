import { redactString, redactValue } from "./redact";

/**
 * Canonical error taxonomy. Every failure surfaced by the tool uses exactly one
 * of these codes, regardless of which layer produced it.
 */
export const TOOL_ERROR_CODES = [
  "AUTHENTICATION_FAILED",
  "INSUFFICIENT_CREDITS",
  "INVALID_INPUT",
  "VALIDATION_FAILED",
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "GENERATION_FAILED",
  "MODERATION_REJECTED",
  "CANCELED",
  "TIMEOUT",
  "UPLOAD_FAILED",
  "DOWNLOAD_FAILED",
  "LOCAL_IO_ERROR",
  "UNKNOWN_PROVIDER_ERROR",
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

/**
 * Retry is only safe for failures that provably did not commit a paid request.
 * Generation, moderation, cancellation, auth, credits, and validation are never
 * retried automatically.
 */
const DEFAULT_RETRYABLE: Record<ToolErrorCode, boolean> = {
  AUTHENTICATION_FAILED: false,
  INSUFFICIENT_CREDITS: false,
  INVALID_INPUT: false,
  VALIDATION_FAILED: false,
  RATE_LIMITED: true,
  PROVIDER_UNAVAILABLE: true,
  GENERATION_FAILED: false,
  MODERATION_REJECTED: false,
  CANCELED: false,
  TIMEOUT: true,
  UPLOAD_FAILED: false,
  DOWNLOAD_FAILED: false,
  LOCAL_IO_ERROR: false,
  UNKNOWN_PROVIDER_ERROR: false,
};

export interface ToolErrorInit {
  code: ToolErrorCode;
  message: string;
  /** Overrides the per-code default when the call site knows better. */
  retryable?: boolean;
  requestId?: string;
  details?: unknown;
  cause?: unknown;
}

export interface SerializedToolError {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  requestId?: string;
  details?: unknown;
}

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
  readonly requestId: string | undefined;
  readonly details: unknown;
  override readonly cause: unknown;

  constructor(init: ToolErrorInit) {
    // Messages are redacted at construction so a credential or signed URL can
    // never reach a log line, a JSON envelope, or a stack trace.
    super(redactString(init.message));
    this.name = "ToolError";
    this.code = init.code;
    this.retryable = init.retryable ?? DEFAULT_RETRYABLE[init.code];
    this.requestId = init.requestId;
    this.details = init.details;
    this.cause = init.cause;
  }

  /** Serialized form: sanitized, JSON-safe, and free of causes/stack traces. */
  toJSON(): SerializedToolError {
    const payload: SerializedToolError = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.requestId !== undefined) payload.requestId = this.requestId;
    if (this.details !== undefined) payload.details = redactValue(this.details);
    return payload;
  }
}

export function isToolError(value: unknown): value is ToolError {
  return value instanceof ToolError;
}

interface StructuralToolError {
  code: string;
  message: string;
  retryable?: unknown;
  requestId?: unknown;
  details?: unknown;
}

function asStructuralToolError(value: unknown): StructuralToolError | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as StructuralToolError;
  if (typeof candidate.code !== "string" || !isToolErrorCode(candidate.code)) return undefined;
  if (typeof candidate.message !== "string") return undefined;
  return candidate;
}

export function isToolErrorCode(value: unknown): value is ToolErrorCode {
  return typeof value === "string" && (TOOL_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Wrap anything unrecognized as an unexpected provider-level failure.
 *
 * Errors that are structurally valid (a known `code` plus a string `message`) but
 * come from another module instance — a separately bundled provider, a worker, or
 * a serialized payload — are adopted rather than downgraded, so an external
 * `MediaProvider` implementation keeps its taxonomy.
 */
export function toToolError(value: unknown): ToolError {
  if (isToolError(value)) return value;

  const structural = asStructuralToolError(value);
  if (structural !== undefined) {
    return new ToolError({
      code: structural.code as ToolErrorCode,
      message: structural.message,
      ...(typeof structural.retryable === "boolean" ? { retryable: structural.retryable } : {}),
      ...(typeof structural.requestId === "string" ? { requestId: structural.requestId } : {}),
      ...(structural.details === undefined ? {} : { details: structural.details }),
      cause: value,
    });
  }

  if (value instanceof Error) {
    const wrapped = new ToolError({
      code: "UNKNOWN_PROVIDER_ERROR",
      message: value.message || value.name,
      cause: value,
    });
    // Stacks start with the raw message: keep a redacted copy only.
    wrapped.stack = redactString(value.stack ?? "");
    return wrapped;
  }
  return new ToolError({
    code: "UNKNOWN_PROVIDER_ERROR",
    message: "Unexpected non-error failure.",
    details: { value: String(value) },
  });
}

export function defaultRetryable(code: ToolErrorCode): boolean {
  return DEFAULT_RETRYABLE[code];
}

/**
 * Adopt an error into the taxonomy, guaranteeing a `requestId` when one is known.
 *
 * After a paid submission the job id is the only handle on the remote work, so
 * every failure raised while that job is in flight must carry it.
 */
export function withRequestId(value: unknown, requestId: string): ToolError {
  const normalized = toToolError(value);
  if (normalized.requestId !== undefined) return normalized;
  return new ToolError({
    code: normalized.code,
    message: normalized.message,
    details: normalized.details,
    retryable: normalized.retryable,
    requestId,
    cause: value,
  });
}

/**
 * True when the failed operation may be retried without risk of double spend.
 *
 * `retryable` already encodes "transient and not committed" by construction; the
 * call sites that pass this predicate are exactly the read-only or idempotent ones
 * (status, discovery, uploads, downloads). Paid generation is never retried at all.
 */
export function isSafeToRetry(value: unknown): boolean {
  return value instanceof ToolError && value.retryable;
}
