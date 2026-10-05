import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sha256OfFile } from "../../src/application/fingerprint";
import { CacheStore, type UploadCacheEntry } from "../../src/storage/cache-store";
import { FakeClock } from "../helpers/clock";
import { writeJsonAtomic } from "../../src/storage/atomic-json";

const MOTIONS = [{ id: "m1", name: "Zoom In", previewUrl: "https://p/m1" }];
const ENTRY: UploadCacheEntry = {
  url: "https://cdn.test/a.png",
  contentType: "image/png",
  bytes: 12,
  uploadedAt: "2024-01-01T00:00:00.000Z",
};

async function buildStore(): Promise<{ store: CacheStore; clock: FakeClock; root: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "hf-cache-"));
  const clock = new FakeClock();
  const store = new CacheStore({
    root: ".cache/higgsfield",
    cwd,
    provider: "higgsfield-v1",
    clock,
  });
  return { store, clock, root: store.root };
}

describe("discovery cache", () => {
  it("round-trips motions and leaves no temporary files behind", async () => {
    const { store, root } = await buildStore();
    await store.writeMotions(MOTIONS);

    const cached = await store.readMotions();
    expect(cached).toMatchObject({ data: MOTIONS, stale: false });
    expect(await readdir(root)).toEqual(["motions.json"]);
  });

  it("marks entries stale after the TTL", async () => {
    const { store, clock } = await buildStore();
    await store.writeStyles([{ id: "s1", name: "Noir" }]);
    clock.advance(24 * 60 * 60 * 1_000 + 1);

    expect(await store.readStyles()).toMatchObject({ stale: true });
  });

  it("ignores corrupt, mismatched, and foreign cache files", async () => {
    const { store, root } = await buildStore();

    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "motions.json"), "{ not json");
    expect(await store.readMotions()).toBeUndefined();

    await writeJsonAtomic(path.join(root, "motions.json"), {
      schemaVersion: 2,
      provider: "higgsfield-v1",
      fetchedAt: new Date().toISOString(),
      data: MOTIONS,
    });
    expect(await store.readMotions()).toBeUndefined();

    await writeJsonAtomic(path.join(root, "motions.json"), {
      schemaVersion: 1,
      provider: "higgsfield-v2",
      fetchedAt: new Date().toISOString(),
      data: MOTIONS,
    });
    expect(await store.readMotions()).toBeUndefined();

    await writeJsonAtomic(path.join(root, "motions.json"), {
      schemaVersion: 1,
      provider: "higgsfield-v1",
      fetchedAt: "not-a-date",
      data: MOTIONS,
    });
    expect(await store.readMotions()).toBeUndefined();

    await writeJsonAtomic(path.join(root, "motions.json"), {
      schemaVersion: 1,
      provider: "higgsfield-v1",
      fetchedAt: new Date().toISOString(),
      data: [{ id: "", name: 5 }],
    });
    expect(await store.readMotions()).toBeUndefined();
  });
});

describe("upload cache", () => {
  it("round-trips entries keyed by content hash", async () => {
    const { store } = await buildStore();
    const hash = "a".repeat(64);
    await store.writeUpload(hash, ENTRY);
    expect(await store.readUpload(hash)).toEqual(ENTRY);
    expect(await store.readUpload("b".repeat(64))).toBeUndefined();
  });

  it("refuses to reuse anything that is not an https URL", async () => {
    const { store, root } = await buildStore();
    const hash = "c".repeat(64);
    await writeJsonAtomic(path.join(root, "uploads.json"), {
      schemaVersion: 1,
      provider: "higgsfield-v1",
      fetchedAt: new Date().toISOString(),
      data: {
        [hash]: { ...ENTRY, url: "http://cdn.test/insecure.png" },
        ["d".repeat(64)]: { ...ENTRY, url: "" },
      },
    });

    expect(await store.readUpload(hash)).toBeUndefined();
    expect(await store.readUpload("d".repeat(64))).toBeUndefined();
  });

  it("keeps valid entries when another entry is malformed", async () => {
    const { store, root } = await buildStore();
    const good = "a".repeat(64);
    await writeJsonAtomic(path.join(root, "uploads.json"), {
      schemaVersion: 1,
      provider: "higgsfield-v1",
      fetchedAt: new Date().toISOString(),
      data: {
        [good]: ENTRY,
        ["b".repeat(64)]: { ...ENTRY, url: "http://cdn.test/insecure.png" },
        ["c".repeat(64)]: { url: "not-an-entry" },
        ["not-a-hash"]: ENTRY,
      },
    });

    expect(await store.readUpload(good)).toEqual(ENTRY);
    expect(await store.readUpload("b".repeat(64))).toBeUndefined();

    // Rewriting the cache must not discard the still-valid entry.
    await store.writeUpload("d".repeat(64), { ...ENTRY, url: "https://cdn.test/d.png" });
    expect(await store.readUpload(good)).toEqual(ENTRY);
    expect((await store.readUpload("d".repeat(64)))?.url).toBe("https://cdn.test/d.png");
  });

  it("preserves previously cached uploads when adding a new one", async () => {
    const { store } = await buildStore();
    await store.writeUpload("a".repeat(64), ENTRY);
    await store.writeUpload("b".repeat(64), { ...ENTRY, url: "https://cdn.test/b.png" });

    expect((await store.readUpload("a".repeat(64)))?.url).toBe(ENTRY.url);
    expect((await store.readUpload("b".repeat(64)))?.url).toBe("https://cdn.test/b.png");
  });
});

describe("hash of files", () => {
  it("matches the in-memory hash", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hf-hash-"));
    const file = path.join(directory, "blob.bin");
    await writeFile(file, "hello fingerprint");
    const onDisk = await sha256OfFile(file);
    const bytes = await readFile(file);
    expect(onDisk).toMatch(/^[0-9a-f]{64}$/);
    expect(onDisk).toBe(
      (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex"),
    );
  });
});
