import { createServer } from "node:http";
import type { Socket } from "node:net";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AssetStore, outputFilename } from "../../src/storage/asset-store";

/**
 * Download limits and finalization. A stalled body must abort on the request
 * deadline, and no partial file may survive a failure.
 */

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AL+2gAAAABJRU5ErkJggg==",
  "base64",
);
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x20]),
  Buffer.from("ftypisom"),
  Buffer.alloc(48, 7),
]);

const stalledSockets: Socket[] = [];

const server = createServer({ keepAlive: false }, (request, response) => {
  const route = (request.url ?? "/").split("?")[0] ?? "/";
  if (route === "/stall.png") {
    // Headers arrive, the body never completes.
    response.writeHead(200, { "content-type": "image/png" });
    response.write(PNG_1PX.subarray(0, 8));
    stalledSockets.push(request.socket);
    return;
  }
  if (route === "/slow.png") {
    // Trickles one byte every 40ms for ~400ms: slower than the stall timeout in
    // total, but never idle for that long.
    response.writeHead(200, { "content-type": "image/png" });
    response.write(PNG_1PX.subarray(0, 8));
    let sent = 8;
    const trickle = setInterval(() => {
      if (sent >= PNG_1PX.byteLength) {
        clearInterval(trickle);
        response.end();
        return;
      }
      response.write(PNG_1PX.subarray(sent, sent + 1));
      sent += 1;
    }, 40);
    request.socket.on("close", () => clearInterval(trickle));
    return;
  }
  if (route === "/big.png") {
    const payload = Buffer.alloc(64 * 1024, 3);
    response.writeHead(200, {
      "content-type": "image/png",
      "content-length": String(payload.byteLength),
    });
    response.end(payload);
    return;
  }
  if (route.endsWith(".mp4")) {
    response.writeHead(200, { "content-type": "video/mp4" });
    response.end(MP4);
    return;
  }
  response.writeHead(200, { "content-type": "image/png" });
  response.end(PNG_1PX);
});

const ready = new Promise<number>((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    server.unref();
    resolve((server.address() as { port: number }).port);
  });
});

afterAll(async () => {
  for (const socket of stalledSockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("asset store downloads", () => {
  it("aborts a stalled body on the request deadline and removes the partial file", async () => {
    const port = await ready;
    const directory = await mkdtemp(path.join(tmpdir(), "hf-assets-"));
    const store = new AssetStore({ timeoutMs: 150 });

    await expect(
      store.download({
        url: `http://127.0.0.1:${port}/stall.png`,
        kind: "image",
        directory,
        filename: "image-01.png",
      }),
    ).rejects.toMatchObject({ code: "DOWNLOAD_FAILED", retryable: true });

    expect(await readdir(directory)).toEqual([]);
  }, 15_000);

  it("allows a slow but progressing transfer that outlasts the stall timeout", async () => {
    const port = await ready;
    const directory = await mkdtemp(path.join(tmpdir(), "hf-assets-"));
    const store = new AssetStore({ timeoutMs: 150 });

    const result = await store.download({
      url: `http://127.0.0.1:${port}/slow.png`,
      kind: "image",
      directory,
      filename: "image-01.png",
    });

    expect(result.bytes).toBe(PNG_1PX.byteLength);
    expect(await readdir(directory)).toEqual(["image-01.png"]);
  }, 15_000);

  it("enforces the size ceiling and finalizes successful downloads atomically", async () => {
    const port = await ready;
    const directory = await mkdtemp(path.join(tmpdir(), "hf-assets-"));

    const tooLarge = new AssetStore({ maxBytes: 1_024 });
    await expect(
      tooLarge.download({
        url: `http://127.0.0.1:${port}/big.png`,
        kind: "image",
        directory,
        filename: "image-01.png",
      }),
    ).rejects.toMatchObject({ code: "DOWNLOAD_FAILED", retryable: false });
    expect(await readdir(directory)).toEqual([]);

    const store = new AssetStore();
    const result = await store.download({
      url: `http://127.0.0.1:${port}/image.png`,
      kind: "image",
      directory,
      filename: "image-01.png",
    });

    expect(result).toMatchObject({ filename: "image-01.png", bytes: PNG_1PX.byteLength });
    expect(result.mimeType).toBe("image/png");
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await readdir(directory)).toEqual(["image-01.png"]);
  }, 15_000);

  it("names outputs from the remote URL when the extension is recognized", async () => {
    const port = await ready;
    const directory = await mkdtemp(path.join(tmpdir(), "hf-assets-"));
    const store = new AssetStore();

    const result = await store.download({
      url: `http://127.0.0.1:${port}/clip.mp4`,
      kind: "video",
      directory,
      filename: "video.mp4",
    });

    expect(result.filename).toBe("video.mp4");
    expect(result.mimeType).toBe("video/mp4");
    expect(await readdir(directory)).toEqual(["video.mp4"]);
  }, 15_000);
});

describe("output naming", () => {
  it("numbers images and uses the remote extension only when it is plausible", () => {
    expect(outputFilename("image", 1, "https://cdn.test/a.png")).toBe("image-01.png");
    expect(outputFilename("image", 12, "https://cdn.test/a.jpeg")).toBe("image-12.jpg");
    expect(outputFilename("image", 1, "https://cdn.test/a.mp4")).toBe("image-01.png");
    expect(outputFilename("image", 1, "not-a-url")).toBe("image-01.png");
    expect(outputFilename("video", 1, "https://cdn.test/video.mp4")).toBe("video.mp4");
    expect(outputFilename("video", 1, "https://cdn.test/clip.webm")).toBe("video.webm");
    expect(outputFilename("audio", 1, "https://cdn.test/voice.wav")).toBe("audio.wav");
  });
});
