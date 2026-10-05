import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DiscoveryService } from "../../src/application/discovery";
import { ToolError } from "../../src/domain/errors";
import { CacheStore } from "../../src/storage/cache-store";
import { FakeClock } from "../helpers/clock";
import { createFakeProvider, type FakeProviderScript } from "../helpers/fake-media-provider";

async function build(script: FakeProviderScript, clock: FakeClock) {
  const cwd = await mkdtemp(path.join(tmpdir(), "hf-discovery-"));
  const cache = new CacheStore({
    root: ".cache/higgsfield",
    cwd,
    provider: "higgsfield-v1",
    clock,
  });
  const fake = createFakeProvider(script);
  const service = new DiscoveryService({
    provider: fake.provider,
    cache,
    clock: () => clock.now(),
  });
  return { service, fake, cache, clock };
}

describe("discovery workflow", () => {
  it("serves a fresh cache without calling the provider", async () => {
    const clock = new FakeClock();
    const { service, fake } = await build(
      { listMotions: async () => [{ id: "m1", name: "Zoom In" }] },
      clock,
    );

    const first = await service.motions();
    const second = await service.motions();

    expect(first).toMatchObject({ fromCache: false, stale: false });
    expect(second).toMatchObject({ fromCache: true, stale: false });
    expect(second.items).toEqual([{ id: "m1", name: "Zoom In" }]);
    expect(fake.calls.listMotions).toBe(1);
  });

  it("refreshes when asked or when the cache has expired", async () => {
    const clock = new FakeClock();
    const { service, fake } = await build(
      { listStyles: async () => [{ id: "s1", name: "Noir" }] },
      clock,
    );

    await service.styles();
    await service.styles(true);
    clock.advance(24 * 60 * 60 * 1_000 + 1);
    await service.styles();

    expect(fake.calls.listStyles).toBe(3);
  });

  it("falls back to a stale cache when a refresh fails", async () => {
    const clock = new FakeClock();
    let fail = false;
    const { service } = await build(
      {
        listMotions: async () => {
          if (fail) throw new ToolError({ code: "PROVIDER_UNAVAILABLE", message: "down" });
          return [{ id: "m1", name: "Zoom In" }];
        },
      },
      clock,
    );

    await service.motions();
    fail = true;
    clock.advance(24 * 60 * 60 * 1_000 + 1);

    const result = await service.motions();
    expect(result).toMatchObject({ fromCache: true, stale: true });
    expect(result.items).toHaveLength(1);
  });

  it("surfaces the provider error when no cache exists", async () => {
    const clock = new FakeClock();
    const { service } = await build(
      {
        listMotions: async () => {
          throw new ToolError({ code: "RATE_LIMITED", message: "429" });
        },
      },
      clock,
    );

    await expect(service.motions()).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});
