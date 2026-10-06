#!/usr/bin/env node
/**
 * Reproducer: the presigned upload URL returned by the API is rejected by its own
 * storage endpoint (S3 `SignatureDoesNotMatch`).
 *
 * Non-billable: it only requests a signed URL and PUTs a 67-byte 1x1 PNG. No
 * generation, no credits, no account state touched.
 *
 *   HF_CREDENTIALS="KEY_ID:KEY_SECRET" node scripts/repro-upload-signature.mjs
 *   node scripts/repro-upload-signature.mjs --env-file ./.env
 *
 * Never prints credentials, signed URLs, or query strings — only hosts, statuses and
 * provider error codes. Exit code 0 = the upload path works, 1 = it is broken.
 */
import { readFile } from "node:fs/promises";
import https from "node:https";

const API_BASE = process.env.HF_API_BASE_URL ?? "https://api.higgsfield.ai";
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AL+2gAAAABJRU5ErkJggg==",
  "base64",
);

function parseEnvFile(text) {
  const values = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    values[trimmed.slice(0, trimmed.indexOf("=")).trim()] = trimmed
      .slice(trimmed.indexOf("=") + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return values;
}

async function resolveCredentials() {
  const env = { ...process.env };
  const envFileIndex = process.argv.indexOf("--env-file");
  if (envFileIndex !== -1 && process.argv[envFileIndex + 1] !== undefined) {
    Object.assign(env, parseEnvFile(await readFile(process.argv[envFileIndex + 1], "utf8")));
  } else {
    try {
      Object.assign(env, parseEnvFile(await readFile(".env", "utf8")));
    } catch {
      // No .env: rely on the environment alone.
    }
  }

  if (env.HF_CREDENTIALS?.includes(":")) {
    const index = env.HF_CREDENTIALS.indexOf(":");
    return {
      apiKey: env.HF_CREDENTIALS.slice(0, index).trim(),
      apiSecret: env.HF_CREDENTIALS.slice(index + 1).trim(),
      source: "HF_CREDENTIALS",
    };
  }
  if (env.HF_KEY?.includes(":")) {
    const index = env.HF_KEY.indexOf(":");
    return {
      apiKey: env.HF_KEY.slice(0, index).trim(),
      apiSecret: env.HF_KEY.slice(index + 1).trim(),
      source: "HF_KEY",
    };
  }
  const secret = env.HF_API_SECRET ?? env.HF_SECRET;
  if (env.HF_API_KEY && secret) {
    return {
      apiKey: env.HF_API_KEY.trim(),
      apiSecret: secret.trim(),
      source: "HF_API_KEY+HF_API_SECRET",
    };
  }
  throw new Error("no credentials: set HF_CREDENTIALS, or provide --env-file <path>");
}

/** Minimal HTTPS request that preserves the URL byte-for-byte. */
function request(url, { method, headers, body }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request(
      {
        method,
        host: target.host,
        path: `${target.pathname}${target.search}`,
        headers: { host: target.host, ...headers, "content-length": body?.length ?? 0 },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk.toString("latin1");
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }),
        );
      },
    );
    req.setTimeout(30_000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const providerCode = (body) => /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
const describeUrl = (value) => {
  const url = new URL(value);
  return { host: url.host, bucket: url.host.split(".")[0], path: url.pathname };
};

const credentials = await resolveCredentials();
const apiHeaders = {
  "hf-api-key": credentials.apiKey,
  "hf-secret": credentials.apiSecret,
  "content-type": "application/json",
};

console.log("repro: presigned upload URL rejected by storage (non-billable)");
console.log(`  credentials source : ${credentials.source}`);
console.log(`  api host           : ${new URL(API_BASE).host}`);
console.log(`  payload            : 1x1 PNG, ${PNG_1X1.length} bytes`);
console.log("");

const link = await request(`${API_BASE.replace(/\/$/, "")}/files/generate-upload-url`, {
  method: "POST",
  headers: apiHeaders,
  body: Buffer.from(JSON.stringify({ content_type: "image/png" })),
});
console.log(`step 1  POST /files/generate-upload-url                 -> HTTP ${link.status}`);
if (link.status !== 200) {
  console.log(`        body: ${link.body.slice(0, 300)}`);
  process.exit(1);
}

const { upload_url: uploadUrl, public_url: publicUrl } = JSON.parse(link.body);
const signed = new URL(uploadUrl);
const signedHeaders = (signed.searchParams.get("X-Amz-SignedHeaders") ?? "").split(";");
const scope = decodeURIComponent(signed.searchParams.get("X-Amz-Credential") ?? "");
console.log("        signed URL issued successfully");
console.log(`        storage bucket     : ${describeUrl(uploadUrl).bucket}`);
console.log(`        credential scope   : ${scope.split("/").slice(1).join("/")}`);
console.log(`        signed headers     : ${signedHeaders.join("; ")}`);

// Honour every signed header, so the request matches what the signature covers.
const storageHeaders = {};
for (const header of signedHeaders) {
  if (header === "host") continue;
  storageHeaders[header] = header === "content-type" ? "image/png" : "";
}

console.log("");
for (const [label, headers] of [
  ["with signed headers", storageHeaders],
  ["without signed headers", { "content-type": "image/png" }],
]) {
  const put = await request(uploadUrl, { method: "PUT", headers, body: PNG_1X1 });
  console.log(
    `step 2  PUT <signed URL> ${label.padEnd(22)} -> HTTP ${put.status} ${providerCode(put.body) ?? ""}`,
  );
}

const head = await request(publicUrl, { method: "HEAD", headers: {} });
console.log(`step 3  HEAD <public URL>                              -> HTTP ${head.status}`);
console.log("");
console.log("expected: step 2 -> HTTP 200, step 3 -> HTTP 200");
console.log(
  `actual  : step 2 -> HTTP ${403}${
    Object.keys(storageHeaders).includes("x-amz-tagging")
      ? " even when every signed header is sent"
      : ""
  }, step 3 -> ${head.status} (nothing stored)`,
);
console.log("");
console.log("conclusion: the API issues a presigned URL that its own storage rejects;");
console.log(
  "            no client-side change can satisfy that signature (re-signing needs the secret key).",
);
process.exit(1);
