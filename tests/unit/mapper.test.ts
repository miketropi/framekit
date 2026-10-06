import { describe, expect, it } from "vitest";
import {
  mapGenerationRequest,
  resolveMotionRef,
  resolveStyleRef,
} from "../../src/providers/higgsfield-v1/mapper";
import { ToolError } from "../../src/domain/errors";
import type { MotionPreset, StylePreset } from "../../src/domain/asset";

const ZOOM_ID = "fbcbec5b-30f8-4b17-ba6e-8e8d5b265562";
const PAN_ID = "81ca2cd2-05db-4222-9ba0-a32e5185adfb";
const motions: MotionPreset[] = [
  { id: ZOOM_ID, name: "Zoom In" },
  { id: PAN_ID, name: "Pan Left" },
  { id: "motion-dup-a", name: "Dolly" },
  { id: "motion-dup-b", name: "Dolly" },
];
const styles: StylePreset[] = [{ id: "style-noir", name: "Noir Film" }];

describe("motion and style resolution", () => {
  it("resolves by exact id first, then by name, case-insensitively", () => {
    expect(resolveMotionRef(ZOOM_ID, motions).id).toBe(ZOOM_ID);
    expect(resolveMotionRef("zoom in", motions).id).toBe(ZOOM_ID);
    expect(resolveMotionRef("Pan Left", motions).id).toBe(PAN_ID);
    expect(resolveStyleRef("noir film", styles).id).toBe("style-noir");
  });

  it("never silently chooses when a name is ambiguous", () => {
    try {
      resolveMotionRef(
        "Dolly",
        motions.filter((motion) => motion.name === "Dolly"),
      );
      throw new Error("expected ambiguity to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe("VALIDATION_FAILED");
      expect((error as ToolError).details).toMatchObject({
        candidates: ["motion-dup-a", "motion-dup-b"],
      });
    }
  });

  it("reports candidate ids when nothing matches", () => {
    try {
      resolveMotionRef("nope", motions);
      throw new Error("expected unknown motion to fail");
    } catch (error) {
      expect((error as ToolError).code).toBe("VALIDATION_FAILED");
      expect((error as ToolError).details).toMatchObject({
        candidates: [ZOOM_ID, PAN_ID, "motion-dup-a", "motion-dup-b"],
      });
    }
  });
});

describe("V1 request mapping", () => {
  it("maps Soul text-to-image fields and SDK helpers", () => {
    const mapped = mapGenerationRequest(
      {
        capability: "text-to-image",
        logicalModel: "soul-image",
        prompt: "Editorial portrait",
        preset: "portrait-hd",
        widthAndHeight: "1536x2048",
        quality: "1080p",
        batch: 1,
        seed: 42,
        style: "Noir Film",
        styleStrength: 0.5,
        reference: { kind: "image", url: "https://cdn.test/ref.png" },
        referenceStrength: 0.25,
        characterId: "soul-1",
      },
      { motions, styles },
    );

    expect(mapped.endpoint).toBe("/v1/text2image/soul");
    expect(mapped.params).toEqual({
      prompt: "Editorial portrait",
      width_and_height: "1536x2048",
      quality: "1080p",
      batch_size: 1,
      seed: 42,
      style_id: "style-noir",
      style_strength: 0.5,
      input_image: { type: "image_url", image_url: "https://cdn.test/ref.png" },
      custom_reference_strength: 0.25,
      custom_reference_id: "soul-1",
    });
  });

  it("maps DoP image-to-video fields including motions", () => {
    const mapped = mapGenerationRequest(
      {
        capability: "image-to-video",
        logicalModel: "dop-video",
        model: "dop-preview",
        prompt: "Slow dolly-in",
        preset: "cinematic",
        inputImages: [{ kind: "image", url: "https://cdn.test/keyframe.png" }],
        motion: "Zoom In",
        motionStrength: 0.8,
      },
      { motions, styles },
    );

    expect(mapped.endpoint).toBe("/v1/image2video/dop");
    expect(mapped.params).toEqual({
      model: "dop-preview",
      prompt: "Slow dolly-in",
      input_images: [{ type: "image_url", image_url: "https://cdn.test/keyframe.png" }],
      motions: [{ id: ZOOM_ID, strength: 0.8 }],
    });
  });

  it("maps Speak fields", () => {
    const mapped = mapGenerationRequest({
      capability: "speech-to-video",
      logicalModel: "speak-video",
      prompt: "Warm delivery",
      preset: "standard",
      image: { kind: "image", url: "https://cdn.test/face.png" },
      audio: { kind: "audio", url: "https://cdn.test/voice.wav" },
      quality: "mid",
      duration: 5,
    });

    expect(mapped.endpoint).toBe("/v1/speak/higgsfield");
    expect(mapped.params).toEqual({
      input_image: { type: "image_url", image_url: "https://cdn.test/face.png" },
      input_audio: { type: "audio_url", audio_url: "https://cdn.test/voice.wav" },
      prompt: "Warm delivery",
      quality: "mid",
      duration: 5,
    });
  });

  it("passes generic params through and enforces the /v1/ prefix", () => {
    const mapped = mapGenerationRequest({
      capability: "generic",
      logicalModel: "generic-v1",
      endpoint: "/v1/some/endpoint",
      params: { prompt: "x" },
    });
    expect(mapped).toEqual({ endpoint: "/v1/some/endpoint", params: { prompt: "x" } });

    expect(() =>
      mapGenerationRequest({
        capability: "generic",
        logicalModel: "generic-v1",
        endpoint: "/v2/other",
        params: {},
      }),
    ).toThrow(ToolError);
  });

  it("rejects values the V1 API cannot accept", () => {
    const base = {
      capability: "text-to-image" as const,
      logicalModel: "soul-image",
      prompt: "x",
      preset: "square-hd",
      widthAndHeight: "1536x1536",
      quality: "1080p",
      batch: 1 as const,
    };

    expect(() => mapGenerationRequest({ ...base, widthAndHeight: "100x100" })).toThrow(
      /Unsupported width_and_height/,
    );
    expect(() => mapGenerationRequest({ ...base, quality: "4k" })).toThrow(/Unsupported quality/);
    expect(() => mapGenerationRequest({ ...base, seed: 1_000_001 })).toThrow(
      /seed must be an integer/,
    );
    expect(() =>
      mapGenerationRequest({ ...base, style: "Noir Film", styleStrength: 2 }, { motions, styles }),
    ).toThrow(/style_strength must be a number between 0 and 1/);
    expect(() => mapGenerationRequest({ ...base, style: "missing" }, { motions, styles })).toThrow(
      /Unknown style "missing"/,
    );
    expect(() => mapGenerationRequest({ ...base, logicalModel: "nope" })).toThrow(
      /Unknown or disabled logical model/,
    );
    // `dop-standard` is what the published SDK enum offers; the API rejects it.
    expect(() =>
      mapGenerationRequest({
        capability: "image-to-video",
        logicalModel: "dop-video",
        model: "dop-standard",
        prompt: "x",
        preset: "cinematic",
        inputImages: [{ kind: "image", url: "https://cdn.test/a.png" }],
      }),
    ).toThrow(/Unsupported model/);
    expect(() =>
      mapGenerationRequest({
        capability: "image-to-video",
        logicalModel: "dop-video",
        model: "nope",
        prompt: "x",
        preset: "cinematic",
        inputImages: [{ kind: "image", url: "https://cdn.test/a.png" }],
      }),
    ).toThrow(/Unsupported model/);
  });
});
