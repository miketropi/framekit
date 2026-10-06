import { InputAudio, InputImage, inputMotion } from "@higgsfield/client";
import {
  UUID_PATTERN,
  V1_DOP_MODELS,
  V1_SOUL_BATCHES,
  V1_SOUL_QUALITIES,
  V1_SOUL_SIZES,
  V1_SPEAK_DURATIONS,
  V1_SPEAK_QUALITIES,
} from "./models";
import { MAX_SEED } from "../../config/defaults";
import type { MotionPreset, StylePreset } from "../../domain/asset";
import { ToolError } from "../../domain/errors";
import type { ProviderGenerationRequest } from "../../domain/generation";
import { resolveModel } from "../../domain/model-registry";
import { ALLOWED_GENERIC_ENDPOINT_PREFIX } from "./endpoints";

/**
 * Semantic request → exact V1 fields (§4.2). This is the only module that knows
 * V1 parameter names and SDK helper enums.
 */

export interface MapperContext {
  motions: MotionPreset[];
  styles: StylePreset[];
}

export interface MappedGeneration {
  endpoint: string;
  params: Record<string, unknown>;
}

function assertKnownValue(field: string, value: unknown, allowed: readonly unknown[]): void {
  if (allowed.includes(value)) return;
  throw new ToolError({
    code: "VALIDATION_FAILED",
    message: `Unsupported ${field} "${String(value)}". Allowed values: ${allowed
      .map((entry) => String(entry))
      .join(", ")}.`,
    details: { field, value, allowed },
  });
}

function assertUnitInterval(field: string, value: number): void {
  if (Number.isFinite(value) && value >= 0 && value <= 1) return;
  throw new ToolError({
    code: "VALIDATION_FAILED",
    message: `${field} must be a number between 0 and 1 (received ${value}).`,
    details: { field, value },
  });
}

/**
 * Resolve a discovery reference case-insensitively: exact id first, then exact
 * name. Ambiguity is an error, never a silent pick.
 */
function resolveDiscoveryRef(
  kind: "motion" | "style",
  reference: string,
  items: readonly { id: string; name: string }[],
): { id: string; name: string } {
  const needle = reference.trim().toLowerCase();
  const byId = items.filter((item) => item.id.toLowerCase() === needle);
  const matches =
    byId.length > 0 ? byId : items.filter((item) => item.name.toLowerCase() === needle);

  if (matches.length === 1) return matches[0] as { id: string; name: string };

  if (matches.length === 0) {
    throw new ToolError({
      code: "VALIDATION_FAILED",
      message: `Unknown ${kind} "${reference}". Available ${kind}s: ${
        items.map((item) => item.id).join(", ") || "(none reported by the provider)"
      }.`,
      details: { kind, reference, candidates: items.map((item) => item.id) },
    });
  }

  throw new ToolError({
    code: "VALIDATION_FAILED",
    message: `Ambiguous ${kind} "${reference}" matches ${matches.length} entries: ${matches
      .map((item) => item.id)
      .join(", ")}. Pass the exact ${kind} id.`,
    details: { kind, reference, candidates: matches.map((item) => item.id) },
  });
}

export function resolveMotionRef(
  reference: string,
  motions: readonly MotionPreset[],
): MotionPreset {
  return resolveDiscoveryRef("motion", reference, motions) as MotionPreset;
}

export function resolveStyleRef(reference: string, styles: readonly StylePreset[]): StylePreset {
  return resolveDiscoveryRef("style", reference, styles) as StylePreset;
}

function endpointFor(logicalModel: string): string {
  const model = resolveModel(logicalModel);
  if (model === undefined || !model.enabled || model.endpoint === undefined) {
    throw new ToolError({
      code: "VALIDATION_FAILED",
      message: `Unknown or disabled logical model "${logicalModel}".`,
      details: { logicalModel },
    });
  }
  return model.endpoint;
}

function mapTextToImage(
  request: Extract<ProviderGenerationRequest, { capability: "text-to-image" }>,
  context: MapperContext,
): Record<string, unknown> {
  assertKnownValue("width_and_height", request.widthAndHeight, V1_SOUL_SIZES);
  assertKnownValue("quality", request.quality, V1_SOUL_QUALITIES);
  assertKnownValue("batch", request.batch, V1_SOUL_BATCHES);

  const params: Record<string, unknown> = {
    prompt: request.prompt,
    width_and_height: request.widthAndHeight,
    quality: request.quality,
    batch_size: request.batch,
  };

  if (request.seed !== undefined) {
    if (!Number.isInteger(request.seed) || request.seed < 0 || request.seed > MAX_SEED) {
      throw new ToolError({
        code: "VALIDATION_FAILED",
        message: `seed must be an integer between 0 and ${MAX_SEED} (received ${request.seed}).`,
        details: { seed: request.seed },
      });
    }
    params.seed = request.seed;
  }

  if (request.style !== undefined) {
    const style = resolveStyleRef(request.style, context.styles);
    params.style_id = style.id;
  }

  if (request.styleStrength !== undefined) {
    assertUnitInterval("style_strength", request.styleStrength);
    params.style_strength = request.styleStrength;
  }

  if (request.reference !== undefined) {
    // The only reference image field V1 exposes for Soul is its input image.
    params.input_image = InputImage.fromUrl(request.reference.url);
  }

  if (request.referenceStrength !== undefined) {
    assertUnitInterval("reference_strength", request.referenceStrength);
    params.custom_reference_strength = request.referenceStrength;
  }

  if (request.characterId !== undefined) {
    params.custom_reference_id = request.characterId;
  }

  return params;
}

function mapImageToVideo(
  request: Extract<ProviderGenerationRequest, { capability: "image-to-video" }>,
  context: MapperContext,
): Record<string, unknown> {
  assertKnownValue("model", request.model, V1_DOP_MODELS);
  if (request.inputImages.length === 0) {
    throw new ToolError({
      code: "VALIDATION_FAILED",
      message: "image-to-video requires at least one input image.",
    });
  }

  const params: Record<string, unknown> = {
    model: request.model,
    prompt: request.prompt,
    input_images: request.inputImages.map((image) => InputImage.fromUrl(image.url)),
  };

  if (request.motion !== undefined) {
    const motion = resolveMotionRef(request.motion, context.motions);
    // The API requires a motion UUID; discovery normally guarantees this, and the
    // check turns a provider 422 into a clear local validation error.
    if (!UUID_PATTERN.test(motion.id)) {
      throw new ToolError({
        code: "VALIDATION_FAILED",
        message: `Motion "${motion.name}" resolved to an id the API will not accept: ${motion.id} is not a UUID.`,
        details: { motion: motion.name, id: motion.id },
      });
    }
    const strength = request.motionStrength ?? 1;
    assertUnitInterval("motion_strength", strength);
    params.motions = [inputMotion(motion.id, strength)];
  }

  return params;
}

function mapSpeechToVideo(
  request: Extract<ProviderGenerationRequest, { capability: "speech-to-video" }>,
): Record<string, unknown> {
  assertKnownValue("quality", request.quality, V1_SPEAK_QUALITIES);
  assertKnownValue("duration", request.duration, V1_SPEAK_DURATIONS);

  return {
    input_image: InputImage.fromUrl(request.image.url),
    input_audio: InputAudio.fromUrl(request.audio.url),
    prompt: request.prompt,
    quality: request.quality,
    duration: request.duration,
  };
}

export function mapGenerationRequest(
  request: ProviderGenerationRequest,
  context: MapperContext = { motions: [], styles: [] },
): MappedGeneration {
  switch (request.capability) {
    case "text-to-image":
      return {
        endpoint: endpointFor(request.logicalModel),
        params: mapTextToImage(request, context),
      };
    case "image-to-video":
      return {
        endpoint: endpointFor(request.logicalModel),
        params: mapImageToVideo(request, context),
      };
    case "speech-to-video":
      return {
        endpoint: endpointFor(request.logicalModel),
        params: mapSpeechToVideo(request),
      };
    case "generic": {
      if (!request.endpoint.startsWith(ALLOWED_GENERIC_ENDPOINT_PREFIX)) {
        throw new ToolError({
          code: "VALIDATION_FAILED",
          message: `Generic endpoint must start with "${ALLOWED_GENERIC_ENDPOINT_PREFIX}" (received "${request.endpoint}").`,
          details: { endpoint: request.endpoint },
        });
      }
      return { endpoint: request.endpoint, params: request.params };
    }
    default: {
      // Exhaustiveness guard: a new capability must be mapped explicitly.
      const unreachable: never = request;
      throw new ToolError({
        code: "VALIDATION_FAILED",
        message: `Unsupported capability ${JSON.stringify(unreachable)}.`,
      });
    }
  }
}

/** True when the request needs discovery data to be mapped. */
export function requiresDiscovery(request: ProviderGenerationRequest): boolean {
  if (request.capability === "text-to-image") return request.style !== undefined;
  if (request.capability === "image-to-video") return request.motion !== undefined;
  return false;
}
