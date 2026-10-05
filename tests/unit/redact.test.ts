import { afterEach, describe, expect, it } from "vitest";
import { ToolError, toToolError } from "../../src/domain/errors";
import {
  clearRegisteredSecrets,
  redactHeaders,
  redactString,
  redactUrl,
  redactValue,
  registerSecret,
  scrubForStorage,
} from "../../src/domain/redact";

afterEach(() => {
  clearRegisteredSecrets();
});

describe("secret redaction", () => {
  it("removes registered credentials from strings", () => {
    registerSecret("key-1234567890abcdef");
    registerSecret("secret-abcdef1234567890");

    expect(redactString("using key-1234567890abcdef now")).toBe("using [REDACTED] now");
    expect(redactString("https://x/y?k=secret-abcdef1234567890")).toBe("https://x/y?[REDACTED]");
  });

  it("ignores short values that would corrupt unrelated text", () => {
    registerSecret("abc");
    expect(redactString("abc def")).toBe("abc def");
  });

  it("strips signed query strings and URL credentials", () => {
    expect(redactUrl("https://cdn.test/a.png?X-Amz-Signature=deadbeef&expires=123")).toBe(
      "https://cdn.test/a.png",
    );
    expect(redactString("GET https://cdn.test/a.png?token=abc123 failed")).toBe(
      "GET https://cdn.test/a.png?[REDACTED] failed",
    );
  });

  it("hides authorization-like headers", () => {
    expect(
      redactHeaders({
        Authorization: "Bearer abc",
        "hf-api-key": "key-1234567890abcdef",
        "content-type": "application/json",
      }),
    ).toEqual({
      Authorization: "[REDACTED]",
      "hf-api-key": "[REDACTED]",
      "content-type": "application/json",
    });
  });

  it("replaces binary payloads and bounds traversal", () => {
    expect(redactValue({ file: new Uint8Array(1024) })).toEqual({ file: "[binary] 1024 bytes" });

    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let depth = 0; depth < 20; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    expect(JSON.stringify(redactValue(deep))).toContain("[depth limit]");
  });

  it("drops every non-boolean value under a credential-ish key", () => {
    expect(
      redactValue({ "hf-secret": 12345678, authorization: ["Bearer abc"], cookie: { a: 1 } }),
    ).toEqual({ "hf-secret": "[REDACTED]", authorization: "[REDACTED]", cookie: "[REDACTED]" });
  });

  it("scrubs header names and upper-case schemes in free text", () => {
    expect(redactString("cookie: session=abc123; set-cookie: x")).toBe(
      "cookie: [REDACTED]; set-cookie: [REDACTED]",
    );
    expect(redactString("HTTPS://cdn.test/a.png?sig=deadbeef done")).toBe(
      "HTTPS://cdn.test/a.png?[REDACTED] done",
    );
  });

  it("prepares storage-safe copies without truncating long values", () => {
    registerSecret("key-1234567890abcdef");
    const longPrompt = "x".repeat(5_000);
    const stored = scrubForStorage({
      prompt: longPrompt,
      input_url: "https://cdn.test/a.png?X-Amz-Signature=deadbeef",
      userinfo: "https://user:pass@cdn.test/b.png",
      nested: { token: "key-1234567890abcdef" },
      bytes: new Uint8Array(4),
    }) as Record<string, unknown>;

    expect(stored.prompt).toBe(longPrompt);
    expect(stored.input_url).toBe("https://cdn.test/a.png");
    expect(stored.userinfo).toBe("https://cdn.test/b.png");
    expect(stored.nested).toEqual({ token: "[REDACTED]" });
    expect(stored.bytes).toBe("[binary] 4 bytes");
  });

  it("keeps deeply nested storage copies distinct and cycle-safe", () => {
    const deep = (leaf: string): unknown => {
      let node: unknown = leaf;
      for (let level = 0; level < 12; level += 1) node = { nested: node };
      return node;
    };

    const first = JSON.stringify(scrubForStorage(deep("first")));
    const second = JSON.stringify(scrubForStorage(deep("second")));
    expect(first).not.toBe(second);
    expect(first).toContain("first");

    const cyclic: Record<string, unknown> = { prompt: "x" };
    cyclic.self = cyclic;
    expect(JSON.stringify(scrubForStorage(cyclic))).toContain("[circular]");

    // The helper is safe even without the caller's prototype-pollution guard.
    const hostile = JSON.parse('{"__proto__":{"polluted":true},"ok":1}') as Record<string, unknown>;
    const scrubbed = scrubForStorage(hostile) as Record<string, unknown>;
    expect(Object.keys(scrubbed)).toEqual(["ok"]);
    expect(Object.getPrototypeOf(scrubbed)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("redacts the stacks it hands back", () => {
    registerSecret("key-1234567890abcdef");
    const error = toToolError(new Error("boom key-1234567890abcdef"));
    expect(error.stack ?? "").not.toContain("key-1234567890abcdef");
  });

  it("keeps boolean credential-presence flags readable", () => {
    expect(redactValue({ credentials: { apiKey: true, apiSecret: false } })).toEqual({
      credentials: { apiKey: true, apiSecret: false },
    });
    expect(redactValue({ credentials: { apiKey: "key-1234567890abcdef" } })).toEqual({
      credentials: { apiKey: "[REDACTED]" },
    });
  });
});

describe("ToolError serialization", () => {
  it("sanitizes details and omits causes and stacks", () => {
    registerSecret("key-1234567890abcdef");
    const error = new ToolError({
      code: "PROVIDER_UNAVAILABLE",
      message: "failed with key-1234567890abcdef",
      requestId: "req-1",
      details: {
        url: "https://cdn.test/file.png?signature=abcdef123456",
        headers: { authorization: "Bearer key-1234567890abcdef" },
        body: new Uint8Array(8),
      },
      cause: new Error("inner"),
    });

    const serialized = error.toJSON();
    expect(serialized.code).toBe("PROVIDER_UNAVAILABLE");
    expect(serialized.retryable).toBe(true);
    expect(serialized.requestId).toBe("req-1");
    expect(serialized.message).not.toContain("key-1234567890abcdef");
    expect(JSON.stringify(serialized)).not.toContain("key-1234567890abcdef");
    expect(JSON.stringify(serialized)).not.toContain("signature=abcdef123456");
    expect(serialized).not.toHaveProperty("cause");
    expect(serialized).not.toHaveProperty("stack");
  });

  it("defaults retryability per code", () => {
    expect(new ToolError({ code: "RATE_LIMITED", message: "x" }).retryable).toBe(true);
    expect(new ToolError({ code: "TIMEOUT", message: "x" }).retryable).toBe(true);
    expect(new ToolError({ code: "GENERATION_FAILED", message: "x" }).retryable).toBe(false);
    expect(new ToolError({ code: "MODERATION_REJECTED", message: "x" }).retryable).toBe(false);
    expect(new ToolError({ code: "INSUFFICIENT_CREDITS", message: "x" }).retryable).toBe(false);
    expect(new ToolError({ code: "TIMEOUT", message: "x", retryable: false }).retryable).toBe(
      false,
    );
  });
});
