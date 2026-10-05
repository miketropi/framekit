import type { Command } from "commander";
import { executeAction, requireToolkit, type CliRuntime } from "../runtime";
import { unitInterval } from "../parsers";
import { generationEnvelope } from "../generation-envelope";

interface VideoCommandOptions {
  input: string;
  prompt: string;
  preset: string;
  output: string;
  model?: string;
  motion?: string;
  motionStrength?: number;
  force: boolean;
  dryRun: boolean;
}

export function registerVideoCommand(program: Command, runtime: CliRuntime): void {
  program
    .command("video")
    .description("Animate a source image into video (logical model: dop-video).")
    .requiredOption("--input <path|url>", "source keyframe (local path or http(s) URL)")
    .requiredOption("--prompt <text>", "prompt describing subject motion and camera movement")
    .requiredOption("--preset <name>", "video preset: cinematic")
    .requiredOption("--output <dir>", "output directory for media and generation.json")
    .option("--model <logical-model>", "override the logical model implied by the preset")
    .option("--motion <name|id>", "motion preset name or exact id")
    .option(
      "--motion-strength <n>",
      "motion influence (0-1); requires --motion",
      unitInterval("--motion-strength"),
    )
    .option("--force", "regenerate even when a completed manifest matches", false)
    .option("--dry-run", "validate and fingerprint without uploading or generating", false)
    .option("--json", "write one JSON document to stdout")
    .action(async (options: VideoCommandOptions) => {
      await executeAction(runtime, async () => {
        runtime.output.progress("preparing image-to-video");
        const toolkit = await requireToolkit(runtime);
        const outcome = await toolkit.generate.runVideo({
          input: options.input,
          prompt: options.prompt,
          preset: options.preset,
          output: options.output,
          force: options.force,
          dryRun: options.dryRun,
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.motion === undefined ? {} : { motion: options.motion }),
          ...(options.motionStrength === undefined
            ? {}
            : { motionStrength: options.motionStrength }),
        });
        runtime.output.progress(`${outcome.operation} ${outcome.status}`);
        return { envelope: generationEnvelope(outcome) };
      });
    });
}
