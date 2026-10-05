/**
 * @framekit/higgsfield-tools
 *
 * Local, agent-neutral adapter that turns Higgsfield generation requests into
 * deterministic project-local media files plus `generation.json` manifests.
 *
 * Public surface:
 *  - `runCli` executes the `hf` command contract (used by `bin/hf.ts`).
 *  - `createToolkitProvider` wires real dependencies (used by embedders/tests).
 *  - Domain contracts (`MediaProvider`, `ToolError`, config/registry types) are
 *    the stable seam a future V2 provider must satisfy.
 */

export { runCli, buildProgram, type RunOptions } from "./cli/program";
export {
  ENV_FILE_VARIABLE,
  DEFAULT_ENV_FILE,
  loadEnvFileInto,
  type EnvFileResult,
} from "./cli/env-file";
export { EXIT_CODES, EXIT_CODE_BY_ERROR, exitCodeForErrorCode } from "./cli/exit-codes";
export type { ProcessLike, CliRuntime, RuntimeOverrides } from "./cli/runtime";
export {
  CliOutput,
  type CommandResult,
  type SuccessEnvelope,
  type FailureEnvelope,
} from "./cli/output";

export {
  createToolkitProvider,
  TEST_PROVIDER_MODULE_ENV,
  type Toolkit,
  type ToolkitProvider,
  type ToolkitOverrides,
} from "./application/toolkit";

export {
  loadConfig,
  requireCredentials,
  hasCredentials,
  type ToolConfig,
  type ConfigOverrides,
} from "./config/env";
export {
  DEFAULT_API_BASE_URL,
  DEFAULT_CACHE_ROOT,
  DEFAULT_IMAGE_POLL_LIMIT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_RETRY_COUNT,
  DEFAULT_VIDEO_POLL_LIMIT_MS,
} from "./config/defaults";

export {
  ToolError,
  isToolError,
  toToolError,
  TOOL_ERROR_CODES,
  type ToolErrorCode,
} from "./domain/errors";
export type { MediaProvider, ProviderName } from "./domain/media-provider";
export { SUPPORTED_PROVIDERS } from "./domain/media-provider";
export type {
  AssetKind,
  Capability,
  GenerationResult,
  GenerationStatus,
  ProviderGenerationRequest,
  RemoteAsset,
} from "./domain/generation";
export type {
  CharacterReference,
  CharacterReferencePage,
  GeneratedAsset,
  GenerationManifest,
  ManifestInput,
  ManifestOutput,
  MotionPreset,
  StylePreset,
  UploadRequest,
  UploadedAsset,
} from "./domain/asset";
export { MANIFEST_SCHEMA_VERSION } from "./domain/asset";
export {
  GENERIC_LOGICAL_MODEL,
  listImagePresets,
  listModels,
  listSpeechPresets,
  listVideoPresets,
  resolveImagePreset,
  resolveModel,
  resolveSpeechPreset,
  resolveVideoPreset,
  type ImagePreset,
  type ModelDefinition,
  type Preset,
  type SpeechPreset,
  type VideoPreset,
} from "./domain/model-registry";
export {
  canonicalJson,
  fingerprintRequest,
  sha256OfFile,
  sha256Hex,
} from "./application/fingerprint";
export { PACKAGE_NAME, PACKAGE_VERSION, MINIMUM_NODE_VERSION } from "./version";
