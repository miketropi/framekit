import { HiggsfieldClient } from "@higgsfield/client";
import type { ToolConfig } from "../../config/env";
import { requireCredentials } from "../../config/env";
import { ToolError } from "../../domain/errors";
import { normalizeProviderError, toolErrorFromHttpStatus } from "./errors";

/**
 * Provider-private client construction (§8).
 *
 * Two transports exist:
 *  - the official SDK, used for generation, uploads, and discovery;
 *  - a small authenticated fetch client, used only for the V1 status route the
 *    SDK does not expose publicly.
 */

/** Structural subset of `HiggsfieldClient` the provider depends on (test seam). */
export interface HiggsfieldSdk {
  generate(
    endpoint: string,
    params: Record<string, unknown>,
    options?: { withPolling?: boolean },
  ): Promise<{ id: string; jobs: { id: string; status: string; results?: unknown }[] }>;
  upload(data: Buffer | Uint8Array, contentType: string): Promise<string>;
  uploadImage(imageBuffer: Buffer, format?: "jpeg" | "png" | "webp"): Promise<string>;
  getMotions(): Promise<unknown>;
  getSoulStyles(): Promise<unknown>;
  createSoulId(
    data: { name: string; input_images: { type: string; image_url: string }[] },
    withPolling?: boolean,
  ): Promise<{ id: string; name: string; status: string }>;
  listSoulIds(page?: number, pageSize?: number): Promise<unknown>;
}

export interface V1HttpResponse {
  status: number;
  body: unknown;
}

export type V1AuthMode = "v1" | "v2";

export interface V1HttpClient {
  /** `auth: "v2"` uses the v2 `Authorization: Key KEY_ID:KEY_SECRET` header. */
  get(path: string, options?: { auth?: V1AuthMode }): Promise<V1HttpResponse>;
}

export interface HiggsfieldClientBundle {
  sdk: HiggsfieldSdk;
  http: V1HttpClient;
}

/**
 * The SDK's own retry loop is disabled (`maxRetries: 0`) because it retries any
 * non-axios error — including authentication and credit failures — and because
 * a resubmitted generation can be billed twice.
 */
export function createSdkClient(config: ToolConfig): HiggsfieldSdk {
  const credentials = requireCredentials(config);
  return new HiggsfieldClient({
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    baseURL: config.apiBaseUrl,
    timeout: config.timeoutMs,
    maxRetries: 0,
    retryBackoff: config.retryBackoffMs,
    retryMaxBackoff: config.retryMaxBackoffMs,
    pollInterval: config.pollIntervalMs,
    maxPollTime: config.videoPollLimitMs,
  });
}

export interface V1HttpClientOptions {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** Authenticated JSON GET against V1, used for routes the SDK does not expose. */
export function createV1HttpClient(options: V1HttpClientOptions): V1HttpClient {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async get(path: string, requestOptions: { auth?: V1AuthMode } = {}): Promise<V1HttpResponse> {
      const base = options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`;
      const url = new URL(path.replace(/^\//, ""), base).toString();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);

      let response: Response;
      let text: string;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers:
            requestOptions.auth === "v2"
              ? {
                  authorization: `Key ${options.apiKey}:${options.apiSecret}`,
                  accept: "application/json",
                }
              : {
                  "hf-api-key": options.apiKey,
                  "hf-secret": options.apiSecret,
                  accept: "application/json",
                },
          signal: controller.signal,
        });
        // The body is read inside the same deadline: a stalled status response must
        // not hang `hf status` or the polling loop of an already-paid job.
        text = await response.text();
      } catch (error) {
        if (controller.signal.aborted) {
          throw new ToolError({
            code: "TIMEOUT",
            message: `Higgsfield status request to ${path} timed out after ${options.timeoutMs}ms.`,
            details: { path, timeoutMs: options.timeoutMs },
            retryable: true,
            cause: error,
          });
        }
        const normalized = normalizeProviderError(error, `Cannot reach Higgsfield at ${path}.`);
        if (normalized.code === "UNKNOWN_PROVIDER_ERROR") {
          throw new ToolError({
            code: "PROVIDER_UNAVAILABLE",
            message: `Cannot reach Higgsfield at ${path}.`,
            details: { path },
            retryable: true,
            cause: error,
          });
        }
        throw normalized;
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        throw toolErrorFromHttpStatus(response.status, { path });
      }

      let body: unknown;
      if (text.trim().length > 0) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = text;
        }
      }

      return { status: response.status, body };
    },
  };
}

/** Credential-gated client bundle; only commands that contact the provider call this. */
export function createHiggsfieldClients(
  config: ToolConfig,
  fetchImpl?: typeof fetch,
): HiggsfieldClientBundle {
  const credentials = requireCredentials(config);
  return {
    sdk: createSdkClient(config),
    http: createV1HttpClient({
      baseUrl: config.apiBaseUrl,
      apiKey: credentials.apiKey,
      apiSecret: credentials.apiSecret,
      timeoutMs: config.timeoutMs,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    }),
  };
}
