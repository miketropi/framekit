import { randomBytes } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ToolError } from "../domain/errors";

export interface WritabilityProbe {
  directory: string;
  writable: boolean;
  error?: string;
}

/**
 * Create/write/remove probe. Used by `hf doctor` and before every paid
 * submission, so a command never spends credits on output it cannot persist.
 */
export async function probeWritableDirectory(directory: string): Promise<WritabilityProbe> {
  const probePath = path.join(
    directory,
    `.hf-write-probe-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(probePath, "ok", { flag: "wx" });
  } catch (error) {
    return {
      directory,
      writable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await unlink(probePath).catch(() => undefined);
  }
  return { directory, writable: true };
}

/** Throws unless the directory can be created and written to. */
export async function assertWritableDirectory(directory: string): Promise<void> {
  const probe = await probeWritableDirectory(directory);
  if (!probe.writable) {
    throw new ToolError({
      code: "LOCAL_IO_ERROR",
      message: probe.error ?? `Output directory is not writable: ${directory}`,
      details: { directory },
    });
  }
}
