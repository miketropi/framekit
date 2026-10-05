import type { Command } from "commander";
import { executeAction, requireToolkit, type CliRuntime } from "../runtime";
import { generationEnvelope } from "../generation-envelope";

interface SpeakCommandOptions {
  image: string;
  audio: string;
  prompt: string;
  preset: string;
  output: string;
  force: boolean;
  dryRun: boolean;
}

export function registerSpeakCommand(program: Command, runtime: CliRuntime): void {
  program
    .command("speak")
    .description(
      "Generate a speaking video from an image and a WAV track (logical model: speak-video).",
    )
    .requiredOption("--image <path|url>", "portrait image (local path or http(s) URL)")
    .requiredOption("--audio <path|url>", "WAV audio track (local path or http(s) URL)")
    .requiredOption("--prompt <text>", "prompt describing the delivery")
    .requiredOption("--preset <name>", "speech preset: standard")
    .requiredOption("--output <dir>", "output directory for media and generation.json")
    .option("--force", "regenerate even when a completed manifest matches", false)
    .option("--dry-run", "validate and fingerprint without uploading or generating", false)
    .option("--json", "write one JSON document to stdout")
    .action(async (options: SpeakCommandOptions) => {
      await executeAction(runtime, async () => {
        runtime.output.progress("preparing speech-to-video");
        const toolkit = await requireToolkit(runtime);
        const outcome = await toolkit.generate.runSpeech({
          image: options.image,
          audio: options.audio,
          prompt: options.prompt,
          preset: options.preset,
          output: options.output,
          force: options.force,
          dryRun: options.dryRun,
        });
        runtime.output.progress(`${outcome.operation} ${outcome.status}`);
        return { envelope: generationEnvelope(outcome) };
      });
    });
}
