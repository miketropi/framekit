import {
  APIError,
  AuthenticationError,
  NotEnoughCreditsError,
  TimeoutError,
  ValidationError,
} from "@higgsfield/client";
import { describe, expect, it } from "vitest";
import { buildProvider } from "../helpers/provider";
import { callsOf } from "../helpers/fakes";
import type { TextToImageProviderRequest } from "../../src/domain/generation";

const request: TextToImageProviderRequest = {
  capability: "text-to-image",
  logicalModel: "soul-image",
  prompt: "Editorial portrait",
  preset: "portrait-hd",
  widthAndHeight: "1536x2048",
  quality: "1080p",
  batch: 1,
  seed: 7,
};

function jobSet(jobs: { id: string; status: string; results?: unknown }[]) {
  return { id: "set-1", jobs };
}

describe("generation submission", () => {
  it("submits exactly once without SDK polling and normalizes a completed job", async () => {
    const harness = buildProvider({
      generate: async () =>
        jobSet([
          {
            id: "job-1",
            status: "completed",
            results: { raw: { url: "https://cdn.test/image-01.png", type: "image" } },
          },
        ]),
    });

    const result = await harness.provider.generate(request);

    expect(result).toEqual({
      requestId: "set-1",
      status: "completed",
      assets: [{ kind: "image", url: "https://cdn.test/image-01.png" }],
    });
    const generateCalls = callsOf(harness.clients.calls, "generate");
    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]?.args[0]).toBe("/v1/text2image/soul");
    expect(generateCalls[0]?.args[1]).toMatchObject({ batch_size: 1, seed: 7 });
  });

  it("polls the V1 job set until the aggregate status is terminal", async () => {
    let statusCalls = 0;
    const harness = buildProvider({
      generate: async () => jobSet([{ id: "job-1", status: "in_progress" }]),
      httpGet: async () => {
        statusCalls += 1;
        return statusCalls < 2
          ? { status: 200, body: { jobs: [{ id: "job-1", status: "queued" }] } }
          : {
              status: 200,
              body: {
                jobs: [
                  {
                    id: "job-1",
                    status: "completed",
                    results: { raw: { url: "https://cdn.test/image-01.png", type: "image" } },
                  },
                ],
              },
            };
      },
    });

    const result = await harness.provider.generate(request);

    expect(result.status).toBe("completed");
    expect(callsOf(harness.clients.calls, "httpGet")).toHaveLength(2);
    expect(harness.sleeper.delays).toEqual([100, 100]);
  });

  it("maps failed, nsfw, and canceled job sets to their error codes", async () => {
    const scenarios: { status: string; code: string }[] = [
      { status: "failed", code: "GENERATION_FAILED" },
      { status: "nsfw", code: "MODERATION_REJECTED" },
      { status: "canceled", code: "CANCELED" },
    ];

    for (const scenario of scenarios) {
      const harness = buildProvider({
        generate: async () => jobSet([{ id: "job-1", status: scenario.status }]),
      });
      await expect(harness.provider.generate(request)).rejects.toMatchObject({
        code: scenario.code,
        requestId: "set-1",
      });
    }
  });

  it("treats a failure in any job as a failure of the whole set", async () => {
    const harness = buildProvider({
      generate: async () =>
        jobSet([
          {
            id: "job-1",
            status: "completed",
            results: { raw: { url: "https://cdn.test/image-01.png", type: "image" } },
          },
          { id: "job-2", status: "failed" },
        ]),
    });

    await expect(harness.provider.generate(request)).rejects.toMatchObject({
      code: "GENERATION_FAILED",
    });
  });

  it("fails when a completed job carries no result URL", async () => {
    const harness = buildProvider({
      generate: async () => jobSet([{ id: "job-1", status: "completed", results: null }]),
    });

    await expect(harness.provider.generate(request)).rejects.toMatchObject({
      code: "GENERATION_FAILED",
    });
  });

  it("reports an unknown provider status instead of guessing", async () => {
    const harness = buildProvider({
      generate: async () => jobSet([{ id: "job-1", status: "teleported" }]),
    });

    await expect(harness.provider.generate(request)).rejects.toMatchObject({
      code: "UNKNOWN_PROVIDER_ERROR",
    });
  });

  it("keeps the request id on a polling timeout and marks it resumable", async () => {
    const harness = buildProvider({
      generate: async () => jobSet([{ id: "job-1", status: "queued" }]),
      httpGet: async () => ({
        status: 200,
        body: { jobs: [{ id: "job-1", status: "in_progress" }] },
      }),
    });

    await expect(harness.provider.generate(request)).rejects.toMatchObject({
      code: "TIMEOUT",
      retryable: true,
      requestId: "set-1",
    });
  });

  it("never claims resumability when the submission outcome is unknown", async () => {
    const harness = buildProvider({
      generate: async () => {
        throw new TimeoutError("submission timed out");
      },
    });

    await expect(harness.provider.generate(request)).rejects.toMatchObject({
      code: "TIMEOUT",
      retryable: false,
      requestId: undefined,
    });
    expect(callsOf(harness.clients.calls, "generate")).toHaveLength(1);
  });

  it("never advertises an ambiguous submission as retryable", async () => {
    const transient = buildProvider({
      generate: async () => {
        throw new APIError("gateway exploded", 503, {});
      },
    });
    await expect(transient.provider.generate(request)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retryable: false,
    });
    expect(callsOf(transient.clients.calls, "generate")).toHaveLength(1);

    const socket = buildProvider({
      generate: async () => {
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      },
    });
    await expect(socket.provider.generate(request)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retryable: false,
    });
    expect(callsOf(socket.clients.calls, "generate")).toHaveLength(1);
  });

  it("keeps the request id when polling fails after a paid submission", async () => {
    const harness = buildProvider({
      generate: async () => jobSet([{ id: "job-1", status: "in_progress" }]),
      httpGet: async () => {
        throw new APIError("status backend down", 503, {});
      },
    });

    await expect(harness.provider.generate(request)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      requestId: "set-1",
    });
  });

  it("keeps polling while the job set is still empty", async () => {
    let statusCalls = 0;
    const harness = buildProvider({
      generate: async () => jobSet([]),
      httpGet: async () => {
        statusCalls += 1;
        return statusCalls < 3
          ? { status: 200, body: { jobs: [] } }
          : {
              status: 200,
              body: {
                jobs: [
                  {
                    id: "job-1",
                    status: "completed",
                    results: { raw: { url: "https://cdn.test/image-01.png", type: "image" } },
                  },
                ],
              },
            };
      },
    });

    const result = await harness.provider.generate(request);
    expect(result.status).toBe("completed");
    expect(statusCalls).toBe(3);
  });

  it("does not retry a rejected submission", async () => {
    const harness = buildProvider({
      generate: async () => {
        throw new AuthenticationError("bad key");
      },
    });

    await expect(harness.provider.generate(request)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
      retryable: false,
    });
    expect(callsOf(harness.clients.calls, "generate")).toHaveLength(1);
  });

  it("maps credit and validation rejections without retrying", async () => {
    const credits = buildProvider({
      generate: async () => {
        throw new NotEnoughCreditsError();
      },
    });
    await expect(credits.provider.generate(request)).rejects.toMatchObject({
      code: "INSUFFICIENT_CREDITS",
    });
    expect(callsOf(credits.clients.calls, "generate")).toHaveLength(1);

    const validation = buildProvider({
      generate: async () => {
        throw new ValidationError([
          { type: "int_parsing", loc: ["body", "params"], msg: "bad seed" },
        ]);
      },
    });
    await expect(validation.provider.generate(request)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(callsOf(validation.clients.calls, "generate")).toHaveLength(1);
  });
});

describe("status inspection", () => {
  it("normalizes statuses and retries only safe failures", async () => {
    let attempts = 0;
    const harness = buildProvider({
      httpGet: async () => {
        attempts += 1;
        if (attempts === 1) throw new APIError("server exploded", 500, {});
        if (attempts === 2) throw new APIError("slow down", 429, {});
        return { status: 200, body: { jobs: [{ id: "job-1", status: "completed" }] } };
      },
    });

    await expect(harness.provider.getStatus("set-1")).resolves.toBe("completed");
    expect(attempts).toBe(3);
    expect(callsOf(harness.clients.calls, "httpGet")[0]?.args[0]).toBe("/v1/job-sets/set-1");
  });

  it("classifies transport failures by code", async () => {
    const aborted = buildProvider({
      httpGet: async () => {
        throw Object.assign(new Error("timeout of 120000ms exceeded"), { code: "ECONNABORTED" });
      },
    });
    await expect(aborted.provider.getStatus("set-1")).rejects.toMatchObject({ code: "TIMEOUT" });

    const closed = buildProvider({
      httpGet: async () => {
        throw Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
      },
    });
    await expect(closed.provider.getStatus("set-1")).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });

  it("does not retry authentication failures", async () => {
    let attempts = 0;
    const harness = buildProvider({
      httpGet: async () => {
        attempts += 1;
        throw new APIError("nope", 401, {});
      },
    });

    await expect(harness.provider.getStatus("set-1")).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
      retryable: false,
    });
    expect(attempts).toBe(1);
  });

  it("reports the job-set route with its result URLs", async () => {
    const harness = buildProvider({
      httpGet: async () => ({
        status: 200,
        body: {
          jobs: [
            {
              id: "job-1",
              status: "completed",
              results: { raw: { url: "https://cdn.test/video.mp4", type: "video" } },
            },
          ],
        },
      }),
    });

    await expect(harness.provider.getStatusReport("set-1")).resolves.toEqual({
      requestId: "set-1",
      status: "completed",
      source: "job-set",
      assets: [{ kind: "video", url: "https://cdn.test/video.mp4" }],
    });
  });

  it("falls back to the v2 request route when no job set exists, and surfaces its URLs", async () => {
    const harness = buildProvider({
      httpGet: async (path, auth) => {
        if (path.startsWith("/v1/job-sets/")) throw new APIError("not found", 404, {});
        expect(auth).toBe("v2");
        return {
          status: 200,
          body: {
            status: "completed",
            request_id: "req-1",
            images: [{ url: "https://cdn.test/frame.png" }],
            video: { url: "https://cdn.test/clip.mp4" },
          },
        };
      },
    });

    await expect(harness.provider.getStatusReport("req-1")).resolves.toEqual({
      requestId: "req-1",
      status: "completed",
      source: "request",
      assets: [
        { kind: "image", url: "https://cdn.test/frame.png" },
        { kind: "video", url: "https://cdn.test/clip.mp4" },
      ],
    });
    const routes = callsOf(harness.clients.calls, "httpGet");
    expect(routes.map((call) => call.args[0])).toEqual([
      "/v1/job-sets/req-1",
      "/requests/req-1/status",
    ]);
    expect(routes[1]?.args[1]).toBe("v2");
  });

  it("names both routes when a request id exists in neither", async () => {
    const harness = buildProvider({
      httpGet: async () => {
        throw new APIError("not found", 404, {});
      },
    });

    await expect(harness.provider.getStatusReport("req-gone")).rejects.toMatchObject({
      code: "UNKNOWN_PROVIDER_ERROR",
      details: {
        requestId: "req-gone",
        routes: ["/v1/job-sets/req-gone", "/requests/req-gone/status"],
      },
    });
  });

  it("rejects an unknown status from the v2 route", async () => {
    const harness = buildProvider({
      httpGet: async (path) =>
        path.startsWith("/v1/job-sets/")
          ? Promise.reject(new APIError("not found", 404, {}))
          : { status: 200, body: { status: "teleported" } },
    });

    await expect(harness.provider.getStatusReport("req-1")).rejects.toMatchObject({
      code: "UNKNOWN_PROVIDER_ERROR",
    });
  });

  it("surfaces an unknown status from the status route", async () => {
    const harness = buildProvider({
      httpGet: async () => ({ status: 200, body: { jobs: [{ id: "job-1", status: "weird" }] } }),
    });

    await expect(harness.provider.getStatus("set-1")).rejects.toMatchObject({
      code: "UNKNOWN_PROVIDER_ERROR",
    });
  });

  it("rejects an unexpected payload shape", async () => {
    const harness = buildProvider({
      httpGet: async () => ({ status: 200, body: { unexpected: true } }),
    });

    await expect(harness.provider.getStatus("set-1")).rejects.toMatchObject({
      code: "UNKNOWN_PROVIDER_ERROR",
    });
  });
});

describe("discovery and characters", () => {
  it("normalizes motions and styles", async () => {
    const harness = buildProvider({
      motions: async () => [
        {
          id: "m1",
          name: "Zoom In",
          description: "push in",
          preview_url: "https://p/m1",
          start_end_frame: true,
        },
      ],
      styles: async () => [
        { id: "s1", name: "Noir", description: "dark", preview_url: "https://p/s1" },
      ],
    });

    await expect(harness.provider.listMotions()).resolves.toEqual([
      {
        id: "m1",
        name: "Zoom In",
        description: "push in",
        previewUrl: "https://p/m1",
        startEndFrame: true,
      },
    ]);
    await expect(harness.provider.listStyles()).resolves.toEqual([
      { id: "s1", name: "Noir", description: "dark", previewUrl: "https://p/s1" },
    ]);
  });

  it("retries safe discovery failures but not validation failures", async () => {
    let attempts = 0;
    const flaky = buildProvider({
      motions: async () => {
        attempts += 1;
        if (attempts < 3) throw new APIError("boom", 503, {});
        return [{ id: "m1", name: "Zoom" }];
      },
    });
    await expect(flaky.provider.listMotions()).resolves.toHaveLength(1);
    expect(attempts).toBe(3);

    const bad = buildProvider({
      motions: async () => {
        attempts += 1;
        throw new ValidationError("malformed");
      },
    });
    const before = attempts;
    await expect(bad.provider.listMotions()).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(attempts).toBe(before + 1);
  });

  it("creates character references with SDK image inputs", async () => {
    const harness = buildProvider({
      createSoulId: async () => ({ id: "soul-1", name: "Hero", status: "completed" }),
    });

    const character = await harness.provider.createCharacter({
      name: "Hero",
      images: [
        { kind: "image", url: "https://cdn.test/a.png" },
        { kind: "image", url: "https://cdn.test/b.png" },
      ],
    });

    expect(character).toEqual({ id: "soul-1", name: "Hero", status: "completed" });
    const call = callsOf(harness.clients.calls, "createSoulId")[0];
    expect(call?.args[0]).toEqual({
      name: "Hero",
      input_images: [
        { type: "image_url", image_url: "https://cdn.test/a.png" },
        { type: "image_url", image_url: "https://cdn.test/b.png" },
      ],
    });
    expect(call?.args[1]).toBe(true);
  });

  it("rejects character references outside the 1-4 image range", async () => {
    const harness = buildProvider({
      createSoulId: async () => ({ id: "soul-1", name: "Hero", status: "completed" }),
    });

    await expect(
      harness.provider.createCharacter({ name: "Hero", images: [] }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(
      harness.provider.createCharacter({
        name: "Hero",
        images: Array.from({ length: 5 }, (_value, index) => ({
          kind: "image" as const,
          url: `https://cdn.test/${index}.png`,
        })),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(callsOf(harness.clients.calls, "createSoulId")).toHaveLength(0);
  });

  it("maps character listing pages and validates paging", async () => {
    const harness = buildProvider({
      listSoulIds: async (page, pageSize) => ({
        total: 3,
        page,
        page_size: pageSize,
        total_pages: 1,
        items: [{ id: "soul-1", name: "Hero", status: "in_progress" }],
      }),
    });

    await expect(harness.provider.listCharacters(2, 5)).resolves.toEqual({
      total: 3,
      page: 2,
      pageSize: 5,
      totalPages: 1,
      items: [{ id: "soul-1", name: "Hero", status: "in_progress" }],
    });
    await expect(harness.provider.listCharacters(0, 5)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(harness.provider.listCharacters(1, 101)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });
});

describe("uploads", () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

  it("retries a rate-limited upload of an image through the image helper", async () => {
    let attempts = 0;
    const harness = buildProvider({
      uploadImage: async () => {
        attempts += 1;
        if (attempts === 1) throw new APIError("slow down", 429, {});
        return "https://cdn.test/uploaded.png";
      },
    });

    const uploaded = await harness.provider.upload({
      data: bytes,
      contentType: "image/png",
      filename: "ref.png",
      sha256: "a".repeat(64),
    });

    expect(uploaded.url).toBe("https://cdn.test/uploaded.png");
    expect(attempts).toBe(2);
    expect(callsOf(harness.clients.calls, "uploadImage")[0]?.args[0]).toBe("png");
  });

  it("uses the generic upload call for audio and stops on auth failures", async () => {
    let attempts = 0;
    const harness = buildProvider({
      upload: async (_data, contentType) => {
        attempts += 1;
        expect(contentType).toBe("audio/wav");
        throw new AuthenticationError("bad key");
      },
    });

    await expect(
      harness.provider.upload({
        data: bytes,
        contentType: "audio/wav",
        filename: "voice.wav",
        sha256: "b".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(attempts).toBe(1);
  });

  it("fails when the provider returns an unusable URL", async () => {
    const harness = buildProvider({ uploadImage: async () => "" });

    await expect(
      harness.provider.upload({
        data: bytes,
        contentType: "image/png",
        filename: "ref.png",
        sha256: "c".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_FAILED" });
  });
});
