import type { Command } from "commander";
import type { DiscoveryResult } from "../../application/discovery";
import type { MotionPreset, StylePreset } from "../../domain/asset";
import { scrubUrlForStorage } from "../../domain/redact";
import { executeAction, requireToolkit, type CliRuntime } from "../runtime";
import type { CommandResult } from "../output";

interface DiscoveryCommandOptions {
  refresh: boolean;
  json?: boolean;
}

/** Provider preview links are informational: signed query parameters are dropped. */
export function scrubPreviewUrls<T extends MotionPreset | StylePreset>(items: T[]): T[] {
  return items.map((item) => ({
    ...item,
    ...(item.previewUrl === undefined ? {} : { previewUrl: scrubUrlForStorage(item.previewUrl) }),
  }));
}

function toResult<T extends MotionPreset | StylePreset>(
  label: "motions" | "styles",
  provider: string,
  result: DiscoveryResult<T>,
): CommandResult {
  const plural = result.items.length === 1 ? "entry" : "entries";
  return {
    envelope: {
      ok: true,
      operation: label,
      provider,
      status: "completed",
      details: {
        count: result.items.length,
        fetchedAt: result.fetchedAt,
        stale: result.stale,
        fromCache: result.fromCache,
        [label]: scrubPreviewUrls(result.items),
      },
    },
    human: [
      `${label}: ${result.items.length} ${plural}${result.stale ? " (stale cache)" : ""}`,
      ...result.items.map((item) => `  ${item.id}  ${item.name}`),
    ],
  };
}

export function registerMotionsCommand(program: Command, runtime: CliRuntime): void {
  program
    .command("motions")
    .description("List available motion presets (cached for 24 hours).")
    .option("--refresh", "force a provider refresh", false)
    .option("--json", "write one JSON document to stdout")
    .action(async (options: DiscoveryCommandOptions) => {
      await executeAction(runtime, async () => {
        const toolkit = await requireToolkit(runtime);
        const result = await toolkit.discovery.motions(options.refresh);
        if (result.stale)
          runtime.output.warn("provider refresh failed; serving stale cached motions");
        return toResult("motions", toolkit.config.provider, result);
      });
    });
}

export function registerStylesCommand(program: Command, runtime: CliRuntime): void {
  program
    .command("styles")
    .description("List available Soul styles (cached for 24 hours).")
    .option("--refresh", "force a provider refresh", false)
    .option("--json", "write one JSON document to stdout")
    .action(async (options: DiscoveryCommandOptions) => {
      await executeAction(runtime, async () => {
        const toolkit = await requireToolkit(runtime);
        const result = await toolkit.discovery.styles(options.refresh);
        if (result.stale)
          runtime.output.warn("provider refresh failed; serving stale cached styles");
        return toResult("styles", toolkit.config.provider, result);
      });
    });
}
