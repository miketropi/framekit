import path from "node:path";
import { ToolError } from "../domain/errors";

/** Resolve a user-supplied path against the working directory. */
export function resolveUserPath(cwd: string, value: string): string {
  return path.resolve(cwd, value);
}

export function isInside(baseDirectory: string, candidate: string): boolean {
  const relative = path.relative(baseDirectory, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Paths reported in JSON/manifests are project-relative when inside the project,
 * normalized to forward slashes so output is stable across platforms.
 */
export function toDisplayPath(cwd: string, absolutePath: string): string {
  const target = isInside(cwd, absolutePath) ? path.relative(cwd, absolutePath) : absolutePath;
  return target.split(path.sep).join("/");
}

export function isHttpUrl(value: string): boolean {
  return value.startsWith("https://") || value.startsWith("http://");
}

/**
 * Signed query parameters are dropped before a URL is stored or fingerprinted:
 * upload URLs carry credentials in the query string.
 */
export function stripQueryString(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return value;
  }
}

/** Non-HTTP URL schemes (file:, data:, ftp:, ...) are rejected up front. */
export function assertNotUnsupportedScheme(value: string): void {
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(value);
  if (schemeMatch === null) return;
  const scheme = (schemeMatch[1] ?? "").toLowerCase();
  if (scheme === "http" || scheme === "https") return;
  throw new ToolError({
    code: "INVALID_INPUT",
    message: `Unsupported URL scheme "${scheme}://". Only http(s) URLs or local paths are accepted.`,
    details: { scheme },
  });
}

export function replaceExtension(filePath: string, extension: string): string {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}.${extension}`);
}
