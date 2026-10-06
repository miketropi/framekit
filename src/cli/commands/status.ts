import type { Command } from "commander";
import { scrubUrlForStorage } from "../../domain/redact";
import { executeAction, requireToolkit, type CliRuntime } from "../runtime";

interface StatusCommandOptions {
  json?: boolean;
}

export function registerStatusCommand(program: Command, runtime: CliRuntime): void {
  program
    .command("status")
    .description("Inspect the remote status of a generation request id.")
    .argument("<request-id>", "request id returned by a generation command")
    .option("--json", "write one JSON document to stdout")
    .action(async (requestId: string, _options: StatusCommandOptions) => {
      await executeAction(runtime, async () => {
        const toolkit = await requireToolkit(runtime);
        const report = await toolkit.status.inspect(requestId);
        const resultUrls = report.assets.map((asset) => ({
          type: asset.kind,
          // Result links are signed and time-limited: the signature is not echoed.
          url: scrubUrlForStorage(asset.url),
        }));
        return {
          envelope: {
            ok: true,
            operation: "status",
            provider: toolkit.config.provider,
            status: report.status,
            requestId: report.requestId,
            details: {
              ...(report.source === undefined ? {} : { source: report.source }),
              ...(resultUrls.length === 0 ? {} : { resultUrls }),
            },
          },
          human: [
            `status: ${report.status}`,
            `  requestId: ${report.requestId}`,
            ...(report.source === undefined ? [] : [`  source: ${report.source}`]),
            ...resultUrls.map((entry) => `  ${entry.type}: ${entry.url}`),
          ],
        };
      });
    });
}
