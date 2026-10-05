import type { Command } from "commander";
import { runDoctor, type DoctorReport } from "../../application/doctor";
import { executeAction, requireToolkit, type CliRuntime } from "../runtime";

interface DoctorCommandOptions {
  output?: string;
  json?: boolean;
}

function humanLines(report: DoctorReport): string[] {
  return [
    `doctor: ${report.checks.every((check) => check.ok) ? "ok" : "failed"}`,
    `  package: ${report.packageName}@${report.packageVersion}`,
    `  node: ${report.nodeVersion} (minimum ${report.minimumNodeMajor})`,
    `  provider: ${report.provider} (supported: ${report.providerSupported})`,
    `  credentials: apiKey=${report.credentials.apiKey} apiSecret=${report.credentials.apiSecret}`,
    `  output: ${report.outputDirectory.path} (writable: ${report.outputDirectory.writable})`,
    ...(report.discovery === undefined
      ? []
      : [
          `  discovery: ${report.discovery.ok ? `${report.discovery.motions} motions` : "unreachable"}`,
        ]),
  ];
}

export function registerDoctorCommand(program: Command, runtime: CliRuntime): void {
  program
    .command("doctor")
    .description("Check runtime, credentials, provider support, and output writability.")
    .option("--output <dir>", "directory to probe for writability (defaults to the cwd)")
    .option("--json", "write one JSON document to stdout")
    .action(async (options: DoctorCommandOptions) => {
      await executeAction(runtime, async () => {
        const report = await runDoctor({
          config: runtime.config,
          cwd: runtime.cwd,
          ...(options.output === undefined ? {} : { output: options.output }),
          getProvider: async () => (await requireToolkit(runtime)).provider,
        });
        return {
          envelope: {
            ok: true,
            operation: "doctor",
            provider: report.provider,
            status: "completed",
            details: report,
          },
          human: humanLines(report),
        };
      });
    });
}
