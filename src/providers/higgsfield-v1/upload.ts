import type { UploadRequest, UploadedAsset } from "../../domain/asset";
import { ToolError } from "../../domain/errors";
import type { HiggsfieldSdk } from "./client";
import { isSafeToRetry } from "../../domain/errors";
import { normalizeUploadFailure } from "./errors";
import { withRetry, type RetryDependencies, type RetryPolicy } from "../../domain/retry";

/**
 * V1 uploads (§11). The upload link is requested first, then the bytes are PUT
 * to the signed URL. Both steps may retry on rate limiting/network/eligible 5xx,
 * but never on authentication, validation, or credit errors.
 */

export interface V1UploaderOptions {
  sdk: HiggsfieldSdk;
  retryPolicy: RetryPolicy;
  dependencies: RetryDependencies;
  /** Used to tell a provider-API failure from a signed-storage failure. */
  apiBaseUrl: string;
}

const IMAGE_FORMAT_BY_MIME: Record<string, "png" | "jpeg" | "webp"> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
};

export type V1UploadFunction = (request: UploadRequest) => Promise<UploadedAsset>;

export function createV1Uploader(options: V1UploaderOptions): V1UploadFunction {
  return async function upload(request: UploadRequest): Promise<UploadedAsset> {
    const format = IMAGE_FORMAT_BY_MIME[request.contentType];

    const url = await withRetry(
      async () => {
        try {
          if (format !== undefined) {
            return await options.sdk.uploadImage(Buffer.from(request.data), format);
          }
          return await options.sdk.upload(Buffer.from(request.data), request.contentType);
        } catch (error) {
          throw normalizeUploadFailure(error, {
            apiBaseUrl: options.apiBaseUrl,
            filename: request.filename,
          });
        }
      },
      options.retryPolicy,
      options.dependencies,
      isSafeToRetry,
    );

    if (typeof url !== "string" || !url.startsWith("https://")) {
      throw new ToolError({
        code: "UPLOAD_FAILED",
        message: `Upload of ${request.filename} did not return a usable HTTPS URL.`,
        details: { filename: request.filename },
      });
    }

    return {
      url,
      contentType: request.contentType,
      sha256: request.sha256,
      bytes: request.data.byteLength,
    };
  };
}
