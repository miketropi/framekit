import { Command, CommanderError } from "commander";
import { ToolError, toToolError } from "../domain/errors";
import { PACKAGE_VERSION } from "../version";
import { registerCharactersCommand } from "./commands/characters";
import { registerDoctorCommand } from "./commands/doctor";
import { registerGenerateCommand } from "./commands/generate";
import { registerImageCommand } from "./commands/image";
import { registerMotionsCommand, registerStylesCommand } from "./commands/discovery";
import { registerSpeakCommand } from "./commands/speak";
import { registerStatusCommand } from "./commands/status";
import { registerUploadCommand } from "./commands/upload";
import { registerVideoCommand } from "./commands/video";
import { EXIT_CODES, exitCodeForErrorCode } from "./exit-codes";
import { CliOutput } from "./output";
import { createRuntime, type CliRuntime, type ProcessLike, type RuntimeOverrides } from "./runtime";

/** Alias kept for callers: `runCli` accepts the same overrides as the runtime. */
export type RunOptions = RuntimeOverrides;

export function buildProgram(runtime: CliRuntime): Command {
  const program = new Command();
  program
    .name("hf")
    .description(
      "Generate Higgsfield image/video assets into local files and manifests for agents and Remotion.",
    )
    .version(PACKAGE_VERSION, "-V, --version", "print the package version")
    .configureHelp({ sortSubcommands: true })
    .exitOverride()
    .showSuggestionAfterError(true)
    .showHelpAfterError(false)
    .configureOutput({
      writeOut: (chunk: string) => {
        runtime.process.stdout.write(chunk);
      },
      writeErr: (chunk: string) => {
        runtime.process.stderr.write(chunk);
      },
    });

  registerDoctorCommand(program, runtime);
  registerImageCommand(program, runtime);
  registerVideoCommand(program, runtime);
  registerSpeakCommand(program, runtime);
  registerUploadCommand(program, runtime);
  registerGenerateCommand(program, runtime);
  registerStatusCommand(program, runtime);
  registerMotionsCommand(program, runtime);
  registerStylesCommand(program, runtime);
  registerCharactersCommand(program, runtime);

  return program;
}

/**
 * Entry point used by `bin/hf.ts`. Returns an exit code instead of calling
 * `process.exit`, so callers keep control over flushing and cleanup.
 */
export async function runCli(
  argv: string[],
  processLike: ProcessLike,
  overrides: RunOptions = {},
): Promise<number> {
  const jsonRequested = argv.includes("--json");
  let runtime: CliRuntime;

  try {
    runtime = createRuntime(argv, processLike, overrides);
  } catch (error) {
    // Configuration failed before a runtime existed: report it the same way.
    const env = overrides.env ?? processLike.env;
    const output = new CliOutput({
      stdout: processLike.stdout,
      stderr: processLike.stderr,
      json: jsonRequested,
      debug: env.HF_DEBUG === "1",
    });
    const toolError = toToolError(error);
    const exitCode = exitCodeForErrorCode(toolError.code);
    output.failure(toolError, exitCode);
    return exitCode;
  }

  const program = buildProgram(runtime);

  try {
    await program.parseAsync(argv, { from: "node" });
    if (program.args.length === 0) {
      program.outputHelp();
      return EXIT_CODES.INVALID_USAGE;
    }
    return runtime.exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.help" ||
        error.code === "commander.version"
      ) {
        return EXIT_CODES.SUCCESS;
      }
      // Invalid CLI usage is reported as exit code 2 (§27) with a typed payload.
      runtime.output.failure(
        new ToolError({ code: "VALIDATION_FAILED", message: error.message }),
        EXIT_CODES.INVALID_USAGE,
      );
      return EXIT_CODES.INVALID_USAGE;
    }

    const toolError = toToolError(error);
    const exitCode = exitCodeForErrorCode(toolError.code);
    runtime.output.failure(toolError, exitCode);
    return exitCode;
  }
}
