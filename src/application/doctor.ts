import path from "node:path";
import { hasCredentials, type ToolConfig } from "../config/env";
import { ToolError, isToolError } from "../domain/errors";
import type { MediaProvider } from "../domain/media-provider";
import { SUPPORTED_PROVIDERS } from "../domain/media-provider";
import { scrubUrlForStorage } from "../domain/redact";
import { probeWritableDirectory } from "../storage/writable";
import { MINIMUM_NODE_MAJOR, PACKAGE_NAME, PACKAGE_VERSION } from "../version";

/**
 * `hf doctor` (§5.1/§6.4): reports runtime, credentials presence, provider
 * support, output writability, and — only when credentials exist — a safe
 * discovery call. It never generates and never uploads.
 */

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface DoctorReport {
  packageName: string;
  packageVersion: string;
  nodeVersion: string;
  minimumNodeMajor: number;
  nodeCompatible: boolean;
  provider: string;
  providerSupported: boolean;
  apiBaseUrl: string;
  credentials: { apiKey: boolean; apiSecret: boolean };
  outputDirectory: { path: string; writable: boolean; error?: string };
  discovery?: { ok: boolean; motions: number };
  checks: DoctorCheck[];
}

export interface DoctorServiceOptions {
  config: ToolConfig;
  cwd: string;
  output?: string;
  /** Resolved lazily so a credential-free doctor run never constructs a provider. */
  getProvider: () => Promise<MediaProvider>;
}

export async function runDoctor(options: DoctorServiceOptions): Promise<DoctorReport> {
  const outputDirectory = path.resolve(options.cwd, options.output ?? ".");
  const probe = await probeWritableDirectory(outputDirectory);
  const credentialsPresent = hasCredentials(options.config);
  const providerSupported = SUPPORTED_PROVIDERS[options.config.provider] !== undefined;
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const nodeCompatible = nodeMajor >= MINIMUM_NODE_MAJOR;

  const report: DoctorReport = {
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    nodeVersion: process.versions.node,
    minimumNodeMajor: MINIMUM_NODE_MAJOR,
    nodeCompatible,
    provider: options.config.provider,
    providerSupported,
    // Echoed for diagnostics only: userinfo in a configured base URL is not printed.
    apiBaseUrl: scrubUrlForStorage(options.config.apiBaseUrl),
    credentials: {
      apiKey: options.config.credentials.apiKey !== undefined,
      apiSecret: options.config.credentials.apiSecret !== undefined,
    },
    outputDirectory: {
      path: outputDirectory,
      writable: probe.writable,
      ...(probe.error === undefined ? {} : { error: probe.error }),
    },
    checks: [
      { name: "node", ok: nodeCompatible, detail: `node ${process.versions.node}` },
      { name: "provider", ok: providerSupported, detail: options.config.provider },
      {
        name: "credentials",
        ok: credentialsPresent,
        detail: credentialsPresent
          ? "HF_API_KEY and HF_SECRET present"
          : "HF_API_KEY and/or HF_SECRET missing",
      },
      {
        name: "output-directory",
        ok: probe.writable,
        detail: probe.error ?? outputDirectory,
      },
    ],
  };

  if (!credentialsPresent) {
    throw new ToolError({
      code: "AUTHENTICATION_FAILED",
      message:
        "Higgsfield credentials are missing. Set HF_API_KEY and HF_SECRET before running commands that contact the provider.",
      details: report,
    });
  }

  try {
    const provider = await options.getProvider();
    const motions = await provider.listMotions();
    report.discovery = { ok: true, motions: motions.length };
    report.checks.push({
      name: "connectivity",
      ok: true,
      detail: `discovery reachable (${motions.length} motions)`,
    });
  } catch (error) {
    const toolError = isToolError(error)
      ? error
      : new ToolError({
          code: "PROVIDER_UNAVAILABLE",
          message: error instanceof Error ? error.message : String(error),
          cause: error,
        });
    report.discovery = { ok: false, motions: 0 };
    report.checks.push({ name: "connectivity", ok: false, detail: toolError.message });
    throw new ToolError({
      code: toolError.code,
      message: toolError.message,
      retryable: toolError.retryable,
      details: { ...report, providerError: toolError.toJSON() },
      cause: error,
    });
  }

  return report;
}
