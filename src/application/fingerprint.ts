import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { ToolError } from "../domain/errors";
import type { AssetKind, Capability } from "../domain/generation";

/**
 * Canonical JSON: object keys sorted, array order preserved, non-JSON values
 * rejected. Two structurally equal requests always hash identically,
 * independent of key insertion order.
 */
export function canonicalJson(value: unknown, path = "$"): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new ToolError({
          code: "VALIDATION_FAILED",
          message: `Cannot canonicalize non-finite number at ${path}.`,
        });
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "undefined":
      throw new ToolError({
        code: "VALIDATION_FAILED",
        message: `Cannot canonicalize undefined at ${path}.`,
      });
    default:
      break;
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry, index) => canonicalJson(entry, `${path}[${index}]`)).join(",")}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [, entry] of entries) {
      if (entry === undefined) {
        throw new ToolError({
          code: "VALIDATION_FAILED",
          message: `Cannot canonicalize undefined value at ${path}.`,
        });
      }
    }
    const body = entries
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry, `${path}.${key}`)}`)
      .join(",");
    return `{${body}}`;
  }

  throw new ToolError({
    code: "VALIDATION_FAILED",
    message: `Cannot canonicalize ${typeof value} at ${path}.`,
  });
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256OfJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

export interface FingerprintInputRef {
  kind: "image" | "audio" | string;
  sha256?: string;
  url?: string;
}

export interface FingerprintParts {
  provider: string;
  logicalModel: string;
  capability: Capability;
  normalizedParameters: Record<string, unknown>;
  prompt?: string;
  inputs: FingerprintInputRef[];
}

export const FINGERPRINT_PREFIX = "sha256:";

/**
 * Local duplicate protection (§15). This is *not* remote idempotency: it only
 * prevents this project from paying twice for the same request.
 */
export function fingerprintRequest(parts: FingerprintParts): string {
  const normalizedInputs = parts.inputs
    .map((input) => ({
      kind: input.kind,
      ...(input.sha256 !== undefined ? { sha256: input.sha256 } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
    }))
    .sort((a, b) => {
      const left = `${a.kind}:${a.sha256 ?? a.url ?? ""}`;
      const right = `${b.kind}:${b.sha256 ?? b.url ?? ""}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });

  const payload = {
    provider: parts.provider,
    logicalModel: parts.logicalModel,
    capability: parts.capability,
    normalizedParameters: parts.normalizedParameters,
    prompt: parts.prompt ?? null,
    inputs: normalizedInputs,
  };

  return `${FINGERPRINT_PREFIX}${sha256OfJson(payload)}`;
}

export function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

export function shortId(value: string, length = 8): string {
  return value.length <= length ? value : value.slice(0, length);
}

/** Media kind implied by a reported MIME prefix, when one is evident. */
export function kindFromMimeType(mimeType: string | undefined): AssetKind | undefined {
  if (mimeType === undefined) return undefined;
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return undefined;
}
