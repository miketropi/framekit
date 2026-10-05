import type { Command } from "commander";
import { executeAction, requireToolkit, type CliRuntime } from "../runtime";
import { toDisplayPath } from "../../storage/paths";

interface UploadCommandOptions {
  json?: boolean;
}

export function registerUploadCommand(program: Command, runtime: CliRuntime): void {
  program
    .command("upload")
    .description("Upload a local image or WAV file and return its remote URL.")
    .argument("<path>", "local media file")
    .option("--json", "write one JSON document to stdout")
    .action(async (filePath: string, _options: UploadCommandOptions) => {
      await executeAction(runtime, async () => {
        runtime.output.progress(`uploading ${filePath}`);
        const toolkit = await requireToolkit(runtime);
        const inspected = await toolkit.inspector.inspectUnknown(filePath);
        const uploaded = await toolkit.uploads.uploadLocal(inspected);
        return {
          envelope: {
            ok: true,
            operation: "upload",
            provider: toolkit.config.provider,
            status: "completed",
            details: {
              url: uploaded.url,
              sha256: uploaded.sha256,
              bytes: uploaded.bytes,
              contentType: uploaded.contentType,
              localPath: toDisplayPath(runtime.cwd, inspected.absolutePath),
            },
          },
          human: [
            "upload: completed",
            `  url: ${uploaded.url}`,
            `  sha256: ${uploaded.sha256}`,
            `  bytes: ${uploaded.bytes}`,
          ],
        };
      });
    });
}
