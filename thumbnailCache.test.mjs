import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import sharp from "sharp";
import {
  applyImageRotations,
  clearThumbnailMemoryCache,
  configurePreviewCache,
  getThumbnail,
  shutdownCore,
} from "./core.js";
import {
  buildPreviewCacheKey,
  buildThumbnailCacheKey,
} from "./previewCache.js";

let cacheDirectory;
let cache;

before(async () => {
  cacheDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "imageparser-thumb-cache-"),
  );
  cache = configurePreviewCache({ directory: cacheDirectory });
});

after(async () => {
  await shutdownCore();
  await fs.rm(cacheDirectory, { recursive: true, force: true });
});

/**
 * Creates a temporary directory and returns it with a cleanup function.
 */
const makeTestDirectory = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "imageparser-thumb-"));
  return {
    dir,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
};

/**
 * Writes a solid-colour PNG of the given size.
 */
const writePng = (filePath, width, height, background = "#3366cc") =>
  sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toFile(filePath);

/**
 * Waits until the cache holds an entry for the key, since thumbnails are stored in the background.
 */
const waitForCacheEntry = async (key) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const buffer = await cache.get(key);
    if (buffer) {
      return buffer;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The thumbnail was never stored in the cache.");
};

/**
 * Returns the colour of a thumbnail's first pixel.
 */
const readFirstPixel = async (buffer) => {
  const { data } = await sharp(buffer)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return [data[0], data[1], data[2]];
};

test("getThumbnail serves a stored thumbnail after a restart without rendering again", async () => {
  const { dir, cleanup } = await makeTestDirectory();
  try {
    const imagePath = path.join(dir, "restart_a.png");
    await writePng(imagePath, 600, 300);

    const first = await getThumbnail(imagePath);
    const key = buildThumbnailCacheKey(
      imagePath,
      await fs.stat(imagePath),
      0,
      320,
    );
    assert.deepEqual(await waitForCacheEntry(key), first);

    // A marker in place of the stored thumbnail shows whether the next one is rendered again.
    const marker = Buffer.from("stored thumbnail");
    await cache.put(key, marker);
    clearThumbnailMemoryCache();
    assert.deepEqual(await getThumbnail(imagePath), marker);
  } finally {
    await cleanup();
  }
});

test("getThumbnail builds from the cached preview instead of the original", async () => {
  const { dir, cleanup } = await makeTestDirectory();
  try {
    const imagePath = path.join(dir, "preview_a.png");
    await writePng(imagePath, 800, 400, "#0000ff");

    // A red preview stands in for the cached render, so the thumbnail's colour shows its source.
    const preview = await sharp({
      create: { width: 800, height: 400, channels: 3, background: "#ff0000" },
    })
      .webp({ lossless: true })
      .toBuffer();
    await cache.put(
      buildPreviewCacheKey(imagePath, await fs.stat(imagePath), 0),
      preview,
    );

    const thumbnail = await getThumbnail(imagePath);
    const metadata = await sharp(thumbnail).metadata();
    assert.equal(metadata.width, 320);
    assert.equal(metadata.height, 160);
    const [red, , blue] = await readFirstPixel(thumbnail);
    assert.ok(red > 200 && blue < 50, "the thumbnail comes from the preview");
  } finally {
    await cleanup();
  }
});

test("getThumbnail falls back to the original when there is no cached preview", async () => {
  const { dir, cleanup } = await makeTestDirectory();
  try {
    const imagePath = path.join(dir, "original_a.png");
    await writePng(imagePath, 800, 400, "#0000ff");

    const [red, , blue] = await readFirstPixel(await getThumbnail(imagePath));
    assert.ok(blue > 200 && red < 50, "the thumbnail comes from the original");
  } finally {
    await cleanup();
  }
});

test("getThumbnail renders again after the file version changes, even after a restart", async () => {
  const { dir, cleanup } = await makeTestDirectory();
  try {
    const imagePath = path.join(dir, "rotated_a.png");
    await writePng(imagePath, 600, 300);

    await getThumbnail(imagePath);
    await waitForCacheEntry(
      buildThumbnailCacheKey(imagePath, await fs.stat(imagePath), 0, 320),
    );

    const rotation = await applyImageRotations({
      frontPath: imagePath,
      backPath: null,
      frontRotation: 90,
      backRotation: 0,
    });
    assert.equal(rotation.ok, true);

    clearThumbnailMemoryCache();
    const metadata = await sharp(await getThumbnail(imagePath)).metadata();
    assert.equal(metadata.width, 160);
    assert.equal(metadata.height, 320);
  } finally {
    await cleanup();
  }
});
