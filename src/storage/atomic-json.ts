import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { ToolError } from "../domain/errors";
import { toToolError } from "../domain/errors";

/**
 * Atomic file IO: write to `<file>.<pid>.<random>.tmp`, fsync, then rename.
 * A reader therefore never observes a partially written cache or manifest.
 */

export function temporarySiblingPath(filePath: string): string {
  return `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Directory fsync is not supported on every platform; the rename is still atomic.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writeFileAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = temporarySiblingPath(filePath);

  let fileHandle;
  try {
    fileHandle = await open(temporaryPath, "wx", 0o644);
  } catch (error) {
    throw new ToolError({
      code: "LOCAL_IO_ERROR",
      message: `Cannot create temporary file next to ${filePath}.`,
      details: { filePath },
      cause: error,
    });
  }

  try {
    await fileHandle.writeFile(data);
    await fileHandle.sync();
    await fileHandle.close();
  } catch (error) {
    await fileHandle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw toToolError(error);
  }

  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw new ToolError({
      code: "LOCAL_IO_ERROR",
      message: `Cannot finalize ${filePath}.`,
      details: { filePath },
      cause: error,
    });
  }
  await syncDirectory(directory);
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Read and parse JSON, returning `undefined` when the file is missing or
 * unparsable. Corrupt cache/manifest content is recoverable by design.
 */
export async function readJsonIfValid(filePath: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new ToolError({
      code: "LOCAL_IO_ERROR",
      message: `Cannot read ${filePath}.`,
      details: { filePath, code },
      cause: error,
    });
  }
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function removeIfExists(filePath: string): Promise<void> {
  await unlink(filePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw toToolError(error);
  });
}
