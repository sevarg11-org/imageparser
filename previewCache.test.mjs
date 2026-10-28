import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildImageVersion,
  buildPreviewCacheKey,
  createPreviewCache,
} from "./previewCache.js";

const stats = { size: 1234, mtimeMs: 1_700_000_000_123.4, ctimeMs: 1_700_000_000_456.7 };

test("preview cache keys are stable for the same file version and rotation", () => {
  assert.equal(
    buildPreviewCacheKey("/photos/a.jpg", stats, 0),
    buildPreviewCacheKey("/photos/a.jpg", { ...stats }, 0),
  );
  assert.match(buildPreviewCacheKey("/photos/a.jpg", stats, 0), /^[0-9a-f]{64}$/);
});

test("preview cache keys change with the path, size, modification time, change time, and rotation", () => {
  const key = buildPreviewCacheKey("/photos/a.jpg", stats, 0);
  const variants = [
    buildPreviewCacheKey("/photos/b.jpg", stats, 0),
    buildPreviewCacheKey("/photos/a.jpg", { ...stats, size: 1235 }, 0),
    buildPreviewCacheKey("/photos/a.jpg", { ...stats, mtimeMs: stats.mtimeMs + 1000 }, 0),
    // Pixel rotation restores the modification time, so the change time must also count.
    buildPreviewCacheKey("/photos/a.jpg", { ...stats, ctimeMs: stats.ctimeMs + 1000 }, 0),
    buildPreviewCacheKey("/photos/a.jpg", stats, 90),
  ];
  for (const variant of variants) {
    assert.notEqual(variant, key);
  }
  assert.equal(new Set(variants).size, variants.length);
});

test("image versions change when the file is rewritten", () => {
  assert.equal(buildImageVersion(stats), buildImageVersion({ ...stats }));
  assert.notEqual(
    buildImageVersion(stats),
    buildImageVersion({ ...stats, ctimeMs: stats.ctimeMs + 1000 }),
  );
});

const withCacheDirectory = async (run) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "imageparser-preview-cache-"));
  try {
    await run(path.join(directory, "preview-cache"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
};

test("the preview cache returns stored previews and misses unknown keys", async () => {
  await withCacheDirectory(async (directory) => {
    const cache = createPreviewCache({ directory });
    const key = buildPreviewCacheKey("/photos/a.jpg", stats, 0);

    assert.equal(await cache.get(key), null);
    await cache.put(key, Buffer.from("preview"));
    assert.deepEqual(await cache.get(key), Buffer.from("preview"));
  });
});

test("the preview cache rejects keys that are not hashes", async () => {
  await withCacheDirectory(async (directory) => {
    const cache = createPreviewCache({ directory });
    await assert.rejects(cache.put("../escape", Buffer.from("x")), /Invalid preview cache key/);
  });
});

test("the preview cache evicts the least recently used previews over its size cap", async () => {
  await withCacheDirectory(async (directory) => {
    const cache = createPreviewCache({ directory, maxBytes: 250 });
    const keys = ["a", "b", "c"].map((name) =>
      buildPreviewCacheKey(`/photos/${name}.jpg`, stats, 0),
    );

    await cache.put(keys[0], Buffer.alloc(100));
    await cache.put(keys[1], Buffer.alloc(100));
    // Make the first entry the oldest, then use the second so it stays.
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(path.join(directory, `${keys[0]}.webp`), past, past);
    await cache.get(keys[1]);
    await cache.put(keys[2], Buffer.alloc(100));

    assert.equal(await cache.get(keys[0]), null);
    assert.notEqual(await cache.get(keys[1]), null);
    assert.notEqual(await cache.get(keys[2]), null);
  });
});
