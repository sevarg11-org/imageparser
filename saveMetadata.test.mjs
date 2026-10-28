import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { exiftool } from "exiftool-vendored";
import sharp from "sharp";
import {
  configurePreviewCache,
  getImagePreview,
  readSidecarMetadata,
  saveMetadata,
  shutdownCore,
} from "./core.js";

after(() => shutdownCore());

/**
 * Copies the smoke-test pair into a temporary directory.
 */
const makePairDirectory = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "imageparser-save-"));
  const frontPath = path.join(dir, "photo_a.jpg");
  const backPath = path.join(dir, "photo_b.jpg");
  await fs.copyFile(path.join(".smoke-test", "sample_pair_a.jpg"), frontPath);
  await fs.copyFile(path.join(".smoke-test", "sample_pair_b.jpg"), backPath);
  return {
    dir,
    frontPath,
    backPath,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
};

const fileTimes = async (...filePaths) =>
  Promise.all(
    filePaths.map(async (filePath) => {
      const stats = await fs.stat(filePath);
      return [stats.mtimeMs, stats.ctimeMs, stats.size];
    }),
  );

const readOrientation = async (filePath) =>
  Number(
    (await exiftool.readRaw(filePath, { readArgs: ["-n", "-Orientation"] }))
      .Orientation ?? 1,
  );

test("saving unchanged metadata again writes neither the sidecar nor the images", async () => {
  const { frontPath, backPath, cleanup } = await makePairDirectory();
  try {
    const metadata = {
      frontPath,
      backPath,
      date: "1991-12-31",
      description: "Grandma's garden",
      tags: ["family"],
    };
    const first = await saveMetadata(metadata);
    assert.equal(first.ok, true);
    assert.equal(first.sidecarWritten, true);
    assert.equal(first.updatedFiles, 2);

    const sidecarPath = first.sidecarFile;
    const before = await fileTimes(sidecarPath, frontPath, backPath);
    const second = await saveMetadata(metadata);
    assert.equal(second.ok, true);
    assert.equal(second.sidecarWritten, false);
    assert.equal(second.updatedFiles, 0);
    assert.deepEqual(
      second.results.map((result) => result.dateWritten),
      [false, false],
    );
    assert.deepEqual(await fileTimes(sidecarPath, frontPath, backPath), before);
  } finally {
    await cleanup();
  }
});

test("a changed description rewrites only the sidecar", async () => {
  const { frontPath, backPath, cleanup } = await makePairDirectory();
  try {
    await saveMetadata({ frontPath, backPath, date: "1991-12-31", description: "", tags: [] });
    const before = await fileTimes(frontPath, backPath);
    const result = await saveMetadata({
      frontPath,
      backPath,
      date: "1991-12-31",
      description: "Updated",
      tags: [],
    });
    assert.equal(result.sidecarWritten, true);
    assert.equal(result.updatedFiles, 0);
    assert.deepEqual(await fileTimes(frontPath, backPath), before);
  } finally {
    await cleanup();
  }
});

test("a rotation and a new date are written together and reported with the new version", async () => {
  const { frontPath, backPath, cleanup } = await makePairDirectory();
  try {
    await saveMetadata({ frontPath, backPath, date: "1991-12-31", description: "", tags: [] });
    const orientationBefore = await readOrientation(frontPath);

    const result = await saveMetadata({
      frontPath,
      backPath,
      date: "1992-01-15",
      description: "",
      tags: [],
      frontRotation: 90,
      backRotation: 0,
    });

    assert.equal(result.ok, true);
    const [front, back] = result.results;
    assert.equal(front.rotated, true);
    assert.equal(front.dateWritten, true);
    assert.equal(back.rotated, false);
    assert.equal(back.dateWritten, true);
    assert.match(front.version, /^[0-9a-z]+-[0-9a-z]+-[0-9a-z]+$/);
    assert.equal(orientationBefore, 1);
    assert.equal(await readOrientation(frontPath), 6);
    assert.equal(await readOrientation(backPath), 1);

    const dates = await exiftool.readRaw(frontPath, {
      readArgs: ["-EXIF:DateTimeOriginal"],
    });
    assert.equal(dates.DateTimeOriginal, "1992:01:15 00:00:00");
  } finally {
    await cleanup();
  }
});

test("an image that cannot be updated is reported per file instead of failing the whole save", async () => {
  const { dir, frontPath, cleanup } = await makePairDirectory();
  try {
    const brokenBackPath = path.join(dir, "photo_b.jpg");
    await fs.writeFile(brokenBackPath, Buffer.alloc(0));
    const result = await saveMetadata({
      frontPath,
      backPath: brokenBackPath,
      date: "1991-12-31",
      description: "",
      tags: [],
      frontRotation: 90,
      backRotation: 90,
    });

    assert.equal(result.ok, false);
    const [front, back] = result.results;
    assert.equal(front.ok, true);
    assert.equal(front.rotated, true);
    assert.equal(back.ok, false);
    assert.equal(typeof back.error, "string");
  } finally {
    await cleanup();
  }
});

test("an invalid date is rejected before anything is written", async () => {
  const { frontPath, backPath, cleanup } = await makePairDirectory();
  try {
    await assert.rejects(
      saveMetadata({ frontPath, backPath, date: "not a date", description: "", tags: [] }),
      /valid date/,
    );
    assert.equal((await readSidecarMetadata(frontPath)).hasSidecar, false);
  } finally {
    await cleanup();
  }
});

test("sidecar metadata reports whether the sidecar exists", async () => {
  const { frontPath, backPath, cleanup } = await makePairDirectory();
  try {
    assert.equal((await readSidecarMetadata(frontPath)).hasSidecar, false);
    await saveMetadata({ frontPath, backPath, date: "1991-12-31", description: "", tags: [] });
    const metadata = await readSidecarMetadata(frontPath);
    assert.equal(metadata.hasSidecar, true);
    assert.equal(metadata.date, "1991-12-31");
  } finally {
    await cleanup();
  }
});

test("previews are WebP images no larger than 2560 pixels and are cached on disk", async () => {
  const { dir, frontPath, cleanup } = await makePairDirectory();
  try {
    const cacheDirectory = path.join(dir, "cache");
    configurePreviewCache({ directory: cacheDirectory });

    const first = await getImagePreview(frontPath);
    assert.equal(first.contentType, "image/webp");
    const { format, width, height } = await sharp(first.buffer).metadata();
    assert.equal(format, "webp");
    assert.ok(Math.max(width, height) <= 2560);

    // Wait for the cache write, which happens after the preview is returned.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const entries = await fs.readdir(cacheDirectory).catch(() => []);
      if (entries.some((entry) => entry.endsWith(".webp"))) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const [entry] = (await fs.readdir(cacheDirectory)).filter((name) =>
      name.endsWith(".webp"),
    );
    assert.ok(entry, "The preview should be stored in the cache directory");

    // A cached preview is served from the cache file.
    await fs.writeFile(path.join(cacheDirectory, entry), Buffer.from("cached"));
    const second = await getImagePreview(frontPath);
    assert.deepEqual(second.buffer, Buffer.from("cached"));
    assert.equal(second.version, first.version);
  } finally {
    await cleanup();
  }
});
