import { describe, expect, it } from "vitest";
import {
  V1_DOP_MODELS,
  V1_SOUL_BATCHES,
  V1_SOUL_QUALITIES,
  V1_SOUL_SIZES,
  V1_SPEAK_DURATIONS,
  V1_SPEAK_QUALITIES,
} from "../../src/providers/higgsfield-v1/models";
import {
  GENERIC_LOGICAL_MODEL,
  IMAGE_PRESET_NAMES,
  listImagePresets,
  listModels,
  listSpeechPresets,
  resolveImagePreset,
  resolveModel,
  resolveSpeechPreset,
  resolveVideoPreset,
  listVideoPresets,
  VIDEO_PRESET_NAMES,
} from "../../src/domain/model-registry";

describe("model registry", () => {
  it("maps logical models to V1 endpoints and keeps them frozen", () => {
    expect(resolveModel("soul-image")?.endpoint).toBe("/v1/text2image/soul");
    expect(resolveModel("dop-video")?.endpoint).toBe("/v1/image2video/dop");
    expect(resolveModel("speak-video")?.endpoint).toBe("/v1/speak/higgsfield");
    expect(resolveModel(GENERIC_LOGICAL_MODEL)?.capability).toBe("generic");

    const model = resolveModel("soul-image");
    expect(model).toBeDefined();
    expect(Object.isFrozen(listModels()[0])).toBe(false);
    // Resolvers hand out copies: mutating the copy must not touch the registry.
    // Cast is deliberate — ModelDefinition is readonly by contract, and this
    // asserts the returned copy is detached from the frozen source.
    const mutableCopy = model as { enabled: boolean };
    mutableCopy.enabled = false;
    expect(resolveModel("soul-image")?.enabled).toBe(true);
  });

  it("resolves the documented presets", () => {
    expect(IMAGE_PRESET_NAMES).toEqual(["square-hd", "portrait-hd", "landscape-hd"]);
    expect(VIDEO_PRESET_NAMES).toEqual(["cinematic"]);

    expect(resolveImagePreset("portrait-hd")).toMatchObject({
      widthAndHeight: "1536x2048",
      quality: "1080p",
      batch: 1,
    });
    expect(resolveVideoPreset("cinematic")).toMatchObject({
      logicalModel: "dop-video",
      model: "dop-turbo",
      motionStrength: 0.8,
    });
    expect(resolveSpeechPreset("standard")).toMatchObject({ quality: "mid", duration: 5 });

    // Guard against SDK enums drifting from the API again (dop-standard did).
    for (const preset of listVideoPresets()) {
      expect(V1_DOP_MODELS).toContain(preset.model);
    }
    for (const preset of listImagePresets()) {
      expect(V1_SOUL_SIZES).toContain(preset.widthAndHeight);
      expect(V1_SOUL_QUALITIES).toContain(preset.quality);
      expect(V1_SOUL_BATCHES).toContain(preset.batch);
    }
    for (const preset of listSpeechPresets()) {
      expect(V1_SPEAK_QUALITIES).toContain(preset.quality);
      expect(V1_SPEAK_DURATIONS).toContain(preset.duration);
    }

    expect(resolveImagePreset("nope")).toBeUndefined();
    expect(resolveVideoPreset("nope")).toBeUndefined();
    expect(resolveSpeechPreset("nope")).toBeUndefined();
  });
});
