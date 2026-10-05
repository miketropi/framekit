import { existsSync } from "node:fs";
import path from "node:path";
import { ToolError } from "../domain/errors";

/**
 * `.env` loading for the CLI.
 *
 * Credentials come from the environment (§20); a local `.env` file is simply the
 * conventional way to populate it. Node's own parser is used (`process.loadEnvFile`,
 * Node >= 20.12), and values already present in the process environment always win,
 * so an exported variable is never silently replaced by a file value.
 *
 * Nothing here reads credential values: the caller only learns how many variables
 * were added and from which path.
 */

export const ENV_FILE_VARIABLE = "HF_ENV_FILE";
export const DEFAULT_ENV_FILE = ".env";

export interface EnvFileResult {
  loaded: boolean;
  path: string;
  variables: number;
}

export interface EnvFileOptions {
  cwd: string;
  /** The environment object configuration will be read from (normally process.env). */
  env: Record<string, string | undefined>;
  /** Explicit path from `HF_ENV_FILE`; when set, a missing file is an error. */
  explicitPath?: string;
}

function parseEnvFileInto(env: Record<string, string | undefined>, filePath: string): number {
  if (typeof process.loadEnvFile !== "function") {
    throw new ToolError({
      code: "VALIDATION_FAILED",
      message:
        "This Node runtime cannot load .env files (requires Node >= 20.12). Export the variables in your shell, or upgrade Node.",
      details: { node: process.versions.node, filePath },
    });
  }

  // Snapshot both the process environment and the effective environment: a variable
  // that is already set must win, and only genuinely added keys are reported.
  const processBefore = new Map(Object.entries(process.env));
  const effectiveBefore = new Map(Object.entries(env));

  try {
    process.loadEnvFile(filePath);
  } catch (error) {
    throw new ToolError({
      code: "LOCAL_IO_ERROR",
      message: `Cannot load environment file ${filePath}.`,
      details: { filePath },
      cause: error,
    });
  }

  let variables = 0;
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (processBefore.get(key) === value) continue;
    if (effectiveBefore.get(key) !== undefined) continue;
    env[key] = value;
    variables += 1;
  }

  // Explicit environment beats file contents (Node already behaves this way; this
  // keeps the precedence guaranteed rather than merely observed).
  for (const [key, value] of effectiveBefore) {
    if (value !== undefined) env[key] = value;
  }

  return variables;
}

/**
 * Load `.env` (or `HF_ENV_FILE`) into the given environment.
 * A missing default file is normal and silently skipped.
 */
export function loadEnvFileInto(options: EnvFileOptions): EnvFileResult {
  const explicit = options.explicitPath?.trim();
  const filePath = path.resolve(
    options.cwd,
    explicit === undefined || explicit === "" ? DEFAULT_ENV_FILE : explicit,
  );

  if (!existsSync(filePath)) {
    if (explicit === undefined || explicit === "")
      return { loaded: false, path: filePath, variables: 0 };
    throw new ToolError({
      code: "VALIDATION_FAILED",
      message: `${ENV_FILE_VARIABLE} points at a file that does not exist: ${filePath}`,
      details: { [ENV_FILE_VARIABLE]: explicit, filePath },
    });
  }

  return { loaded: true, path: filePath, variables: parseEnvFileInto(options.env, filePath) };
}
