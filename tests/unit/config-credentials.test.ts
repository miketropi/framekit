import { describe, expect, it } from "vitest";
import {
  hasCredentials,
  loadConfig,
  requireCredentials,
  resolveCredentials,
} from "../../src/config/env";
import { ToolError } from "../../src/domain/errors";
import { clearRegisteredSecrets, registerSecret, redactString } from "../../src/domain/redact";

const COMBINED = "key-id-0000000000:key-secret-0000000000";

describe("credential resolution", () => {
  it("reads the combined single-field value the dashboard provides", () => {
    const credentials = resolveCredentials({ HF_CREDENTIALS: COMBINED });
    expect(credentials).toMatchObject({
      apiKey: "key-id-0000000000",
      apiSecret: "key-secret-0000000000",
      source: "combined",
      sourceVariable: "HF_CREDENTIALS",
    });
  });

  it("accepts the HF_KEY alias and splits on the first colon only", () => {
    expect(resolveCredentials({ HF_KEY: COMBINED })).toMatchObject({
      sourceVariable: "HF_KEY",
      source: "combined",
    });
    // A secret that itself contains colons survives intact.
    expect(
      resolveCredentials({ HF_CREDENTIALS: "id-0000000000:sec:ret:0000000000" }),
    ).toMatchObject({
      apiKey: "id-0000000000",
      apiSecret: "sec:ret:0000000000",
    });
  });

  it("accepts the separate pair, including the SDK's HF_API_SECRET name", () => {
    expect(
      resolveCredentials({
        HF_API_KEY: "key-id-0000000000",
        HF_API_SECRET: "key-secret-0000000000",
      }),
    ).toMatchObject({
      source: "separate",
      sourceVariable: "HF_API_KEY+HF_API_SECRET",
    });
    expect(
      resolveCredentials({ HF_API_KEY: "key-id-0000000000", HF_SECRET: "key-secret-0000000000" }),
    ).toMatchObject({ sourceVariable: "HF_API_KEY+HF_SECRET" });
  });

  it("prefers a complete separate pair, and falls back to the combined value for a half pair", () => {
    expect(
      resolveCredentials({
        HF_API_KEY: "pair-key-0000000000",
        HF_API_SECRET: "pair-secret-0000000000",
        HF_CREDENTIALS: COMBINED,
      }),
    ).toMatchObject({ apiKey: "pair-key-0000000000", source: "separate" });

    expect(
      resolveCredentials({ HF_API_KEY: "orphan-key-0000000000", HF_CREDENTIALS: COMBINED }),
    ).toMatchObject({ apiKey: "key-id-0000000000", source: "combined" });
  });

  it("reports missing and incomplete configurations distinctly", () => {
    expect(resolveCredentials({})).toEqual({
      source: "missing",
      sourceVariable: "",
      presentVariables: [],
    });
    expect(resolveCredentials({ HF_CREDENTIALS: "   " })).toEqual({
      source: "missing",
      sourceVariable: "",
      presentVariables: [],
    });
    expect(resolveCredentials({ HF_API_KEY: "key-id-0000000000" })).toEqual({
      source: "incomplete",
      sourceVariable: "HF_API_KEY",
      presentVariables: ["HF_API_KEY"],
    });
  });

  it("rejects a malformed combined value with an actionable configuration error", () => {
    for (const value of ["no-colon-here", ":secret-0000000000", "key-id-0000000000:"]) {
      const error = (() => {
        try {
          resolveCredentials({ HF_CREDENTIALS: value });
          return undefined;
        } catch (thrown) {
          return thrown;
        }
      })();

      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe("VALIDATION_FAILED");
      expect((error as ToolError).message).toContain("<key_id>:<key_secret>");
    }
  });
});

describe("credential use", () => {
  it("hands both halves to the provider and registers them for redaction", () => {
    const config = loadConfig({ env: { HF_CREDENTIALS: COMBINED } });

    expect(hasCredentials(config)).toBe(true);
    expect(requireCredentials(config)).toEqual({
      apiKey: "key-id-0000000000",
      apiSecret: "key-secret-0000000000",
    });
    expect(config.credentials.source).toBe("combined");
    expect(redactString("failed with key-secret-0000000000")).toBe("failed with [REDACTED]");
    clearRegisteredSecrets();
    registerSecret("unrelated-0000000000");
  });

  it("explains exactly what is missing when credentials are absent or half-set", () => {
    const missing = (() => {
      try {
        requireCredentials(loadConfig({ env: {} }));
        return undefined;
      } catch (thrown) {
        return thrown as ToolError;
      }
    })();
    expect(missing).toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(missing?.message).toContain('HF_CREDENTIALS="<key_id>:<key_secret>"');

    const incomplete = (() => {
      try {
        requireCredentials(loadConfig({ env: { HF_API_KEY: "key-id-0000000000" } }));
        return undefined;
      } catch (thrown) {
        return thrown as ToolError;
      }
    })();
    expect(incomplete).toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(incomplete?.message).toContain("HF_API_KEY");
    // The lone half is never adopted (nothing downstream may use half credentials),
    // but the diagnostics say exactly which variable was set.
    expect(incomplete?.details).toMatchObject({
      source: "incomplete",
      hasApiKey: false,
      presentVariables: ["HF_API_KEY"],
    });
  });

  it("keeps injected overrides working for embedders", () => {
    const config = loadConfig({
      env: { HF_CREDENTIALS: COMBINED },
      overrides: { apiKey: "override-key-0000000000", apiSecret: "override-secret-0000000000" },
    });
    expect(requireCredentials(config)).toEqual({
      apiKey: "override-key-0000000000",
      apiSecret: "override-secret-0000000000",
    });
  });
});
