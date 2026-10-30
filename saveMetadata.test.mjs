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
  readDirectory,
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
    await saveMetadata({
      frontPath,
      backPath,
      date: "1991-12-31",
      description: "",
      tags: [],
    });
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
    await saveMetadata({
      frontPath,
      backPath,
      date: "1991-12-31",
      description: "",
      tags: [],
    });
    const orientationBefore = await readOrientation(frontPath);
    // The first save recorded a time of day, which later saves of a new day keep.
    const { DateTimeOriginal: firstDate } = await exiftool.readRaw(frontPath, {
      readArgs: ["-EXIF:DateTimeOriginal"],
    });

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
    assert.equal(dates.DateTimeOriginal, `1992:01:15 ${firstDate.slice(11)}`);
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
      saveMetadata({
        frontPath,
        backPath,
        date: "not a date",
        description: "",
        tags: [],
      }),
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
    await saveMetadata({
      frontPath,
      backPath,
      date: "1991-12-31",
      description: "",
      tags: [],
    });
    const metadata = await readSidecarMetadata(frontPath);
    assert.equal(metadata.hasSidecar, true);
    assert.equal(metadata.date, "1991-12-31");
  } finally {
    await cleanup();
  }
});

test("the date taken embedded in an image is used when it has no sidecar", async () => {
  const { frontPath, cleanup } = await makePairDirectory();
  try {
    await exiftool.write(
      frontPath,
      {
        DateTimeOriginal: "1987:06:15 14:30:00",
        CreateDate: "2001:01:01 00:00:00",
      },
      { writeArgs: ["-overwrite_original"] },
    );
    const metadata = await readSidecarMetadata(frontPath);
    assert.equal(metadata.hasSidecar, false);
    assert.equal(metadata.date, "1987-06-15");
  } finally {
    await cleanup();
  }
});

test("the embedded date taken fills in a sidecar without a date, but never overrides one", async () => {
  const { frontPath, backPath, cleanup } = await makePairDirectory();
  try {
    await exiftool.write(
      frontPath,
      { DateTimeOriginal: "1987:06:15 14:30:00" },
      { writeArgs: ["-overwrite_original"] },
    );
    await fs.writeFile(
      `${frontPath}.xmp`,
      "<x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'/></x:xmpmeta>",
    );
    const undated = await readSidecarMetadata(frontPath);
    assert.equal(undated.hasSidecar, true);
    assert.equal(undated.date, "1987-06-15");

    await saveMetadata({
      frontPath,
      backPath,
      date: "1991-12-31",
      description: "",
      tags: [],
    });
    assert.equal((await readSidecarMetadata(frontPath)).date, "1991-12-31");
  } finally {
    await cleanup();
  }
});

test("an image without a valid embedded date taken falls back to its created date", async () => {
  const { frontPath, cleanup } = await makePairDirectory();
  try {
    await exiftool.write(
      frontPath,
      { DateTimeOriginal: "0000:00:00 00:00:00", CreateDate: null },
      { writeArgs: ["-overwrite_original"] },
    );
    // The name "photo_a.jpg" has no date either, so the file's created date is used.
    const created = new Date((await fs.stat(frontPath)).birthtimeMs);
    assert.equal(
      (await readSidecarMetadata(frontPath)).date,
      `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, "0")}-${String(created.getDate()).padStart(2, "0")}`,
    );
  } finally {
    await cleanup();
  }
});

test("without a sidecar or embedded date, the date comes from the file name, then the created date", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "imageparser-names-"));
  try {
    const expected = {
      "2007-07-03-66f03db.jpeg": "2007-07-03",
      "IMG_20190521_101500.jpg": "2019-05-21",
      "scan 1999.12.31.png": "1999-12-31",
      "20230228.jpg": "2023-02-28",
      // Impossible dates and stray digits fall through to the created date.
      "2021-02-30.jpg": "",
      "IMG_12345678.jpg": "",
      "holiday.jpg": "",
    };
    for (const name of Object.keys(expected)) {
      await fs.writeFile(path.join(dir, name), Buffer.alloc(0));
    }

    for (const [name, day] of Object.entries(expected)) {
      const filePath = path.join(dir, name);
      const stats = await fs.stat(filePath);
      const created = new Date(stats.birthtimeMs || stats.ctimeMs);
      const createdDay = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, "0")}-${String(created.getDate()).padStart(2, "0")}`;
      assert.equal(
        (await readSidecarMetadata(filePath)).date,
        day || createdDay,
        name,
      );
    }

    const { files } = await readDirectory(dir, "fileName-asc");
    assert.equal(
      files.find((pair) => pair.imageLabel === "IMG_20190521_101500.jpg")
        .sidecarDate,
      "2019-05-21",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("saving a day keeps the photo's time of day", async () => {
  const { frontPath, backPath, cleanup } = await makePairDirectory();
  try {
    await exiftool.write(
      frontPath,
      {
        DateTimeOriginal: "1987:06:15 14:30:05",
        CreateDate: "1987:06:15 14:30:05",
      },
      { writeArgs: ["-overwrite_original"] },
    );
    const readDates = async (filePath) =>
      exiftool.readRaw(filePath, {
        readArgs: ["-EXIF:DateTimeOriginal", "-EXIF:CreateDate"],
      });

    await saveMetadata({
      frontPath,
      backPath,
      date: "1987-06-15",
      description: "",
      tags: [],
    });
    for (const filePath of [frontPath, backPath]) {
      const dates = await readDates(filePath);
      assert.equal(dates.DateTimeOriginal, "1987:06:15 14:30:05", filePath);
      assert.equal(dates.CreateDate, "1987:06:15 14:30:05", filePath);
    }
    assert.match(
      await fs.readFile(`${frontPath}.xmp`, "utf8"),
      /1987-06-15T14:30:05/,
    );

    // A new day keeps the time too; the sidecar now holds it.
    await saveMetadata({
      frontPath,
      backPath,
      date: "1990-01-02",
      description: "",
      tags: [],
    });
    assert.equal(
      (await readDates(frontPath)).DateTimeOriginal,
      "1990:01:02 14:30:05",
    );
    assert.equal((await readSidecarMetadata(frontPath)).date, "1990-01-02");
  } finally {
    await cleanup();
  }
});

test("the folder grid shows and sorts by the embedded date taken when there is no sidecar date", async () => {
  const { dir, frontPath, backPath, cleanup } = await makePairDirectory();
  try {
    const otherPath = path.join(dir, "other.jpg");
    await fs.copyFile(frontPath, otherPath);
    await fs.rm(backPath);
    await exiftool.write(
      frontPath,
      { DateTimeOriginal: "1987:06:15 14:30:00" },
      { writeArgs: ["-overwrite_original"] },
    );
    await exiftool.write(
      otherPath,
      { DateTimeOriginal: "2005:03:02 09:00:00" },
      { writeArgs: ["-overwrite_original"] },
    );

    const { files } = await readDirectory(dir, "dateTaken-desc");
    assert.deepEqual(
      files.map((pair) => [pair.imageLabel, pair.sidecarDate, pair.hasSidecar]),
      [
        ["other.jpg", "2005-03-02", false],
        ["photo_a.jpg", "1987-06-15", false],
      ],
    );

    // A sidecar date stays the source of truth.
    await saveMetadata({
      frontPath,
      backPath: null,
      date: "2010-01-01",
      description: "",
      tags: [],
    });
    const resorted = await readDirectory(dir, "dateTaken-desc");
    assert.deepEqual(
      resorted.files.map((pair) => [pair.imageLabel, pair.sidecarDate]),
      [
        ["photo_a.jpg", "2010-01-01"],
        ["other.jpg", "2005-03-02"],
      ],
    );
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
