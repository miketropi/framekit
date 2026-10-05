/**
 * Secret and payload redaction.
 *
 * Credentials observed by the process are registered here so that any string that
 * later flows into an error message, a log line, or a serialized payload is
 * scrubbed. Redaction is intentionally lossy: it never guesses, it replaces
 * known secret values and known-sensitive shapes (authorization-like headers,
 * URL query strings, request bodies, binary payloads).
 */

const REDACTED = "[REDACTED]";
const BINARY = "[binary]";

const registeredSecrets = new Set<string>();

/** Header names whose values must never be serialized. */
const SENSITIVE_HEADERS: Record<string, true> = {
  authorization: true,
  "proxy-authorization": true,
  cookie: true,
  "set-cookie": true,
  "hf-api-key": true,
  "hf-secret": true,
  "hf-credentials": true,
  "x-api-key": true,
  "api-key": true,
  apikey: true,
  "x-auth-token": true,
};

function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADERS[name.toLowerCase()] === true;
}

/** Header names matched inside free text (messages, stack traces, details). */
const SENSITIVE_NAME_PATTERN = Object.keys(SENSITIVE_HEADERS).join("|");

const MAX_STRING_LENGTH = 2_000;
const MAX_DEPTH = 6;
const MAX_ENTRIES = 50;

/**
 * Register a credential value so every later redaction pass removes it.
 * Short values (< 8 chars) are ignored: replacing them would corrupt unrelated text.
 */
export function registerSecret(value: string | undefined | null): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed.length < 8) return;
  registeredSecrets.add(trimmed);
}

/** Test/CLI hygiene helper: forget every registered secret. */
export function clearRegisteredSecrets(): void {
  registeredSecrets.clear();
}

/**
 * Strip signed query strings from a URL-ish string: `https://x/y?a=b&sig=c` -> `https://x/y?[REDACTED]`.
 */
function stripQueryStrings(value: string): string {
  return value.replace(
    /(https?:\/\/[^\s"'<>?]+)\?[^\s"'<>]*/gi,
    (_match, base: string) => `${base}?${REDACTED}`,
  );
}

/** Drops the query and userinfo of every http(s) URL in a string, keeping the rest. */
function stripUrlCredentials(value: string): string {
  return value
    .replace(/(https?:\/\/)[^\s"'<>/@]+@/gi, "$1")
    .replace(/(https?:\/\/[^\s"'<>?]+)\?[^\s"'<>]*/gi, "$1");
}

/**
 * Keys that must never be copied into a fresh object (prototype pollution).
 * A Set rather than a literal Record: `constructor` and `__proto__` are special in
 * object literals, which makes a literal lookup table type-incorrect.
 */
export const UNSAFE_OBJECT_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

/**
 * Storage-safe copy: values written to manifests/envelopes/caches never keep URL
 * query strings (signed parameters) or registered secret values.
 *
 * Unlike `redactValue` this recurses to full depth (a fingerprint must stay unique
 * for structurally different requests) and never truncates, so long prompts and
 * deeply nested bodies survive verbatim. Cycles are broken instead of recursed.
 */
export function scrubForStorage(value: unknown): unknown {
  return scrubStorageValue(value, new WeakSet<object>());
}

function scrubStorageValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return scrubStringForStorage(value);
  if (value === null || typeof value !== "object") return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    const byteLength =
      value instanceof ArrayBuffer ? value.byteLength : (value as ArrayBufferView).byteLength;
    return `${BINARY} ${byteLength} bytes`;
  }
  if (value instanceof Error) {
    return { name: value.name, message: scrubStringForStorage(value.message) };
  }
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((entry) => scrubStorageValue(entry, seen));

  // Null-prototype target: a hostile key can never reach Object.prototype.
  const output = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) continue;
    output[key] =
      isSensitiveHeader(key) && typeof entry !== "boolean"
        ? REDACTED
        : scrubStorageValue(entry, seen);
  }
  return output;
}

export function scrubStringForStorage(value: string): string {
  let output = stripUrlCredentials(value);
  for (const secret of registeredSecrets) {
    if (output.includes(secret)) output = output.split(secret).join(REDACTED);
  }
  return output;
}

/** Single-URL variant used for envelope fields such as `remoteUrl`. */
export function scrubUrlForStorage(value: string): string {
  return scrubStringForStorage(value);
}

/** Redact a single string: registered secrets, query strings. */
export function redactString(value: string): string {
  let output = value;
  for (const secret of registeredSecrets) {
    if (output.includes(secret)) {
      output = output.split(secret).join(REDACTED);
    }
  }
  output = stripQueryStrings(output);
  output = output.replace(
    new RegExp(`((?:${SENSITIVE_NAME_PATTERN})\\s*[:=]\\s*)([^\\s,;"']+)`, "gi"),
    `$1${REDACTED}`,
  );
  if (output.length > MAX_STRING_LENGTH) {
    output = `${output.slice(0, MAX_STRING_LENGTH)}...[truncated]`;
  }
  return output;
}

/** Redact every string inside a header map, dropping sensitive header values entirely. */
export function redactHeaders(headers: Record<string, unknown>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    output[key] = isSensitiveHeader(key) ? REDACTED : redactString(String(value));
  }
  return output;
}

/**
 * Deep-redact a value for serialization: removes registered secrets, replaces
 * binary payloads, breaks cycles, and caps depth/width.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[function]";
  if (typeof value === "symbol") return value.toString();

  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }

  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    const byteLength =
      value instanceof ArrayBuffer ? value.byteLength : (value as ArrayBufferView).byteLength;
    return `${BINARY} ${byteLength} bytes`;
  }

  if (depth >= MAX_DEPTH) return "[depth limit]";

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ENTRIES).map((item) => redactValue(item, depth + 1));
    if (value.length > MAX_ENTRIES) items.push(`...[${value.length - MAX_ENTRIES} more]`);
    return items;
  }

  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, entry] of entries.slice(0, MAX_ENTRIES)) {
      // Anything under a credential-ish key is dropped except booleans, which carry
      // no secret and are the documented "credentials present" signal.
      output[key] =
        isSensitiveHeader(key) && typeof entry !== "boolean"
          ? REDACTED
          : redactValue(entry, depth + 1);
    }
    if (entries.length > MAX_ENTRIES) {
      output["..."] = `[${entries.length - MAX_ENTRIES} more]`;
    }
    return output;
  }

  return String(value);
}

/** Redact a URL for display: keeps origin+path, drops query and credentials. */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return redactString(url.toString());
  } catch {
    return redactString(value);
  }
}

export const REDACTED_PLACEHOLDER = REDACTED;
