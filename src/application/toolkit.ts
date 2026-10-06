import { pathToFileURL } from "node:url";
import type { ToolConfig } from "../config/env";
import { ToolError } from "../domain/errors";
import type { MediaProvider } from "../domain/media-provider";
import {
  systemClock,
  systemRandom,
  systemSleeper,
  type Clock,
  type RandomSource,
  type Sleeper,
} from "../domain/runtime";
import { HiggsfieldV1Provider } from "../providers/higgsfield-v1/provider";
import { createHiggsfieldClients } from "../providers/higgsfield-v1/client";
import { AssetStore } from "../storage/asset-store";
import { CacheStore } from "../storage/cache-store";
import { InputInspector } from "../storage/input-inspection";
import { ManifestStore } from "../storage/manifest-store";
import { CharacterService } from "./characters";
import { DiscoveryService } from "./discovery";
import { GenerateService } from "./generate";
import { StatusService } from "./inspect-job";
import { UploadService, type LocalUploader } from "./upload-media";

/**
 * Composition root: the only place that knows how to build real dependencies.
 * Production commands resolve a provider lazily, because `--help`, `--dry-run`,
 * and any credential-free command must work without HF_API_KEY/HF_SECRET.
 */

export interface Toolkit {
  config: ToolConfig;
  cwd: string;
  provider: MediaProvider;
  inspector: InputInspector;
  cache: CacheStore;
  manifests: ManifestStore;
  assets: AssetStore;
  uploads: UploadService;
  discovery: DiscoveryService;
  status: StatusService;
  characters: CharacterService;
  generate: GenerateService;
  clock: Clock;
}

export interface ToolkitProvider {
  /** Builds (once) the live toolkit; throws AUTHENTICATION_FAILED without credentials. */
  get(): Promise<Toolkit>;
}

export interface ToolkitOverrides {
  provider?: MediaProvider;
  clock?: Clock;
  sleeper?: Sleeper;
  random?: RandomSource;
  fetchImpl?: typeof fetch;
  cwd?: string;
  /** Environment used for the test-provider hook; defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/**
 * Testing seam for subprocess integration tests: an absolute path to an ESM
 * module exporting `createProvider(config)` (or a default function) that
 * returns a `MediaProvider`. Only set by tests.
 */
export const TEST_PROVIDER_MODULE_ENV = "HF_TEST_PROVIDER_MODULE";

export type ExternalProviderFactory = (
  config: ToolConfig,
) => MediaProvider | Promise<MediaProvider>;

async function loadExternalProvider(
  modulePath: string,
  config: ToolConfig,
): Promise<MediaProvider> {
  let imported: Record<string, unknown>;
  try {
    imported = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
  } catch (error) {
    throw new ToolError({
      code: "VALIDATION_FAILED",
      message: `Cannot load the test provider module "${modulePath}".`,
      details: { modulePath },
      cause: error,
    });
  }

  const candidate = imported.createProvider ?? imported.default;
  if (typeof candidate !== "function") {
    throw new ToolError({
      code: "VALIDATION_FAILED",
      message: `Test provider module "${modulePath}" must export createProvider(config).`,
      details: { modulePath },
    });
  }

  const provider = (await (candidate as ExternalProviderFactory)(config)) as MediaProvider;
  const required: (keyof MediaProvider)[] = [
    "generate",
    "upload",
    "getStatus",
    "listMotions",
    "listStyles",
    "createCharacter",
    "listCharacters",
  ];
  for (const method of required) {
    if (typeof provider?.[method] !== "function") {
      throw new ToolError({
        code: "VALIDATION_FAILED",
        message: `Test provider module "${modulePath}" does not implement ${method}().`,
        details: { modulePath, method },
      });
    }
  }
  return provider;
}

/**
 * Defers provider construction (and therefore credential validation) until the
 * first provider call: `--dry-run`, `--help`, and credential-free commands must
 * never need HF_API_KEY/HF_SECRET.
 */
export function createLazyProvider(
  factory: () => MediaProvider,
  name: MediaProvider["name"],
): MediaProvider {
  let instance: MediaProvider | undefined;
  const resolve = (): MediaProvider => (instance ??= factory());
  return {
    name,
    generate: (request) => resolve().generate(request),
    upload: (request) => resolve().upload(request),
    getStatus: (requestId) => resolve().getStatus(requestId),
    listMotions: () => resolve().listMotions(),
    listStyles: () => resolve().listStyles(),
    createCharacter: (request) => resolve().createCharacter(request),
    listCharacters: (page, pageSize) => resolve().listCharacters(page, pageSize),
    // Optional capability: forward it when the real provider implements it, otherwise
    // synthesize the plain status so callers see one consistent shape.
    getStatusReport: async (requestId) => {
      const provider = resolve();
      if (provider.getStatusReport !== undefined) return provider.getStatusReport(requestId);
      return { requestId, status: await provider.getStatus(requestId), assets: [] };
    },
  };
}

export function createToolkitProvider(
  config: ToolConfig,
  overrides: ToolkitOverrides = {},
): ToolkitProvider {
  const cwd = overrides.cwd ?? process.cwd();
  let pending: Promise<Toolkit> | undefined;

  async function build(): Promise<Toolkit> {
    const clock = overrides.clock ?? systemClock;
    const sleeper = overrides.sleeper ?? systemSleeper;
    const random = overrides.random ?? systemRandom;

    const externalModulePath = (overrides.env ?? process.env)[TEST_PROVIDER_MODULE_ENV];
    let provider = overrides.provider;
    if (provider === undefined && externalModulePath !== undefined) {
      provider = await loadExternalProvider(externalModulePath, config);
    }
    if (provider === undefined) {
      provider = createLazyProvider(() => {
        const clients = createHiggsfieldClients(config, overrides.fetchImpl);
        return new HiggsfieldV1Provider({
          config,
          sdk: clients.sdk,
          http: clients.http,
          clock,
          sleeper,
          random,
        });
      }, config.provider);
    }

    const cache = new CacheStore({ root: config.cacheRoot, cwd, provider: config.provider, clock });
    const manifests = new ManifestStore({ clock });
    const assets = new AssetStore({
      timeoutMs: config.timeoutMs,
      ...(overrides.fetchImpl === undefined ? {} : { fetchImpl: overrides.fetchImpl }),
    });
    const inspector = new InputInspector({ cwd });
    const uploads = new UploadService({ provider, cache, clock });
    const uploadLocal: LocalUploader = (input) => uploads.uploadLocal(input);

    return {
      config,
      cwd,
      provider,
      inspector,
      cache,
      manifests,
      assets,
      uploads,
      discovery: new DiscoveryService({ provider, cache, clock: () => clock.now() }),
      status: new StatusService({ provider }),
      characters: new CharacterService({ provider, inspector, uploadLocal }),
      generate: new GenerateService({
        provider,
        inspector,
        upload: uploadLocal,
        assets,
        manifests,
        cwd,
        providerName: config.provider,
        retry: {
          count: config.retryCount,
          backoffMs: config.retryBackoffMs,
          maxBackoffMs: config.retryMaxBackoffMs,
        },
        sleeper,
        random,
      }),
      clock,
    };
  }

  return {
    get: () => {
      pending ??= build();
      return pending;
    },
  };
}
