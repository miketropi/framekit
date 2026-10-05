import type { AssetKind, Capability, GenerationStatus, ResolvedInputRef } from "./generation";

/** Bytes handed to the provider for upload, already validated and hashed. */
export interface UploadRequest {
  data: Uint8Array;
  contentType: string;
  filename: string;
  sha256: string;
}

export interface UploadedAsset {
  url: string;
  contentType: string;
  sha256: string;
  bytes: number;
}

export interface MotionPreset {
  id: string;
  name: string;
  description?: string;
  previewUrl?: string;
  startEndFrame?: boolean;
}

export interface StylePreset {
  id: string;
  name: string;
  description?: string;
  previewUrl?: string;
}

export type CharacterStatus = "not_ready" | "queued" | "in_progress" | "completed" | "failed";

export interface CharacterReferenceRequest {
  name: string;
  images: ResolvedInputRef[];
}

export interface CharacterReference {
  id: string;
  name: string;
  status: CharacterStatus;
}

export interface CharacterReferencePage {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  items: CharacterReference[];
}

/** A downloaded, verified local output file. */
export interface GeneratedAsset {
  type: AssetKind;
  /** Project-relative when inside the project, otherwise an absolute path. */
  path: string;
  mimeType: string;
  sha256: string;
  bytes: number;
  /** Absent when the asset was reused from an existing manifest. */
  remoteUrl?: string;
}

export interface ManifestInput {
  kind: "image" | "audio";
  /** Project-relative path for local inputs. */
  localPath?: string;
  /** Remote reference for URL inputs, with signed query strings removed. */
  url?: string;
  sha256?: string;
}

export interface ManifestOutput {
  type: AssetKind;
  path: string;
  mimeType: string;
  sha256: string;
  bytes: number;
}

export const MANIFEST_SCHEMA_VERSION = 1;

/**
 * Generation metadata (§16). Deliberately stores no credentials, no uploaded CDN
 * URL for local sources, and no remote-only state other than requestId/status.
 */
export interface GenerationManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  assetId: string;
  provider: string;
  capability: Capability;
  logicalModel: string;
  fingerprint: string;
  createdAt: string;
  prompt?: string;
  inputs: ManifestInput[];
  request: Record<string, unknown>;
  remote: {
    requestId: string;
    status: GenerationStatus;
  };
  outputs: ManifestOutput[];
}

/** Discovery cache payload after normalization. */
export interface DiscoveryCaches {
  motions: MotionPreset[];
  styles: StylePreset[];
}
