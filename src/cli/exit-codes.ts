import { TOOL_ERROR_CODES, type ToolErrorCode } from "../domain/errors";

/**
 * Process exit codes (§27). Agents should prefer `error.code` in JSON output;
 * these codes exist for shell-level branching.
 */
export const EXIT_CODES = {
  SUCCESS: 0,
  INVALID_USAGE: 2,
  AUTHENTICATION: 10,
  INSUFFICIENT_CREDITS: 11,
  VALIDATION: 12,
  PROVIDER: 20,
  RATE_LIMITED: 21,
  TIMEOUT: 22,
  GENERATION_FAILED: 30,
  MODERATION_REJECTED: 31,
  UPLOAD_DOWNLOAD: 40,
  LOCAL_IO: 50,
  UNEXPECTED: 70,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** Exhaustive: adding a ToolErrorCode without mapping it here fails typecheck. */
export const EXIT_CODE_BY_ERROR: Record<ToolErrorCode, ExitCode> = {
  AUTHENTICATION_FAILED: EXIT_CODES.AUTHENTICATION,
  INSUFFICIENT_CREDITS: EXIT_CODES.INSUFFICIENT_CREDITS,
  INVALID_INPUT: EXIT_CODES.VALIDATION,
  VALIDATION_FAILED: EXIT_CODES.VALIDATION,
  PROVIDER_UNAVAILABLE: EXIT_CODES.PROVIDER,
  RATE_LIMITED: EXIT_CODES.RATE_LIMITED,
  TIMEOUT: EXIT_CODES.TIMEOUT,
  GENERATION_FAILED: EXIT_CODES.GENERATION_FAILED,
  MODERATION_REJECTED: EXIT_CODES.MODERATION_REJECTED,
  CANCELED: EXIT_CODES.GENERATION_FAILED,
  UPLOAD_FAILED: EXIT_CODES.UPLOAD_DOWNLOAD,
  DOWNLOAD_FAILED: EXIT_CODES.UPLOAD_DOWNLOAD,
  LOCAL_IO_ERROR: EXIT_CODES.LOCAL_IO,
  UNKNOWN_PROVIDER_ERROR: EXIT_CODES.PROVIDER,
};

/** Compile-time guard: every declared code has an exit code. */
const _exhaustive: readonly ToolErrorCode[] = TOOL_ERROR_CODES;
void _exhaustive;

export function exitCodeForErrorCode(code: ToolErrorCode): ExitCode {
  return EXIT_CODE_BY_ERROR[code];
}
