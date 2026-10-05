/** Adapter defaults (§13). These are adapter policy, not API guarantees. */

export const DEFAULT_PROVIDER = "higgsfield-v1";
export const DEFAULT_API_BASE_URL = "https://api.higgsfield.ai";
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_RETRY_COUNT = 3;
export const DEFAULT_RETRY_BACKOFF_MS = 1_000;
export const DEFAULT_RETRY_MAX_BACKOFF_MS = 30_000;
export const DEFAULT_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_IMAGE_POLL_LIMIT_MS = 300_000;
export const DEFAULT_VIDEO_POLL_LIMIT_MS = 900_000;
export const DEFAULT_CACHE_ROOT = ".cache/higgsfield";

export const MIN_RETRY_COUNT = 0;
export const MAX_RETRY_COUNT = 10;

/** Discovery cache lifetime before a refresh is required. */
export const DISCOVERY_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

/** Input limits (§11). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
export const MAX_GENERIC_INPUT_BYTES = 1024 * 1024;

export const MIN_CHARACTER_IMAGES = 1;
export const MAX_CHARACTER_IMAGES = 4;
export const MAX_CHARACTER_PAGE_SIZE = 100;

export const MAX_SEED = 1_000_000;
export const ALLOWED_IMAGE_BATCHES: readonly (1 | 4)[] = [1, 4];

/** Media the adapter accepts for local inputs, keyed by detected media type. */
export const ACCEPTED_IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
};
export const ACCEPTED_AUDIO_TYPES: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
};

/** File extensions used when naming downloaded outputs. */
export const EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
};
