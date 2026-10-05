import type { Command } from "commander";
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
        return {
          envelope: {
            ok: true,
            operation: "status",
            provider: toolkit.config.provider,
            status: report.status,
            requestId: report.requestId,
          },
          human: [`status: ${report.status}`, `  requestId: ${report.requestId}`],
        };
      });
    });
}
