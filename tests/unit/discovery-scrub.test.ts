import { describe, expect, it } from "vitest";
import { scrubPreviewUrls } from "../../src/cli/commands/discovery";

describe("discovery preview scrubbing", () => {
  it("drops signed query strings from preview URLs and keeps the rest intact", () => {
    const scrubbed = scrubPreviewUrls([
      {
        id: "m1",
        name: "Zoom In",
        previewUrl: "https://cdn.test/m1.mp4?token=abc123",
        startEndFrame: true,
      },
      { id: "m2", name: "Pan" },
    ]);

    expect(scrubbed[0]).toEqual({
      id: "m1",
      name: "Zoom In",
      previewUrl: "https://cdn.test/m1.mp4",
      startEndFrame: true,
    });
    expect(scrubbed[1]).toEqual({ id: "m2", name: "Pan" });
  });
});
