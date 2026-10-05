import type { Command } from "commander";
import { executeAction, requireToolkit, type CliRuntime } from "../runtime";
import { imageBatch, seedValue, unitInterval } from "../parsers";
import { generationEnvelope } from "../generation-envelope";

interface ImageCommandOptions {
  prompt: string;
  preset: string;
  output: string;
  style?: string;
  seed?: number;
  batch?: 1 | 4;
  reference?: string;
  referenceStrength?: number;
  character?: string;
  force: boolean;
  dryRun: boolean;
}

export function registerImageCommand(program: Command, runtime: CliRuntime): void {
  program
    .command("image")
    .description("Generate an image from a text prompt (logical model: soul-image).")
    .requiredOption("--prompt <text>", "prompt describing the image")
    .requiredOption("--preset <name>", "image preset: square-hd, portrait-hd, landscape-hd")
    .requiredOption("--output <dir>", "output directory for media and generation.json")
    .option("--style <name|id>", "Soul style name or exact id")
    .option("--seed <n>", "reproducible seed (0-1000000)", seedValue)
    .option("--batch <1|4>", "images per request; overrides the preset", imageBatch)
    .option("--reference <path|url>", "reference image (local path or http(s) URL)")
    .option(
      "--reference-strength <n>",
      "influence of the reference image (0-1)",
      unitInterval("--reference-strength"),
    )
    .option("--character <id>", "custom reference (character) id")
    .option("--force", "regenerate even when a completed manifest matches", false)
    .option("--dry-run", "validate and fingerprint without uploading or generating", false)
    .option("--json", "write one JSON document to stdout")
    .action(async (options: ImageCommandOptions) => {
      await executeAction(runtime, async () => {
        runtime.output.progress("preparing text-to-image");
        const toolkit = await requireToolkit(runtime);
        const outcome = await toolkit.generate.runImage({
          prompt: options.prompt,
          preset: options.preset,
          output: options.output,
          force: options.force,
          dryRun: options.dryRun,
          ...(options.style === undefined ? {} : { style: options.style }),
          ...(options.seed === undefined ? {} : { seed: options.seed }),
          ...(options.batch === undefined ? {} : { batch: options.batch }),
          ...(options.reference === undefined ? {} : { reference: options.reference }),
          ...(options.referenceStrength === undefined
            ? {}
            : { referenceStrength: options.referenceStrength }),
          ...(options.character === undefined ? {} : { character: options.character }),
        });
        runtime.output.progress(`${outcome.operation} ${outcome.status}`);
        return { envelope: generationEnvelope(outcome) };
      });
    });
}
