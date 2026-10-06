/**
 * Provider-neutral generation domain.
 *
 * Nothing in this module may reference an endpoint path, an SDK type
 * (`JobSet`, `SoulId`), or a Higgsfield helper enum. That is the migration seam
 * described in §7/§29: a V2 provider must be able to satisfy these types.
 */

export const CAPABILITIES = [
  "text-to-image",
  "image-to-video",
  "speech-to-video",
  "character-reference",
  "generic",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const GENERATION_STATUSES = [
  "queued",
  "in_progress",
  "completed",
  "failed",
  "nsfw",
  "canceled",
] as const;

export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

const TERMINAL_STATUSES: Record<string, true> = {
  completed: true,
  failed: true,
  nsfw: true,
  canceled: true,
};

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES[status] === true;
}

export const ASSET_KINDS = ["image", "video", "audio"] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

/** A media file that exists remotely and can be downloaded. */
export interface RemoteAsset {
  kind: AssetKind;
  url: string;
}

/** Normalized terminal outcome of a generation submission. */
export interface GenerationResult {
  requestId: string;
  status: GenerationStatus;
  assets: RemoteAsset[];
}

/**
 * A local input that has been made reachable by the provider: either the user
 * supplied an HTTP(S) reference, or the adapter uploaded local bytes first.
 */
export interface ResolvedInputRef {
  kind: "image" | "audio";
  url: string;
  /** Content hash, present when the input originated as a local file. */
  sha256?: string;
}

export interface TextToImageProviderRequest {
  capability: "text-to-image";
  logicalModel: string;
  prompt: string;
  preset: string;
  widthAndHeight: string;
  quality: string;
  batch: 1 | 4;
  seed?: number;
  /** Style name or id; the provider resolves it against style discovery. */
  style?: string;
  styleStrength?: number;
  reference?: ResolvedInputRef;
  referenceStrength?: number;
  characterId?: string;
}

export interface ImageToVideoProviderRequest {
  capability: "image-to-video";
  logicalModel: string;
  /** Provider model parameter resolved from the logical model registry. */
  model: string;
  prompt: string;
  preset: string;
  inputImages: ResolvedInputRef[];
  /** Motion name or id; the provider resolves it against motion discovery. */
  motion?: string;
  motionStrength?: number;
}

export interface SpeechToVideoProviderRequest {
  capability: "speech-to-video";
  logicalModel: string;
  prompt: string;
  preset: string;
  image: ResolvedInputRef;
  audio: ResolvedInputRef;
  quality: string;
  duration: number;
}

/**
 * Escape hatch for supported V1 endpoints that have no typed command yet.
 * `endpoint` is only ever populated after application-layer allow-list
 * validation.
 */
export interface GenericProviderRequest {
  capability: "generic";
  logicalModel: string;
  endpoint: string;
  params: Record<string, unknown>;
}

export type ProviderGenerationRequest =
  | TextToImageProviderRequest
  | ImageToVideoProviderRequest
  | SpeechToVideoProviderRequest
  | GenericProviderRequest;

/**
 * Richer status view: which provider route answered, plus any result URLs it reported.
 * V1 job sets expose results, and the v2 request route returns `images[].url` /
 * `video.url`, so a status query can recover a result URL without a manifest.
 */
export interface GenerationStatusReport {
  requestId: string;
  status: GenerationStatus;
  /** Provider route that produced the report; absent when a provider has no richer lookup. */
  source?: "job-set" | "request";
  assets: RemoteAsset[];
}

/** Minimal job view used for diagnostics; never a V1 `JobSet`. */
export interface JobSummary {
  id: string;
  status: string;
}
