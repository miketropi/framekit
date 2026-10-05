import type { Capability } from "./generation";
import type { ProviderName } from "./media-provider";

/**
 * Logical model registry (§9): agents name capabilities, never endpoint paths.
 * The registry is frozen; every resolver returns a copy so callers cannot
 * mutate shared state.
 */
export interface ModelDefinition {
  readonly id: string;
  readonly provider: ProviderName;
  readonly capability: Capability;
  /** V1 endpoint path. Absent for capability "generic", where the caller supplies it. */
  readonly endpoint?: string;
  readonly enabled: boolean;
  readonly defaults: Readonly<Record<string, unknown>>;
}

export interface ImagePreset {
  readonly name: string;
  readonly capability: "text-to-image";
  readonly logicalModel: string;
  readonly widthAndHeight: string;
  readonly quality: string;
  readonly batch: 1 | 4;
}

export interface VideoPreset {
  readonly name: string;
  readonly capability: "image-to-video";
  readonly logicalModel: string;
  /** Provider model parameter implied by the preset. */
  readonly model: string;
  readonly motionStrength: number;
}

export interface SpeechPreset {
  readonly name: string;
  readonly capability: "speech-to-video";
  readonly logicalModel: string;
  readonly quality: string;
  readonly duration: number;
}

export type Preset = ImagePreset | VideoPreset | SpeechPreset;

export const GENERIC_LOGICAL_MODEL = "generic-v1";

const MODEL_DEFINITIONS: Record<string, ModelDefinition> = {
  "soul-image": Object.freeze({
    id: "soul-image",
    provider: "higgsfield-v1",
    capability: "text-to-image",
    endpoint: "/v1/text2image/soul",
    enabled: true,
    defaults: Object.freeze({ quality: "1080p", batch: 1 }),
  }),
  "dop-video": Object.freeze({
    id: "dop-video",
    provider: "higgsfield-v1",
    capability: "image-to-video",
    endpoint: "/v1/image2video/dop",
    enabled: true,
    defaults: Object.freeze({ model: "dop-standard" }),
  }),
  "speak-video": Object.freeze({
    id: "speak-video",
    provider: "higgsfield-v1",
    capability: "speech-to-video",
    endpoint: "/v1/speak/higgsfield",
    enabled: true,
    defaults: Object.freeze({ quality: "mid", duration: 5 }),
  }),
  [GENERIC_LOGICAL_MODEL]: Object.freeze({
    id: GENERIC_LOGICAL_MODEL,
    provider: "higgsfield-v1",
    capability: "generic",
    enabled: true,
    defaults: Object.freeze({}),
  }),
};

const IMAGE_PRESETS: Record<string, ImagePreset> = {
  "square-hd": Object.freeze({
    name: "square-hd",
    capability: "text-to-image",
    logicalModel: "soul-image",
    widthAndHeight: "1536x1536",
    quality: "1080p",
    batch: 1,
  }),
  "portrait-hd": Object.freeze({
    name: "portrait-hd",
    capability: "text-to-image",
    logicalModel: "soul-image",
    widthAndHeight: "1536x2048",
    quality: "1080p",
    batch: 1,
  }),
  "landscape-hd": Object.freeze({
    name: "landscape-hd",
    capability: "text-to-image",
    logicalModel: "soul-image",
    widthAndHeight: "2048x1152",
    quality: "1080p",
    batch: 1,
  }),
};

const VIDEO_PRESETS: Record<string, VideoPreset> = {
  cinematic: Object.freeze({
    name: "cinematic",
    capability: "image-to-video",
    logicalModel: "dop-video",
    model: "dop-standard",
    motionStrength: 0.8,
  }),
};

const SPEECH_PRESETS: Record<string, SpeechPreset> = {
  standard: Object.freeze({
    name: "standard",
    capability: "speech-to-video",
    logicalModel: "speak-video",
    quality: "mid",
    duration: 5,
  }),
};

export function listModels(): ModelDefinition[] {
  return Object.values(MODEL_DEFINITIONS).map((model) => ({ ...model }));
}

export function resolveModel(id: string): ModelDefinition | undefined {
  const model = MODEL_DEFINITIONS[id];
  return model === undefined ? undefined : { ...model };
}

export function listImagePresets(): ImagePreset[] {
  return Object.values(IMAGE_PRESETS).map((preset) => ({ ...preset }));
}

export function listVideoPresets(): VideoPreset[] {
  return Object.values(VIDEO_PRESETS).map((preset) => ({ ...preset }));
}

export function listSpeechPresets(): SpeechPreset[] {
  return Object.values(SPEECH_PRESETS).map((preset) => ({ ...preset }));
}

export function resolveImagePreset(name: string): ImagePreset | undefined {
  const preset = IMAGE_PRESETS[name];
  return preset === undefined ? undefined : { ...preset };
}

export function resolveVideoPreset(name: string): VideoPreset | undefined {
  const preset = VIDEO_PRESETS[name];
  return preset === undefined ? undefined : { ...preset };
}

export function resolveSpeechPreset(name: string): SpeechPreset | undefined {
  const preset = SPEECH_PRESETS[name];
  return preset === undefined ? undefined : { ...preset };
}

export const IMAGE_PRESET_NAMES: readonly string[] = Object.keys(IMAGE_PRESETS);
export const VIDEO_PRESET_NAMES: readonly string[] = Object.keys(VIDEO_PRESETS);
export const SPEECH_PRESET_NAMES: readonly string[] = Object.keys(SPEECH_PRESETS);
