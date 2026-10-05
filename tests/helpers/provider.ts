import { loadConfig, type ConfigOverrides, type ToolConfig } from "../../src/config/env";
import { HiggsfieldV1Provider } from "../../src/providers/higgsfield-v1/provider";
import { FakeClock, RecordingSleeper, halfRandom } from "./clock";
import { createFakeClients, type FakeClients, type FakeSdkScript } from "./fakes";

/** Deterministic config: no environment, small retry/poll budgets. */
export function testConfig(overrides: ConfigOverrides = {}): ToolConfig {
  return loadConfig({
    env: {},
    overrides: {
      apiKey: "test-api-key-0000000000",
      apiSecret: "test-api-secret-0000000000",
      apiBaseUrl: "https://api.example.test",
      retryCount: 2,
      retryBackoffMs: 100,
      retryMaxBackoffMs: 1_000,
      pollIntervalMs: 100,
      imagePollLimitMs: 1_000,
      videoPollLimitMs: 2_000,
      cacheRoot: ".cache/higgsfield",
      ...overrides,
    },
  });
}

export interface ProviderHarness {
  provider: HiggsfieldV1Provider;
  clients: FakeClients;
  clock: FakeClock;
  sleeper: RecordingSleeper;
}

export function buildProvider(
  script: FakeSdkScript,
  configOverrides: ConfigOverrides = {},
): ProviderHarness {
  const clients = createFakeClients(script);
  const clock = new FakeClock();
  const sleeper = new RecordingSleeper(clock);
  const provider = new HiggsfieldV1Provider({
    config: testConfig(configOverrides),
    sdk: clients.sdk,
    http: clients.http,
    clock,
    sleeper,
    random: halfRandom,
  });
  return { provider, clients, clock, sleeper };
}
