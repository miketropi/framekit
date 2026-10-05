import { createServer } from "node:http";
import type { Socket } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { createV1HttpClient } from "../../src/providers/higgsfield-v1/client";

/**
 * The provider's private status transport: `hf status` and the polling loop of an
 * already-paid job both depend on it never hanging, however the server behaves.
 */

const stalledSockets: Socket[] = [];

const server = createServer((request, response) => {
  const route = (request.url ?? "/").split("?")[0] ?? "/";
  if (route.includes("stall")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"jobs":');
    stalledSockets.push(request.socket);
    return;
  }
  if (route.includes("server-error")) {
    response.writeHead(503, { "content-type": "application/json" });
    response.end('{"detail":"down"}');
    return;
  }
  if (route.includes("unauthorized")) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end("{}");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ jobs: [{ id: "job-1", status: "completed" }] }));
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

function clientFor(port: number, timeoutMs = 150) {
  return createV1HttpClient({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: "test-api-key-0000000000",
    apiSecret: "test-api-secret-0000000000",
    timeoutMs,
  });
}

describe("V1 status transport", () => {
  it("reads a job set and JSON-parses the body", async () => {
    const port = await ready;
    await expect(clientFor(port).get("/v1/job-sets/set-1")).resolves.toMatchObject({
      status: 200,
      body: { jobs: [{ id: "job-1", status: "completed" }] },
    });
  });

  it("times out on a stalled body instead of hanging forever", async () => {
    const port = await ready;
    await expect(clientFor(port).get("/v1/job-sets/stall")).rejects.toMatchObject({
      code: "TIMEOUT",
      retryable: true,
    });
  }, 15_000);

  it("maps provider status codes to the taxonomy", async () => {
    const port = await ready;
    await expect(clientFor(port).get("/v1/job-sets/server-error")).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
    });
    await expect(clientFor(port).get("/v1/job-sets/unauthorized")).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
      retryable: false,
    });
  });
});
