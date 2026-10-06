import type {
  CharacterReference,
  CharacterReferencePage,
  CharacterReferenceRequest,
  MotionPreset,
  StylePreset,
  UploadRequest,
  UploadedAsset,
} from "./asset";
import type {
  GenerationResult,
  GenerationStatus,
  GenerationStatusReport,
  ProviderGenerationRequest,
} from "./generation";

export type ProviderName = "higgsfield-v1";

/** Providers the adapter can construct. HF_PROVIDER must match one of these. */
export const SUPPORTED_PROVIDERS: Record<string, ProviderName> = {
  "higgsfield-v1": "higgsfield-v1",
};

/**
 * The only contract application services and the CLI consume (§7).
 *
 * `generate` performs submission *and* polling; a separate status call exists
 * only for inspecting a job that is already known to the caller.
 */
export interface MediaProvider {
  readonly name: ProviderName;
  generate(request: ProviderGenerationRequest): Promise<GenerationResult>;
  upload(request: UploadRequest): Promise<UploadedAsset>;
  getStatus(requestId: string): Promise<GenerationStatus>;
  /**
   * Optional richer status lookup. Providers that can report result URLs alongside the
   * status implement it; `hf status` uses it when present so a request id can yield a
   * media URL even when no local manifest exists.
   */
  getStatusReport?(requestId: string): Promise<GenerationStatusReport>;
  listMotions(): Promise<MotionPreset[]>;
  listStyles(): Promise<StylePreset[]>;
  createCharacter(request: CharacterReferenceRequest): Promise<CharacterReference>;
  listCharacters(page?: number, pageSize?: number): Promise<CharacterReferencePage>;
}
