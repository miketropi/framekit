import { readFile, stat } from "node:fs/promises";
import { fileTypeFromBuffer } from "file-type";
import { sha256Hex } from "../application/fingerprint";
import {
  ACCEPTED_AUDIO_TYPES,
  ACCEPTED_IMAGE_TYPES,
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
} from "../config/defaults";
import { ToolError } from "../domain/errors";
import { assertNotUnsupportedScheme, isHttpUrl, resolveUserPath, toDisplayPath } from "./paths";

export type InputKind = "image" | "audio";

export type InputReference = { type: "url"; url: string } | { type: "file"; path: string };

export interface InspectedLocalInput {
  kind: InputKind;
  absolutePath: string;
  displayPath: string;
  sha256: string;
  bytes: number;
  contentType: string;
  format: string;
  data: Buffer;
}

export interface InputInspectorOptions {
  cwd: string;
  maxImageBytes?: number;
  maxAudioBytes?: number;
}

const ACCEPTED_TYPES_BY_KIND: Record<InputKind, Record<string, string>> = {
  image: ACCEPTED_IMAGE_TYPES,
  audio: ACCEPTED_AUDIO_TYPES,
};

const KIND_LABEL: Record<InputKind, string> = {
  image: "Image",
  audio: "Audio",
};

const KIND_HINT: Record<InputKind, string> = {
  image: "PNG, JPEG, or WebP",
  audio: "WAV",
};

const KIND_BY_ACCEPTED_MIME: Record<string, InputKind> = {
  ...Object.fromEntries(
    Object.keys(ACCEPTED_IMAGE_TYPES).map((mime) => [mime, "image" as InputKind]),
  ),
  ...Object.fromEntries(
    Object.keys(ACCEPTED_AUDIO_TYPES).map((mime) => [mime, "audio" as InputKind]),
  ),
};

const ALL_ACCEPTED_MIME_TYPES = [
  ...Object.keys(ACCEPTED_IMAGE_TYPES),
  ...Object.keys(ACCEPTED_AUDIO_TYPES),
];

/** Classify a user-supplied input reference. Non-HTTP URL schemes are rejected. */
export function parseInputReference(value: string): InputReference {
  assertNotUnsupportedScheme(value);
  return isHttpUrl(value) ? { type: "url", url: value } : { type: "file", path: value };
}

/**
 * Validates local inputs by content, never by extension (§3/§11): magic-byte
 * detection decides the media type, and size limits are enforced before upload.
 */
export class InputInspector {
  private readonly cwd: string;
  private readonly maxBytesByKind: Record<InputKind, number>;
  private readonly maximumBytes: number;

  constructor(options: InputInspectorOptions) {
    this.cwd = options.cwd;
    this.maxBytesByKind = {
      image: options.maxImageBytes ?? MAX_IMAGE_BYTES,
      audio: options.maxAudioBytes ?? MAX_AUDIO_BYTES,
    };
    this.maximumBytes = Math.max(this.maxBytesByKind.image, this.maxBytesByKind.audio);
  }

  async inspectLocal(reference: string, kind: InputKind): Promise<InspectedLocalInput> {
    return this.inspect(reference, kind);
  }

  /** Detects the media kind from content; used by `hf upload` for mixed inputs. */
  async inspectUnknown(reference: string): Promise<InspectedLocalInput> {
    return this.inspect(reference, undefined);
  }

  private async inspect(
    reference: string,
    expectedKind: InputKind | undefined,
  ): Promise<InspectedLocalInput> {
    const parsed = parseInputReference(reference);
    if (parsed.type === "url") {
      throw new ToolError({
        code: "INVALID_INPUT",
        message: `Expected a local ${expectedKind ?? "media"} file but received a URL: ${parsed.url}`,
        details: { reference },
      });
    }

    const absolutePath = resolveUserPath(this.cwd, parsed.path);
    const displayPath = toDisplayPath(this.cwd, absolutePath);
    const label = expectedKind === undefined ? "Media" : KIND_LABEL[expectedKind];

    let stats;
    try {
      stats = await stat(absolutePath);
    } catch (error) {
      throw new ToolError({
        code: "INVALID_INPUT",
        message: `Input ${label.toLowerCase()} file not found: ${displayPath}`,
        details: { path: displayPath, code: (error as NodeJS.ErrnoException).code },
        cause: error,
      });
    }
    if (!stats.isFile()) {
      throw new ToolError({
        code: "INVALID_INPUT",
        message: `Input path is not a regular file: ${displayPath}`,
        details: { path: displayPath },
      });
    }
    if (stats.size === 0) {
      throw new ToolError({
        code: "INVALID_INPUT",
        message: `Input ${label.toLowerCase()} file is empty: ${displayPath}`,
        details: { path: displayPath, bytes: 0 },
      });
    }
    // Pre-read guard against the largest supported limit; the exact per-kind limit
    // is enforced once the media kind is known, so an oversized image can never be
    // accepted under the audio allowance.
    if (stats.size > this.maximumBytes) {
      throw new ToolError({
        code: "INVALID_INPUT",
        message: `Input file is ${stats.size} bytes, exceeding the ${this.maximumBytes} byte limit: ${displayPath}`,
        details: { path: displayPath, bytes: stats.size, maxBytes: this.maximumBytes },
      });
    }

    const data = await readFile(absolutePath);
    const detected = await fileTypeFromBuffer(data);
    const acceptedMimeTypes =
      expectedKind === undefined
        ? ALL_ACCEPTED_MIME_TYPES
        : Object.keys(ACCEPTED_TYPES_BY_KIND[expectedKind]);

    const unsupported: (detectedMime: string | undefined) => never = (detectedMime) => {
      throw new ToolError({
        code: "INVALID_INPUT",
        message: `Unsupported ${expectedKind ?? "media"} content${detectedMime ? ` (${detectedMime})` : ""} in ${displayPath}. Accepted: ${
          expectedKind === undefined ? ALL_ACCEPTED_MIME_TYPES.join(", ") : KIND_HINT[expectedKind]
        }.`,
        details: { path: displayPath, detectedMime, acceptedMimeTypes },
      });
    };

    if (detected === undefined) unsupported(undefined);

    const kind = expectedKind ?? KIND_BY_ACCEPTED_MIME[detected.mime];
    const accepted = kind === undefined ? undefined : ACCEPTED_TYPES_BY_KIND[kind];
    const format = accepted === undefined ? undefined : accepted[detected.mime];
    if (kind === undefined || format === undefined) unsupported(detected.mime);

    const maxBytes = this.maxBytesByKind[kind];
    if (stats.size > maxBytes) {
      throw new ToolError({
        code: "INVALID_INPUT",
        message: `Input ${kind} is ${stats.size} bytes, exceeding the ${maxBytes} byte limit: ${displayPath}`,
        details: { path: displayPath, bytes: stats.size, maxBytes, kind },
      });
    }

    return {
      kind,
      absolutePath,
      displayPath,
      sha256: sha256Hex(data),
      bytes: data.byteLength,
      contentType: detected.mime,
      format,
      data,
    };
  }

  async inspectImage(reference: string): Promise<InspectedLocalInput> {
    return this.inspectLocal(reference, "image");
  }

  async inspectAudio(reference: string): Promise<InspectedLocalInput> {
    return this.inspectLocal(reference, "audio");
  }
}
