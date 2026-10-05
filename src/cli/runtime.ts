import { loadConfig, type ConfigOverrides, type ToolConfig } from "../config/env";
import { ENV_FILE_VARIABLE, loadEnvFileInto } from "./env-file";
import type { Clock, RandomSource, Sleeper } from "../domain/runtime";
import { toToolError } from "../domain/errors";
import { createToolkitProvider, type Toolkit, type ToolkitProvider } from "../application/toolkit";
import { exitCodeForErrorCode } from "./exit-codes";
import { CliOutput, type CommandResult, type WritableLike } from "./output";

/** The CLI depends on the process only through this narrow surface (test seam). */
export interface ProcessLike {
  argv: string[];
  cwd(): string;
  env: Record<string, string | undefined>;
  stdout: WritableLike;
  stderr: WritableLike;
  exitCode?: number | string | null | undefined;
}

export interface CliRuntime {
  process: ProcessLike;
  cwd: string;
  env: Record<string, string | undefined>;
  config: ToolConfig;
  toolkit: ToolkitProvider;
  output: CliOutput;
  json: boolean;
  exitCode: number;
}

export interface RuntimeOverrides {
  env?: Record<string, string | undefined>;
  cwd?: string;
  config?: ConfigOverrides;
  toolkit?: ToolkitProvider;
  clock?: Clock;
  sleeper?: Sleeper;
  random?: RandomSource;
  fetchImpl?: typeof fetch;
}

export const SUCCESS_EXIT_CODE = 0;

export function createRuntime(
  argv: string[],
  processLike: ProcessLike,
  overrides: RuntimeOverrides = {},
): CliRuntime {
  const env = overrides.env ?? processLike.env;
  const cwd = overrides.cwd ?? processLike.cwd();
  const jsonRequested = argv.includes("--json");

  // A local `.env` is the conventional way to populate the environment; an injected
  // environment (embedders, tests) is used verbatim and never reads files.
  if (overrides.env === undefined) {
    const envFile = loadEnvFileInto({
      cwd,
      env,
      ...(env[ENV_FILE_VARIABLE] === undefined ? {} : { explicitPath: env[ENV_FILE_VARIABLE] }),
    });
    if (envFile.loaded && envFile.variables > 0) {
      processLike.stderr.write(
        `[info] loaded ${envFile.variables} variable${envFile.variables === 1 ? "" : "s"} from ${envFile.path}\n`,
      );
    }
  }
  const config = loadConfig({
    env,
    ...(overrides.config === undefined ? {} : { overrides: overrides.config }),
  });
  const json = jsonRequested;
  const output = new CliOutput({
    stdout: processLike.stdout,
    stderr: processLike.stderr,
    json,
    debug: config.debug,
  });
  const toolkit =
    overrides.toolkit ??
    createToolkitProvider(config, {
      cwd,
      env,
      ...(overrides.clock === undefined ? {} : { clock: overrides.clock }),
      ...(overrides.sleeper === undefined ? {} : { sleeper: overrides.sleeper }),
      ...(overrides.random === undefined ? {} : { random: overrides.random }),
      ...(overrides.fetchImpl === undefined ? {} : { fetchImpl: overrides.fetchImpl }),
    });

  return {
    process: processLike,
    cwd,
    env,
    config,
    toolkit,
    output,
    json,
    exitCode: SUCCESS_EXIT_CODE,
  };
}

/** Runs one command body, serializing success or failure exactly once. */
export async function executeAction(
  runtime: CliRuntime,
  handler: () => Promise<CommandResult>,
): Promise<void> {
  try {
    const result = await handler();
    runtime.output.result(result);
    runtime.exitCode = SUCCESS_EXIT_CODE;
  } catch (error) {
    const toolError = toToolError(error);
    runtime.exitCode = exitCodeForErrorCode(toolError.code);
    runtime.output.failure(toolError, runtime.exitCode);
  }
}

export async function requireToolkit(runtime: CliRuntime): Promise<Toolkit> {
  return runtime.toolkit.get();
}
