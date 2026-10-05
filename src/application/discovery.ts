import type { MotionPreset, StylePreset } from "../domain/asset";
import type { MediaProvider } from "../domain/media-provider";
import type { CacheStore } from "../storage/cache-store";

/**
 * Discovery workflow (§5.6): cache first, refresh on request, and fall back to
 * a stale cache when a refresh fails — surfacing `stale: true` rather than
 * failing the command.
 */

export interface DiscoveryResult<T> {
  items: T[];
  fetchedAt: string;
  stale: boolean;
  fromCache: boolean;
}

export interface DiscoveryServiceOptions {
  provider: MediaProvider;
  cache: CacheStore;
  clock: () => Date;
}

export const DEFAULT_DISCOVERY_TTL_MS = 24 * 60 * 60 * 1_000;

export class DiscoveryService {
  private readonly provider: MediaProvider;
  private readonly cache: CacheStore;
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(options: DiscoveryServiceOptions & { ttlMs?: number }) {
    this.provider = options.provider;
    this.cache = options.cache;
    this.now = options.clock;
    this.ttlMs = options.ttlMs ?? DEFAULT_DISCOVERY_TTL_MS;
  }

  async motions(refresh = false): Promise<DiscoveryResult<MotionPreset>> {
    return this.resolve(
      refresh,
      () => this.cache.readMotions(),
      () => this.provider.listMotions(),
      (items, fetchedAt) => this.cache.writeMotions(items).then(() => fetchedAt),
    );
  }

  async styles(refresh = false): Promise<DiscoveryResult<StylePreset>> {
    return this.resolve(
      refresh,
      () => this.cache.readStyles(),
      () => this.provider.listStyles(),
      (items, fetchedAt) => this.cache.writeStyles(items).then(() => fetchedAt),
    );
  }

  private async resolve<T>(
    refresh: boolean,
    readCache: () => Promise<{ data: T[]; fetchedAt: string; stale: boolean } | undefined>,
    fetchRemote: () => Promise<T[]>,
    writeCache: (items: T[], fetchedAt: string) => Promise<string>,
  ): Promise<DiscoveryResult<T>> {
    const cached = await readCache();
    if (!refresh && cached !== undefined && this.isFresh(cached.fetchedAt)) {
      return { items: cached.data, fetchedAt: cached.fetchedAt, stale: false, fromCache: true };
    }

    try {
      const items = await fetchRemote();
      const fetchedAt = await writeCache(items, this.now().toISOString());
      return { items, fetchedAt, stale: false, fromCache: false };
    } catch (error) {
      if (cached !== undefined) {
        return { items: cached.data, fetchedAt: cached.fetchedAt, stale: true, fromCache: true };
      }
      throw error;
    }
  }

  private isFresh(fetchedAt: string): boolean {
    const age = this.now().getTime() - Date.parse(fetchedAt);
    return Number.isFinite(age) && age <= this.ttlMs;
  }
}
