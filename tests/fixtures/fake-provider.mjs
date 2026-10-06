// Test-only MediaProvider used by the integration suite through
// HF_TEST_PROVIDER_MODULE. It serves real media bytes from a local HTTP server
// and records call counts in HF_FAKE_STATE so tests can assert "no resubmission".
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";

const { ToolError } = await import(new URL("../../dist/index.js", import.meta.url).href);

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AL+2gAAAABJRU5ErkJggg==",
  "base64",
);
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x20]),
  Buffer.from("ftypisom"),
  Buffer.alloc(48, 7),
]);

const scenario = process.env.HF_FAKE_SCENARIO ?? "image-completed";
const stateFile = process.env.HF_FAKE_STATE;
const transientDownloadFailures = Number(process.env.HF_FAKE_DOWNLOAD_FAILS ?? "0");
const motionsCallsBeforeSuccess = Number(process.env.HF_FAKE_MOTIONS_FAILS ?? "0");

function readState() {
  if (stateFile === undefined) return {};
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
}

function bump(key) {
  if (stateFile === undefined) return 0;
  const state = readState();
  state[key] = (state[key] ?? 0) + 1;
  writeFileSync(stateFile, JSON.stringify(state));
  return state[key];
}

let failedDownloads = 0;

// Responses close their socket explicitly: a pooled connection to this fixture
// must not keep the CLI process alive, because the command has to exit on its own.
const server = createServer((request, response) => {
  const send = (status, contentType, body) => {
    response.writeHead(status, { "content-type": contentType, connection: "close" });
    response.end(body);
    response.once("finish", () => request.socket.destroy());
  };

  const path = (request.url ?? "/").split("?")[0];
  if (path.startsWith("/flaky.png")) {
    bump("downloads");
    failedDownloads += 1;
    if (failedDownloads <= transientDownloadFailures) {
      send(500, "text/plain", "transient");
      return;
    }
    send(200, "image/png", PNG);
    return;
  }
  if (path.startsWith("/missing")) {
    bump("downloads");
    send(404, "text/plain", "gone");
    return;
  }
  if (path.startsWith("/wrong")) {
    bump("downloads");
    send(200, "video/mp4", MP4);
    return;
  }
  if (path.endsWith(".mp4") || path.includes("video")) {
    bump("downloads");
    send(200, "video/mp4", MP4);
    return;
  }
  if (path.startsWith("/images/") || path.endsWith(".png")) {
    bump("downloads");
    send(200, "image/png", PNG);
    return;
  }
  send(404, "text/plain", "unknown");
});

const ready = new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    // The media server must not keep the CLI process alive: when the command
    // finishes, outstanding work is done and the process has to exit by itself.
    server.unref();
    resolve(server.address().port);
  });
});

function throwScenarioError() {
  if (scenario === "auth-error") {
    throw new ToolError({ code: "AUTHENTICATION_FAILED", message: "fake: bad credentials" });
  }
  if (scenario === "credits-error") {
    throw new ToolError({ code: "INSUFFICIENT_CREDITS", message: "fake: no credits" });
  }
  if (scenario === "rate-limited") {
    throw new ToolError({ code: "RATE_LIMITED", message: "fake: rate limited", retryable: true });
  }
  if (scenario === "provider-down") {
    throw new ToolError({ code: "PROVIDER_UNAVAILABLE", message: "fake: provider down" });
  }
}

export async function createProvider() {
  const port = await ready;
  const origin = `http://127.0.0.1:${port}`;

  async function generate(request) {
    bump("generate");
    throwScenarioError();
    if (scenario === "image-completed") {
      const count = typeof request.batch === "number" ? request.batch : 1;
      return {
        requestId: "fake-request-1",
        status: "completed",
        assets: Array.from({ length: count }, (_value, index) => ({
          kind: "image",
          url: `${origin}/images/image-${index + 1}.png`,
        })),
      };
    }
    if (scenario === "missing-asset") {
      return {
        requestId: "fake-request-missing",
        status: "completed",
        assets: [{ kind: "image", url: `${origin}/missing.png` }],
      };
    }
    if (scenario === "wrong-kind") {
      return {
        requestId: "fake-request-wrong",
        status: "completed",
        assets: [{ kind: "image", url: `${origin}/wrong.mp4` }],
      };
    }
    if (scenario === "flaky-download") {
      return {
        requestId: "fake-request-flaky",
        status: "completed",
        assets: [{ kind: "image", url: `${origin}/flaky.png` }],
      };
    }
    if (scenario === "video-completed" || scenario === "generic-completed") {
      return {
        requestId: "fake-request-video",
        status: "completed",
        assets: [{ kind: "video", url: `${origin}/clip/video.mp4` }],
      };
    }
    if (scenario === "failed" || scenario === "nsfw" || scenario === "canceled") {
      return { requestId: "fake-request-terminal", status: scenario, assets: [] };
    }
    throw new ToolError({
      code: "UNKNOWN_PROVIDER_ERROR",
      message: `fake provider does not implement scenario "${scenario}"`,
    });
  }

  return {
    name: "higgsfield-v1",
    generate,
    async upload(request) {
      bump("upload");
      throwScenarioError();
      if (scenario === "upload-storage-rejected") {
        // Mirrors the real upstream failure: the API issues a signed URL that storage
        // rejects (S3 SignatureDoesNotMatch), which must never read as "no credits".
        throw new ToolError({
          code: "UPLOAD_FAILED",
          message:
            "Upload of " +
            request.filename +
            " was rejected by the provider's storage endpoint (HTTP 403, SignatureDoesNotMatch). " +
            "This is a storage-level rejection of the signed upload URL, not an account or credits problem.",
          details: { stage: "signed-url-put", status: 403, providerCode: "SignatureDoesNotMatch" },
          retryable: false,
        });
      }
      return {
        url: `https://cdn.test/${request.sha256}.png`,
        contentType: request.contentType,
        sha256: request.sha256,
        bytes: request.data.byteLength,
      };
    },
    async getStatus() {
      bump("status");
      return "in_progress";
    },
    async getStatusReport() {
      bump("status");
      if (scenario === "status-with-assets") {
        return {
          requestId: "fake-request-1",
          status: "completed",
          source: "request",
          assets: [{ kind: "video", url: `${origin}/clip/video.mp4?X-Amz-Signature=deadbeef` }],
        };
      }
      return { requestId: "fake-request-1", status: "in_progress", source: "job-set", assets: [] };
    },
    async listMotions() {
      const calls = bump("motions");
      if (calls <= motionsCallsBeforeSuccess) {
        throw new ToolError({ code: "PROVIDER_UNAVAILABLE", message: "fake: motions down" });
      }
      return [{ id: "motion-zoom", name: "Zoom In", description: "push in" }];
    },
    async listStyles() {
      bump("styles");
      return [{ id: "style-noir", name: "Noir Film" }];
    },
    async createCharacter(request) {
      bump("createCharacter");
      return { id: "soul-1", name: request.name, status: "completed" };
    },
    async listCharacters() {
      bump("listCharacters");
      return {
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
        items: [{ id: "soul-1", name: "Hero", status: "completed" }],
      };
    },
  };
}

export default createProvider;
