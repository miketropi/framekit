import type { Command } from "commander";
import { executeAction, requireToolkit, type CliRuntime } from "../runtime";
import { generationEnvelope } from "../generation-envelope";

interface GenerateCommandOptions {
  endpoint: string;
  input: string;
  output: string;
  force: boolean;
  dryRun: boolean;
}

export function registerGenerateCommand(program: Command, runtime: CliRuntime): void {
  program
    .command("generate")
    .description("Escape hatch: run a supported V1 endpoint directly. Prefer the typed commands.")
    .requiredOption("--endpoint </v1/...>", "V1 endpoint path (must start with /v1/)")
    .requiredOption("--input <json-file>", "path to a JSON file holding the V1 parameter object")
    .requiredOption("--output <dir>", "output directory for media and generation.json")
    .option("--force", "regenerate even when a completed manifest matches", false)
    .option("--dry-run", "validate and fingerprint without uploading or generating", false)
    .option("--json", "write one JSON document to stdout")
    .action(async (options: GenerateCommandOptions) => {
      await executeAction(runtime, async () => {
        runtime.output.progress("preparing generic generation");
        const toolkit = await requireToolkit(runtime);
        const outcome = await toolkit.generate.runGeneric({
          endpoint: options.endpoint,
          input: options.input,
          output: options.output,
          force: options.force,
          dryRun: options.dryRun,
        });
        runtime.output.progress(`${outcome.operation} ${outcome.status}`);
        return { envelope: generationEnvelope(outcome) };
      });
    });
}
