import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../../src/application/doctor";
import { ToolError } from "../../src/domain/errors";
import { testConfig } from "../helpers/provider";
import { createFakeProvider } from "../helpers/fake-media-provider";

const configWithUserinfo = testConfig({ apiBaseUrl: "https://user:sup3rsecret@api.example.test" });

describe("doctor workflow", () => {
  it("fails with the authentication code when credentials are absent", async () => {
    const config = testConfig({ apiKey: "", apiSecret: "" });
    const cwd = await mkdtemp(path.join(tmpdir(), "hf-doctor-"));

    const error = await runDoctor({
      config,
      cwd,
      getProvider: () => {
        throw new Error("a provider must not be constructed without credentials");
      },
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe("AUTHENTICATION_FAILED");
    expect((error as ToolError).details).toMatchObject({
      credentials: { apiKey: false, apiSecret: false },
      providerSupported: true,
      nodeCompatible: true,
    });
  });

  it("reports discovery health and scrubs userinfo out of the echoed base URL", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "hf-doctor-"));
    const fake = createFakeProvider({
      listMotions: async () => [{ id: "m1", name: "Zoom In" }],
    });

    const report = await runDoctor({
      config: configWithUserinfo,
      cwd,
      getProvider: async () => fake.provider,
    });

    expect(report).toMatchObject({
      provider: "higgsfield-v1",
      providerSupported: true,
      credentials: { apiKey: true, apiSecret: true },
      discovery: { ok: true, motions: 1 },
      outputDirectory: { path: cwd, writable: true },
    });
    expect(report.apiBaseUrl).toBe("https://api.example.test");
    expect(report.apiBaseUrl).not.toContain("sup3rsecret");
    expect(report.checks.every((check) => check.ok)).toBe(true);
  });

  it("probes the upload path only when asked, and reports a storage rejection distinctly", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "hf-doctor-"));

    const healthy = createFakeProvider({
      listMotions: async () => [{ id: "m1", name: "Zoom In" }],
      upload: async (request) => ({
        url: "https://cdn.test/probe.png",
        contentType: request.contentType,
        sha256: request.sha256,
        bytes: request.data.byteLength,
      }),
    });

    const untouched = await runDoctor({
      config: configWithUserinfo,
      cwd,
      getProvider: async () => healthy.provider,
    });
    expect(untouched.uploads).toBeUndefined();
    expect(healthy.calls.upload).toHaveLength(0);

    const probed = await runDoctor({
      config: configWithUserinfo,
      cwd,
      checkUpload: true,
      getProvider: async () => healthy.provider,
      fetchImpl: async () => new Response("", { status: 200 }),
    });
    expect(probed.uploads).toEqual({ ok: true, reachable: true, status: 200 });
    expect(healthy.calls.upload).toHaveLength(1);
    expect(healthy.calls.upload[0]).toMatchObject({ contentType: "image/png" });

    const rejected = createFakeProvider({
      listMotions: async () => [],
      upload: async () => {
        throw new ToolError({
          code: "UPLOAD_FAILED",
          message: "rejected by the provider's storage endpoint (HTTP 403, SignatureDoesNotMatch)",
          details: { stage: "signed-url-put", status: 403, providerCode: "SignatureDoesNotMatch" },
        });
      },
    });

    const error = await runDoctor({
      config: configWithUserinfo,
      cwd,
      checkUpload: true,
      getProvider: async () => rejected.provider,
    }).catch((failure: unknown) => failure);

    expect((error as ToolError).code).toBe("UPLOAD_FAILED");
    expect((error as ToolError).message).toContain("SignatureDoesNotMatch");
    expect((error as ToolError).details).toMatchObject({
      uploads: { ok: false, status: 403, providerCode: "SignatureDoesNotMatch" },
    });
  });

  it("surfaces a provider failure with the report attached and never generates", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "hf-doctor-"));
    const fake = createFakeProvider({
      listMotions: async () => {
        throw new ToolError({ code: "RATE_LIMITED", message: "slow down", retryable: true });
      },
    });

    const error = await runDoctor({
      config: configWithUserinfo,
      cwd,
      getProvider: async () => fake.provider,
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe("RATE_LIMITED");
    expect((error as ToolError).details).toMatchObject({
      discovery: { ok: false },
      providerError: { code: "RATE_LIMITED" },
    });
    expect(fake.calls.generate).toHaveLength(0);
    expect(fake.calls.upload).toHaveLength(0);
  });
});
