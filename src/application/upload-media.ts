import type { UploadedAsset } from "../domain/asset";
import type { MediaProvider } from "../domain/media-provider";
import type { Clock } from "../domain/runtime";
import type { CacheStore } from "../storage/cache-store";
import type { InspectedLocalInput } from "../storage/input-inspection";

/**
 * Upload workflow (§5.1/§11): local bytes are uploaded at most once per content
 * hash, and the resulting URL is reused from `.cache/higgsfield/uploads.json`.
 */

/** Injected upload seam: validated local input to remote URL. */
export type LocalUploader = (input: InspectedLocalInput) => Promise<UploadedAsset>;

export interface UploadServiceOptions {
  provider: MediaProvider;
  cache: CacheStore;
  clock: Clock;
}

export class UploadService {
  private readonly provider: MediaProvider;
  private readonly cache: CacheStore;
  private readonly clock: Clock;

  constructor(options: UploadServiceOptions) {
    this.provider = options.provider;
    this.cache = options.cache;
    this.clock = options.clock;
  }

  /** Cache-aware upload of an already validated local input. */
  async uploadLocal(input: InspectedLocalInput): Promise<UploadedAsset> {
    const cached = await this.cache.readUpload(input.sha256);
    if (cached !== undefined) {
      return {
        url: cached.url,
        contentType: cached.contentType,
        sha256: input.sha256,
        bytes: cached.bytes,
      };
    }

    const uploaded = await this.provider.upload({
      data: input.data,
      contentType: input.contentType,
      filename: input.displayPath,
      sha256: input.sha256,
    });

    await this.cache.writeUpload(input.sha256, {
      url: uploaded.url,
      contentType: uploaded.contentType,
      bytes: uploaded.bytes,
      uploadedAt: this.clock.now().toISOString(),
    });

    return uploaded;
  }
}
