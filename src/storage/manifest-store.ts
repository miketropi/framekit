import { stat } from "node:fs/promises";
import path from "node:path";
import { sha256OfFile } from "../application/fingerprint";
import type { GenerationManifest } from "../domain/asset";
import { MANIFEST_SCHEMA_VERSION } from "../domain/asset";
import type { Clock } from "../domain/runtime";
import { readJsonIfValid, writeJsonAtomic } from "./atomic-json";
import { isInside } from "./paths";
import { parseManifest } from "./manifest-schema";

export const MANIFEST_FILENAME = "generation.json";

export interface ManifestStoreOptions {
  clock: Clock;
}

export interface ManifestVerification {
  ok: boolean;
  /** Output entries that could not be verified, with the reason. */
  problems: {
    path: string;
    reason:
      | "missing"
      | "empty"
      | "hash_mismatch"
      | "unreadable"
      | "no_outputs"
      | "outside_output_directory";
  }[];
}

export class ManifestStore {
  private readonly clock: Clock;

  constructor(options: ManifestStoreOptions) {
    this.clock = options.clock;
  }

  pathFor(outputDirectory: string): string {
    return path.join(outputDirectory, MANIFEST_FILENAME);
  }

  /** Returns a manifest only when it is schema-valid; invalid content is ignored. */
  async read(outputDirectory: string): Promise<GenerationManifest | undefined> {
    const raw = await readJsonIfValid(this.pathFor(outputDirectory));
    return parseManifest(raw);
  }

  /** Atomic write; called only after every declared output exists and verifies. */
  async write(outputDirectory: string, manifest: GenerationManifest): Promise<string> {
    const target = this.pathFor(outputDirectory);
    await writeJsonAtomic(target, manifest);
    return target;
  }

  createdAt(): string {
    return this.clock.now().toISOString();
  }

  /**
   * Verify every declared output exists, is non-empty, and matches its recorded
   * SHA-256. A manifest is only reusable when this passes.
   */
  async verify(
    outputDirectory: string,
    manifest: GenerationManifest,
  ): Promise<ManifestVerification> {
    const problems: ManifestVerification["problems"] = [];
    if (manifest.outputs.length === 0) {
      return { ok: false, problems: [{ path: MANIFEST_FILENAME, reason: "no_outputs" }] };
    }
    for (const output of manifest.outputs) {
      const absolutePath = path.resolve(outputDirectory, output.path);
      // Defence in depth for callers that bypass the schema: a manifest must only
      // ever describe files inside its own directory.
      if (!isInside(outputDirectory, absolutePath)) {
        problems.push({ path: output.path, reason: "outside_output_directory" });
        continue;
      }
      let size: number;
      try {
        const stats = await stat(absolutePath);
        if (!stats.isFile()) {
          problems.push({ path: output.path, reason: "missing" });
          continue;
        }
        size = stats.size;
      } catch {
        problems.push({ path: output.path, reason: "missing" });
        continue;
      }
      if (size === 0) {
        problems.push({ path: output.path, reason: "empty" });
        continue;
      }
      let actualHash: string;
      try {
        actualHash = await sha256OfFile(absolutePath);
      } catch {
        problems.push({ path: output.path, reason: "unreadable" });
        continue;
      }
      if (actualHash !== output.sha256) {
        problems.push({ path: output.path, reason: "hash_mismatch" });
      }
    }
    return { ok: problems.length === 0, problems };
  }
}

export { MANIFEST_SCHEMA_VERSION };
