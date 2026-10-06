import { describe, expect, it } from "vitest";
import { retryDelayMs, withRetry } from "../../src/domain/retry";
import {
  normalizeProviderError,
  normalizeUploadFailure,
  storageErrorCode,
  toolErrorFromHttpStatus,
  uploadFailureStage,
} from "../../src/providers/higgsfield-v1/errors";
import { ToolError, isSafeToRetry, toToolError } from "../../src/domain/errors";
import { FakeClock, RecordingSleeper } from "../helpers/clock";

const policy = { count: 3, backoffMs: 1_000, maxBackoffMs: 8_000 };

describe("retry backoff", () => {
  it("caps exponential growth and applies full jitter within the cap", () => {
    const zero = { next: () => 0 };
    const nearlyOne = { next: () => 0.999_999 };

    expect(retryDelayMs(policy, 0, zero)).toBe(0);
    expect(retryDelayMs(policy, 0, nearlyOne)).toBe(999);
    expect(retryDelayMs(policy, 1, nearlyOne)).toBe(1_999);
    expect(retryDelayMs(policy, 2, nearlyOne)).toBe(3_999);
    expect(retryDelayMs(policy, 3, nearlyOne)).toBe(7_999);
    expect(retryDelayMs(policy, 4, nearlyOne)).toBe(7_999);
    expect(retryDelayMs(policy, 10, nearlyOne)).toBe(7_999);
  });

  it("stops after the configured number of attempts and only for retryable errors", async () => {
    const sleeper = new RecordingSleeper(new FakeClock());
    let attempts = 0;
    const retryable = new ToolError({ code: "RATE_LIMITED", message: "429" });

    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw retryable;
        },
        policy,
        { sleeper, random: { next: () => 0.5 } },
        isSafeToRetry,
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });

    expect(attempts).toBe(4);
    expect(sleeper.delays).toHaveLength(3);

    let fatalAttempts = 0;
    await expect(
      withRetry(
        async () => {
          fatalAttempts += 1;
          throw new ToolError({ code: "AUTHENTICATION_FAILED", message: "401" });
        },
        policy,
        { sleeper, random: { next: () => 0.5 } },
        isSafeToRetry,
      ),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(fatalAttempts).toBe(1);
  });
});

describe("retry eligibility", () => {
  it("retries any transient tool error and nothing else", () => {
    expect(isSafeToRetry(new ToolError({ code: "RATE_LIMITED", message: "429" }))).toBe(true);
    expect(isSafeToRetry(new ToolError({ code: "PROVIDER_UNAVAILABLE", message: "503" }))).toBe(
      true,
    );
    expect(
      isSafeToRetry(new ToolError({ code: "DOWNLOAD_FAILED", message: "500", retryable: true })),
    ).toBe(true);
    expect(
      isSafeToRetry(new ToolError({ code: "UPLOAD_FAILED", message: "reset", retryable: true })),
    ).toBe(true);
    expect(isSafeToRetry(new ToolError({ code: "DOWNLOAD_FAILED", message: "404" }))).toBe(false);
    expect(isSafeToRetry(new ToolError({ code: "AUTHENTICATION_FAILED", message: "401" }))).toBe(
      false,
    );
    expect(isSafeToRetry(new ToolError({ code: "GENERATION_FAILED", message: "failed" }))).toBe(
      false,
    );
    expect(isSafeToRetry(new Error("plain"))).toBe(false);
  });
});

describe("provider error normalization", () => {
  it("maps HTTP statuses to the taxonomy with correct retryability", () => {
    const cases: { status: number; code: string; retryable: boolean }[] = [
      { status: 401, code: "AUTHENTICATION_FAILED", retryable: false },
      { status: 402, code: "INSUFFICIENT_CREDITS", retryable: false },
      { status: 403, code: "INSUFFICIENT_CREDITS", retryable: false },
      { status: 400, code: "INVALID_INPUT", retryable: false },
      { status: 422, code: "VALIDATION_FAILED", retryable: false },
      { status: 429, code: "RATE_LIMITED", retryable: true },
      { status: 500, code: "PROVIDER_UNAVAILABLE", retryable: true },
      { status: 503, code: "PROVIDER_UNAVAILABLE", retryable: true },
      { status: 404, code: "UNKNOWN_PROVIDER_ERROR", retryable: false },
    ];

    for (const testCase of cases) {
      const error = toolErrorFromHttpStatus(testCase.status, { path: "/v1/x" });
      expect(error.code).toBe(testCase.code);
      expect(error.retryable).toBe(testCase.retryable);
      expect(error.details).toMatchObject({ status: testCase.status });
    }
  });

  it("maps network and timeout failures", () => {
    expect(normalizeProviderError({ code: "ECONNRESET" })).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
    });
    expect(normalizeProviderError({ code: "UND_ERR_CONNECT_TIMEOUT" })).toMatchObject({
      code: "TIMEOUT",
      retryable: true,
    });
    expect(normalizeProviderError(new Error("mystery"))).toMatchObject({
      code: "UNKNOWN_PROVIDER_ERROR",
    });
  });

  it("separates a provider-API failure from a signed-storage failure", () => {
    const apiBaseUrl = "https://api.higgsfield.ai";
    const signedUrl =
      "https://fnf-api-input-prod.s3.amazonaws.com/tenant/abc.png?X-Amz-Signature=deadbeef";

    // A 403 from the API is an account/permission state.
    const fromApi = {
      message: "Request failed with status code 403",
      config: { url: "/files/generate-upload-url", baseURL: apiBaseUrl },
      response: { status: 403, data: {} },
    };
    expect(uploadFailureStage(fromApi, apiBaseUrl)).toBe("api");
    expect(normalizeUploadFailure(fromApi, { apiBaseUrl, filename: "ref.png" })).toMatchObject({
      code: "INSUFFICIENT_CREDITS",
      retryable: false,
    });

    // A 403 from the signed storage URL is a storage rejection, never a credit state.
    const fromStorage = {
      message: "Request failed with status code 403",
      config: { url: signedUrl },
      response: {
        status: 403,
        data: "<Error><Code>SignatureDoesNotMatch</Code><Message>...</Message></Error>",
      },
    };
    expect(uploadFailureStage(fromStorage, apiBaseUrl)).toBe("storage");
    // No request metadata: never guess, keep the API taxonomy.
    expect(uploadFailureStage(new Error("mystery"), apiBaseUrl)).toBe("unknown");
    const unknownStage = normalizeUploadFailure(new Error("mystery"), {
      apiBaseUrl,
      filename: "ref.png",
    });
    expect(unknownStage.code).toBe("UPLOAD_FAILED");
    // Crucially, an unknown transport is not dressed up as a storage rejection.
    expect(unknownStage.details).not.toMatchObject({ stage: "signed-url-put" });
    const storageError = normalizeUploadFailure(fromStorage, { apiBaseUrl, filename: "ref.png" });
    expect(storageError).toMatchObject({
      code: "UPLOAD_FAILED",
      retryable: false,
      details: {
        stage: "signed-url-put",
        status: 403,
        providerCode: "SignatureDoesNotMatch",
        storageHost: "fnf-api-input-prod.s3.amazonaws.com",
      },
    });
    expect(storageError.message).toContain("not an account or credits problem");

    // Transient storage failures stay retryable; provider codes are parsed from XML.
    expect(storageErrorCode("<Error><Code>SlowDown</Code></Error>")).toBe("SlowDown");
    expect(storageErrorCode({})).toBeUndefined();
    expect(
      normalizeUploadFailure(
        { config: { url: signedUrl }, response: { status: 503, data: "" } },
        { apiBaseUrl, filename: "ref.png" },
      ),
    ).toMatchObject({ code: "UPLOAD_FAILED", retryable: true });
  });

  it("passes ToolErrors through unchanged", () => {
    const original = new ToolError({ code: "UPLOAD_FAILED", message: "keep me" });
    expect(normalizeProviderError(original)).toBe(original);
  });

  it("adopts structurally valid errors from another module instance", () => {
    // An externally loaded provider (test seam, worker, child process) throws its own
    // ToolError class; the taxonomy must survive the boundary.
    const foreign = {
      code: "INSUFFICIENT_CREDITS",
      message: "fake: no credits",
      retryable: false,
      requestId: "req-7",
      details: { status: 402 },
    };

    const adopted = toToolError(foreign);
    expect(adopted).toBeInstanceOf(ToolError);
    expect(adopted).toMatchObject({
      code: "INSUFFICIENT_CREDITS",
      message: "fake: no credits",
      retryable: false,
      requestId: "req-7",
      details: { status: 402 },
    });

    expect(toToolError({ code: "NOT_A_REAL_CODE", message: "x" })).toMatchObject({
      code: "UNKNOWN_PROVIDER_ERROR",
    });
    expect(toToolError({ code: "RATE_LIMITED" })).toMatchObject({ code: "UNKNOWN_PROVIDER_ERROR" });
  });
});
