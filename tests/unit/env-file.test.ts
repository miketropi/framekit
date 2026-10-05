import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_ENV_FILE, ENV_FILE_VARIABLE, loadEnvFileInto } from "../../src/cli/env-file";
import { type ToolError } from "../../src/domain/errors";
import { loadConfig, requireCredentials } from "../../src/config/env";

/**
 * `.env` loading. The loader writes through Node's own parser, so these tests use
 * the real process environment and clean up the keys they add.
 */

const touchedKeys: string[] = [];

function track(key: string, value: string): void {
  process.env[key] = value;
  touchedKeys.push(key);
}

afterEach(() => {
  for (const key of touchedKeys.splice(0)) delete process.env[key];
});

async function writeEnvFile(
  contents: string,
  name = DEFAULT_ENV_FILE,
): Promise<{ cwd: string; file: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "hf-envfile-"));
  const file = path.join(cwd, name);
  await writeFile(file, contents);
  return { cwd, file };
}

describe("env file loading", () => {
  it("loads a default .env from the working directory", async () => {
    const { cwd, file } = await writeEnvFile(
      'HF_CREDENTIALS="key-id-0000000000:key-secret-0000000000"\n',
    );
    const env: Record<string, string | undefined> = {};

    const result = loadEnvFileInto({ cwd, env });

    expect(result).toEqual({ loaded: true, path: file, variables: 1 });
    expect(env.HF_CREDENTIALS).toBe("key-id-0000000000:key-secret-0000000000");
    expect(requireCredentials(loadConfig({ env: env as Record<string, string> }))).toEqual({
      apiKey: "key-id-0000000000",
      apiSecret: "key-secret-0000000000",
    });
    delete process.env.HF_CREDENTIALS;
  });

  it("treats a missing default file as normal but a missing explicit file as an error", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "hf-envfile-"));
    expect(loadEnvFileInto({ cwd, env: {} })).toEqual({
      loaded: false,
      path: path.join(cwd, DEFAULT_ENV_FILE),
      variables: 0,
    });

    const explicit = (() => {
      try {
        loadEnvFileInto({ cwd, env: {}, explicitPath: "secrets/dev.env" });
        return undefined;
      } catch (error) {
        return error as ToolError;
      }
    })();
    expect(explicit).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(explicit?.message).toContain(ENV_FILE_VARIABLE);
  });

  it("lets an exported variable win over the same key in the file", async () => {
    const { cwd } = await writeEnvFile("HF_CREDENTIALS=malformed-file-value-without-colon\n");
    track("HF_CREDENTIALS", "exported-key-0000000000:exported-secret-0000000000");
    // The CLI passes process.env itself, so a real export is present in both.
    const env: Record<string, string | undefined> = process.env;

    const result = loadEnvFileInto({ cwd, env });

    // The malformed file value is never adopted, so it cannot break a session that
    // already exports valid credentials.
    expect(result.variables).toBe(0);
    expect(env.HF_CREDENTIALS).toBe("exported-key-0000000000:exported-secret-0000000000");
    expect(JSON.stringify(env)).not.toContain("malformed-file-value");
    expect(requireCredentials(loadConfig({ env }))).toEqual({
      apiKey: "exported-key-0000000000",
      apiSecret: "exported-secret-0000000000",
    });
    delete process.env.HF_CREDENTIALS;
  });

  it("counts only the variables it adds and understands dotenv quoting", async () => {
    const { cwd } = await writeEnvFile(
      [
        "# comment",
        "",
        "HF_PROVIDER=higgsfield-v1",
        'HF_CREDENTIALS="key-id-0000000000:key-secret-0000000000"',
        "HF_CACHE_ROOT='/tmp/quoted cache'",
      ].join("\n"),
    );
    const env: Record<string, string | undefined> = {};

    const result = loadEnvFileInto({ cwd, env });

    expect(result.variables).toBe(3);
    expect(env.HF_CREDENTIALS).toBe("key-id-0000000000:key-secret-0000000000");
    expect(env.HF_CACHE_ROOT).toBe("/tmp/quoted cache");
    expect(loadConfig({ env: env as Record<string, string> }).provider).toBe("higgsfield-v1");
    for (const key of ["HF_PROVIDER", "HF_CREDENTIALS", "HF_CACHE_ROOT"]) delete process.env[key];
  });
});
