import path from "node:path";
import { z } from "zod";
import { DISCOVERY_CACHE_TTL_MS } from "../config/defaults";
import type { MotionPreset, StylePreset } from "../domain/asset";
import type { Clock } from "../domain/runtime";
import { readJsonIfValid, writeJsonAtomic } from "./atomic-json";

/**
 * Local JSON cache (§11): discovery results and uploaded-URL reuse.
 * Every write is atomic; corrupt or schema-mismatched content is ignored and
 * replaced by the next successful refresh. Cached data is parsed at this
 * boundary, so downstream code never sees unvalidated shapes.
 */

export interface CachedDiscovery<T> {
  data: T;
  fetchedAt: string;
  stale: boolean;
}

export interface UploadCacheEntry {
  url: string;
  contentType: string;
  bytes: number;
  uploadedAt: string;
}

export interface CacheStoreOptions {
  /** Cache root, absolute or relative to `cwd`. */
  root: string;
  cwd: string;
  provider: string;
  clock: Clock;
  discoveryTtlMs?: number;
}

const timestamp = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO-8601 timestamp");

const motionPresetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  previewUrl: z.string().optional(),
  startEndFrame: z.boolean().optional(),
});

const stylePresetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  previewUrl: z.string().optional(),
});

const uploadEntrySchema = z.object({
  url: z.string().regex(/^https:\/\/\S+$/, "must be an https URL"),
  contentType: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  uploadedAt: timestamp,
});

const sha256Key = /^[0-9a-f]{64}$/;

function envelopeSchema<T extends z.ZodType>(provider: string, data: T) {
  return z.object({
    schemaVersion: z.literal(1),
    provider: z.literal(provider),
    fetchedAt: timestamp,
    data,
  });
}

export class CacheStore {
  private readonly directory: string;
  private readonly provider: string;
  private readonly clock: Clock;
  private readonly discoveryTtlMs: number;
  private readonly motionsCacheFile: string;
  private readonly stylesCacheFile: string;
  private readonly uploadsCacheFile: string;

  constructor(options: CacheStoreOptions) {
    this.directory = path.resolve(options.cwd, options.root);
    this.provider = options.provider;
    this.clock = options.clock;
    this.discoveryTtlMs = options.discoveryTtlMs ?? DISCOVERY_CACHE_TTL_MS;
    this.motionsCacheFile = path.join(this.directory, "motions.json");
    this.stylesCacheFile = path.join(this.directory, "styles.json");
    this.uploadsCacheFile = path.join(this.directory, "uploads.json");
  }

  get root(): string {
    return this.directory;
  }

  private async readDiscoveryArray<T extends z.ZodType>(
    file: string,
    itemSchema: T,
  ): Promise<CachedDiscovery<z.infer<T>[]> | undefined> {
    const raw = await readJsonIfValid(file);
    const parsed = envelopeSchema(this.provider, z.array(itemSchema)).safeParse(raw);
    if (!parsed.success) return undefined;
    const age = this.clock.now().getTime() - Date.parse(parsed.data.fetchedAt);
    return {
      data: parsed.data.data,
      fetchedAt: parsed.data.fetchedAt,
      stale: age > this.discoveryTtlMs,
    };
  }

  private async writeDiscoveryArray(file: string, data: unknown[]): Promise<void> {
    await writeJsonAtomic(file, {
      schemaVersion: 1,
      provider: this.provider,
      fetchedAt: this.clock.now().toISOString(),
      data,
    });
  }

  async readMotions(): Promise<CachedDiscovery<MotionPreset[]> | undefined> {
    return this.readDiscoveryArray(this.motionsCacheFile, motionPresetSchema);
  }

  async writeMotions(motions: MotionPreset[]): Promise<void> {
    await this.writeDiscoveryArray(this.motionsCacheFile, motions);
  }

  async readStyles(): Promise<CachedDiscovery<StylePreset[]> | undefined> {
    return this.readDiscoveryArray(this.stylesCacheFile, stylePresetSchema);
  }

  async writeStyles(styles: StylePreset[]): Promise<void> {
    await this.writeDiscoveryArray(this.stylesCacheFile, styles);
  }

  /**
   * Entries are validated one by one: a single malformed or foreign entry is
   * dropped, while every still-valid upload URL survives the next rewrite.
   */
  private async readUploadMap(): Promise<Record<string, UploadCacheEntry>> {
    const raw = await readJsonIfValid(this.uploadsCacheFile);
    const parsed = envelopeSchema(this.provider, z.record(z.string(), z.unknown())).safeParse(raw);
    if (!parsed.success) return {};

    const entries: Record<string, UploadCacheEntry> = {};
    for (const [key, value] of Object.entries(parsed.data.data)) {
      if (!sha256Key.test(key)) continue;
      const entry = uploadEntrySchema.safeParse(value);
      if (entry.success) entries[key] = entry.data;
    }
    return entries;
  }

  /** Reuses an upload URL only when the content hash matches and the URL is a usable HTTPS URL. */
  async readUpload(sha256: string): Promise<UploadCacheEntry | undefined> {
    const entries = await this.readUploadMap();
    return entries[sha256];
  }

  async writeUpload(sha256: string, entry: UploadCacheEntry): Promise<void> {
    const entries = await this.readUploadMap();
    await writeJsonAtomic(this.uploadsCacheFile, {
      schemaVersion: 1,
      provider: this.provider,
      fetchedAt: this.clock.now().toISOString(),
      data: { ...entries, [sha256]: entry },
    });
  }
}
