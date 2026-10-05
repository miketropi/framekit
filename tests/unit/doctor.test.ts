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
