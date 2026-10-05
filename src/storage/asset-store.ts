import { createHash } from "node:crypto";
import { mkdir, open, rename } from "node:fs/promises";
import path from "node:path";
import { fileTypeFromBuffer } from "file-type";
import { kindFromMimeType } from "../application/fingerprint";
import { MAX_DOWNLOAD_BYTES } from "../config/defaults";
import type { AssetKind } from "../domain/generation";
import { ToolError } from "../domain/errors";
import { redactUrl } from "../domain/redact";
import { removeIfExists } from "./atomic-json";

/** Streaming download with limits, media verification, and atomic finalization. */

export interface DownloadTarget {
  url: string;
  /** Expected media kind; the downloaded content must agree. */
  kind: AssetKind;
  /** Absolute output directory. */
  directory: string;
  filename: string;
}

export interface DownloadResult {
  absolutePath: string;
  filename: string;
  mimeType: string;
  bytes: number;
  sha256: string;
}

export interface AssetStoreOptions {
  maxBytes?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DETECTION_SAMPLE_BYTES = 8_192;

const DEFAULT_EXTENSION_BY_KIND: Record<AssetKind, string> = {
  image: "png",
  video: "mp4",
  audio: "wav",
};

const ACCEPTED_EXTENSIONS_BY_KIND: Record<AssetKind, Record<string, string>> = {
  image: { png: "png", jpg: "jpg", jpeg: "jpg", webp: "webp" },
  video: { mp4: "mp4", webm: "webm", mov: "mov" },
  audio: { wav: "wav", mp3: "mp3" },
};

/**
 * Deterministic output naming (§3): `image-01.png`, `video.mp4`, `audio.wav`.
 * The extension is taken from the remote URL when it is a recognized media
 * extension for the expected kind, otherwise from the kind default. Names are
 * decided before the stream starts so a failure never leaves a half-named file.
 */
export function outputFilename(kind: AssetKind, index: number, remoteUrl: string): string {
  const accepted = ACCEPTED_EXTENSIONS_BY_KIND[kind];
  let extension = DEFAULT_EXTENSION_BY_KIND[kind];
  try {
    const match = /\.([a-zA-Z0-9]{1,5})$/.exec(new URL(remoteUrl).pathname);
    const candidate = match?.[1]?.toLowerCase();
    if (candidate !== undefined && accepted[candidate] !== undefined)
      extension = accepted[candidate];
  } catch {
    // Not a parseable URL: fall back to the kind default.
  }
  if (kind === "image") return `image-${String(index).padStart(2, "0")}.${extension}`;
  return `${kind}.${extension}`;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

export class AssetStore {
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AssetStoreOptions = {}) {
    this.maxBytes = options.maxBytes ?? MAX_DOWNLOAD_BYTES;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async download(target: DownloadTarget): Promise<DownloadResult> {
    const directory = target.directory;
    const finalPath = path.join(directory, target.filename);
    const partialPath = `${finalPath}.partial`;

    try {
      await mkdir(directory, { recursive: true });
    } catch (error) {
      throw new ToolError({
        code: "LOCAL_IO_ERROR",
        message: `Cannot create output directory ${directory}.`,
        details: { directory },
        cause: error,
      });
    }

    // Stall watchdog, not a total-time budget: the timer restarts on every received
    // chunk, so a slow but progressing transfer of a large result is allowed while a
    // stalled body still aborts instead of hanging the command forever.
    const controller = new AbortController();
    let watchdog = setTimeout(() => controller.abort(), this.timeoutMs);
    const keepAlive = (): void => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => controller.abort(), this.timeoutMs);
    };
    let response: Response;
    try {
      response = await this.fetchResponse(target.url, controller.signal);
    } catch (error) {
      clearTimeout(watchdog);
      throw error;
    }

    if (response.body === null) {
      clearTimeout(watchdog);
      throw new ToolError({
        code: "DOWNLOAD_FAILED",
        message: `Download of ${redactUrl(target.url)} returned no body.`,
        details: { url: redactUrl(target.url), retryable: true },
        retryable: true,
      });
    }

    const hash = createHash("sha256");
    const sampleChunks: Uint8Array[] = [];
    let sampleBytes = 0;
    let bytes = 0;

    let fileHandle;
    try {
      fileHandle = await open(partialPath, "w", 0o644);
    } catch (error) {
      throw new ToolError({
        code: "LOCAL_IO_ERROR",
        message: `Cannot write download target ${partialPath}.`,
        details: { path: partialPath },
        cause: error,
      });
    }

    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength;
        if (bytes > this.maxBytes) {
          throw new ToolError({
            code: "DOWNLOAD_FAILED",
            message: `Download exceeded the ${this.maxBytes} byte limit.`,
            details: { url: redactUrl(target.url), maxBytes: this.maxBytes },
            retryable: false,
          });
        }
        hash.update(chunk);
        if (sampleBytes < DETECTION_SAMPLE_BYTES) {
          sampleChunks.push(chunk);
          sampleBytes += chunk.byteLength;
        }
        await fileHandle.write(chunk);
        keepAlive();
      }
      await fileHandle.sync();
      await fileHandle.close();
    } catch (error) {
      await fileHandle.close().catch(() => undefined);
      await removeIfExists(partialPath);
      if (error instanceof ToolError) throw error;
      if (controller.signal.aborted) {
        throw new ToolError({
          code: "DOWNLOAD_FAILED",
          message: `Download of ${redactUrl(target.url)} timed out after ${this.timeoutMs}ms.`,
          details: { url: redactUrl(target.url), bytesReceived: bytes, timeoutMs: this.timeoutMs },
          retryable: true,
          cause: error,
        });
      }
      throw new ToolError({
        code: "DOWNLOAD_FAILED",
        message: `Download failed: ${error instanceof Error ? error.message : String(error)}`,
        details: { url: redactUrl(target.url), bytesReceived: bytes },
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(watchdog);
    }
    hash.update(Buffer.alloc(0));

    if (bytes === 0) {
      await removeIfExists(partialPath);
      throw new ToolError({
        code: "DOWNLOAD_FAILED",
        message: `Download of ${redactUrl(target.url)} produced an empty file.`,
        details: { url: redactUrl(target.url) },
        retryable: true,
      });
    }

    const sample = Buffer.concat(sampleChunks);
    const detected = await fileTypeFromBuffer(sample);
    const headerMimeType = response.headers.get("content-type")?.split(";")[0]?.trim();
    const mimeType = detected?.mime ?? headerMimeType ?? undefined;
    const detectedKind = kindFromMimeType(mimeType);

    if (detectedKind !== undefined && detectedKind !== target.kind) {
      await removeIfExists(partialPath);
      throw new ToolError({
        code: "DOWNLOAD_FAILED",
        message: `Expected ${target.kind} content but received ${mimeType} from ${redactUrl(target.url)}.`,
        details: { url: redactUrl(target.url), expectedKind: target.kind, detectedMime: mimeType },
        retryable: false,
      });
    }

    try {
      await rename(partialPath, finalPath);
    } catch (error) {
      await removeIfExists(partialPath);
      throw new ToolError({
        code: "LOCAL_IO_ERROR",
        message: `Cannot finalize downloaded file ${finalPath}.`,
        details: { path: finalPath },
        cause: error,
      });
    }

    return {
      absolutePath: finalPath,
      filename: target.filename,
      mimeType: mimeType ?? "application/octet-stream",
      bytes,
      sha256: hash.digest("hex"),
    };
  }

  private async fetchResponse(url: string, signal: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal, redirect: "follow" });
    } catch (error) {
      if (signal.aborted) {
        throw new ToolError({
          code: "DOWNLOAD_FAILED",
          message: `Download of ${redactUrl(url)} timed out after ${this.timeoutMs}ms.`,
          details: { url: redactUrl(url), timeoutMs: this.timeoutMs },
          retryable: true,
          cause: error,
        });
      }
      throw new ToolError({
        code: "DOWNLOAD_FAILED",
        message: `Cannot reach ${redactUrl(url)}: ${error instanceof Error ? error.message : String(error)}`,
        details: { url: redactUrl(url) },
        retryable: true,
        cause: error,
      });
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ToolError({
        code: "DOWNLOAD_FAILED",
        message: `Download of ${redactUrl(url)} failed with HTTP ${response.status}.`,
        details: { url: redactUrl(url), status: response.status },
        retryable: isRetryableStatus(response.status),
      });
    }
    return response;
  }
}
