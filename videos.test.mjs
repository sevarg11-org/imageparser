import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import {
  findLiveVideoPath,
  listDirectory,
  readDirectory,
  readSidecarMetadata,
  resetFolderMetadata,
  saveMetadata,
  setDoNotUpload,
  setPairsDate,
  shutdownCore,
  toExcludedName,
  toIncludedName,
} from "./core.js";

after(() => shutdownCore());

/**
 * Creates a temporary folder holding empty files (and subfolders) with the given relative names. Videos are
 * empty files: probing them fails, so their duration is null, which the grouping tests do not depend on.
 */
const makeTestDirectory = async (fileNames) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "imageparser-video-"));
  for (const name of fileNames) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), Buffer.alloc(0));
  }
  return {
    dir,
    list: async () => (await fs.readdir(dir)).sort(),
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
};

/** Copies the smoke-test image so saves can embed a date in a real JPEG. */
const copySampleImage = (target) =>
  fs.copyFile(path.join(".smoke-test", "sample_pair_a.jpg"), target);

const byLabel = (files) =>
  Object.fromEntries(files.map((file) => [file.imageLabel, file]));

test("a video sharing a single image's stem is that image's live video", async () => {
  const { dir, cleanup } = await makeTestDirectory(["IMG_1.jpg", "IMG_1.mov"]);
  try {
    const { files } = await readDirectory(dir);
    assert.equal(files.length, 1, "the live video is not its own item");
    const [livePhoto] = files;
    assert.equal(livePhoto.mediaType, "image");
    assert.equal(livePhoto.frontPath, path.join(dir, "IMG_1.jpg"));
    assert.equal(livePhoto.liveVideoPath, path.join(dir, "IMG_1.mov"));
    assert.equal(typeof livePhoto.liveVideoVersion, "string");
    assert.equal(livePhoto.durationSeconds, null);
  } finally {
    await cleanup();
  }
});

test("live photo stems match ignoring case", async () => {
  const { dir, cleanup } = await makeTestDirectory(["img_2.JPG", "IMG_2.MOV"]);
  try {
    const { files } = await readDirectory(dir);
    assert.equal(files.length, 1);
    assert.equal(files[0].liveVideoPath, path.join(dir, "IMG_2.MOV"));
    assert.equal(
      await findLiveVideoPath(path.join(dir, "img_2.JPG")),
      path.join(dir, "IMG_2.MOV"),
    );
  } finally {
    await cleanup();
  }
});

test("A/B scans are never matched with a video", async () => {
  const { dir, cleanup } = await makeTestDirectory([
    "scan_a.jpg",
    "scan_b.jpg",
    "scan.mp4",
    "scan_a.mp4",
    "single_back.jpg",
    "single_back.mov",
  ]);
  try {
    const files = byLabel((await readDirectory(dir)).files);
    assert.deepEqual(Object.keys(files).sort(), [
      "scan.mp4",
      "scan_a.jpg",
      "scan_a.mp4",
      "single_back.jpg",
      "single_back.mov",
    ]);
    assert.equal(files["scan_a.jpg"].backPath, path.join(dir, "scan_b.jpg"));
    assert.equal(files["scan_a.jpg"].liveVideoPath, null);
    assert.equal(files["single_back.jpg"].liveVideoPath, null);
    for (const label of ["scan.mp4", "scan_a.mp4", "single_back.mov"]) {
      assert.equal(files[label].mediaType, "video", label);
      assert.equal(files[label].backPath, null, label);
    }
    assert.equal(await findLiveVideoPath(path.join(dir, "scan_a.jpg")), null);
  } finally {
    await cleanup();
  }
});

test("a video without a matching image is a standalone item", async () => {
  const { dir, cleanup } = await makeTestDirectory([
    "holiday.mp4",
    "clip.webm",
    "photo.png",
  ]);
  try {
    const files = byLabel((await readDirectory(dir)).files);
    assert.equal(files["holiday.mp4"].mediaType, "video");
    assert.equal(files["holiday.mp4"].frontPath, path.join(dir, "holiday.mp4"));
    assert.equal(files["holiday.mp4"].liveVideoPath, null);
    assert.equal(files["clip.webm"].mediaType, "video");
    assert.equal(files["photo.png"].mediaType, "image");
    assert.equal(files["photo.png"].liveVideoPath, null);
  } finally {
    await cleanup();
  }
});

test("only one of several same-stem videos joins the live photo", async () => {
  const { dir, cleanup } = await makeTestDirectory([
    "IMG_3.jpg",
    "IMG_3.mov",
    "IMG_3.mp4",
  ]);
  try {
    const files = byLabel((await readDirectory(dir)).files);
    assert.equal(files["IMG_3.jpg"].liveVideoPath, path.join(dir, "IMG_3.mov"));
    assert.equal(files["IMG_3.mp4"].mediaType, "video");
    assert.equal(
      await findLiveVideoPath(path.join(dir, "IMG_3.jpg")),
      path.join(dir, "IMG_3.mov"),
      "writes pick the same video as the folder listing",
    );
  } finally {
    await cleanup();
  }
});

test("the same stem in different folders does not make a live photo", async () => {
  const { dir, cleanup } = await makeTestDirectory([
    "IMG_4.jpg",
    path.join("nested", "IMG_4.mov"),
  ]);
  try {
    const files = byLabel(
      (
        await readDirectory(dir, "fileName-asc", {
          recursive: true,
        })
      ).files,
    );
    assert.equal(files["IMG_4.jpg"].liveVideoPath, null);
    assert.equal(files["nested/IMG_4.mov"].mediaType, "video");
  } finally {
    await cleanup();
  }
});

test("folder listings count videos with images", async () => {
  const { dir, cleanup } = await makeTestDirectory([
    "a.jpg",
    "b.mov",
    "c.MKV",
    "notes.txt",
  ]);
  try {
    assert.equal((await listDirectory(dir)).imageCount, 3);
  } finally {
    await cleanup();
  }
});

test("a standalone video's sidecar is name.ext.xmp and the video is not edited", async () => {
  const { dir, list, cleanup } = await makeTestDirectory(["clip.mp4"]);
  const videoPath = path.join(dir, "clip.mp4");
  try {
    const result = await saveMetadata({
      frontPath: videoPath,
      backPath: null,
      date: "2024-07-04",
      description: "Fireworks",
      tags: ["summer"],
    });
    assert.equal(result.ok, true);
    assert.equal(result.sidecarFile, `${videoPath}.xmp`);
    assert.equal(result.results[0].dateWritten, false);
    assert.equal(result.liveVideoSidecarFile, null);
    assert.deepEqual(await list(), ["clip.mp4", "clip.mp4.xmp"]);
    assert.equal((await fs.stat(videoPath)).size, 0, "the video is untouched");

    const metadata = await readSidecarMetadata(videoPath);
    assert.equal(metadata.date, "2024-07-04");
    assert.equal(metadata.description, "Fireworks");
    assert.deepEqual(metadata.tags, ["summer"]);
  } finally {
    await cleanup();
  }
});

test("a video never reads or writes the legacy stem.xmp sidecar, which belongs to the image", async () => {
  const { dir, list, cleanup } = await makeTestDirectory(["IMG_5.xmp"]);
  const videoPath = path.join(dir, "IMG_5.mp4");
  await fs.writeFile(videoPath, Buffer.alloc(0));
  await fs.writeFile(
    path.join(dir, "IMG_5.xmp"),
    "<x:xmpmeta><dc:description><rdf:Alt><rdf:li xml:lang='x-default'>Image only</rdf:li></rdf:Alt></dc:description></x:xmpmeta>",
  );
  try {
    assert.equal((await readSidecarMetadata(videoPath)).hasSidecar, false);
    await saveMetadata({
      frontPath: videoPath,
      backPath: null,
      date: "2020-01-01",
      description: "Video",
      tags: [],
    });
    assert.deepEqual(await list(), ["IMG_5.mp4", "IMG_5.mp4.xmp", "IMG_5.xmp"]);
    assert.match(
      await fs.readFile(path.join(dir, "IMG_5.xmp"), "utf8"),
      /Image only/,
    );
  } finally {
    await cleanup();
  }
});

test("videos cannot be rotated or given a back image", async () => {
  const { dir, cleanup } = await makeTestDirectory(["clip.mov", "clip_b.jpg"]);
  try {
    await assert.rejects(
      saveMetadata({
        frontPath: path.join(dir, "clip.mov"),
        backPath: null,
        date: "2020-01-01",
        description: "",
        tags: [],
        frontRotation: 90,
      }),
      /cannot be rotated/,
    );
    await assert.rejects(
      saveMetadata({
        frontPath: path.join(dir, "clip.mov"),
        backPath: path.join(dir, "clip_b.jpg"),
        date: "2020-01-01",
        description: "",
        tags: [],
      }),
      /cannot have a back image/,
    );
  } finally {
    await cleanup();
  }
});

test("saving a live photo writes identical image and video sidecars", async () => {
  const { dir, list, cleanup } = await makeTestDirectory(["IMG_6.MOV"]);
  const imagePath = path.join(dir, "IMG_6.jpg");
  await copySampleImage(imagePath);
  try {
    const result = await saveMetadata({
      frontPath: imagePath,
      backPath: null,
      date: "2019-05-17",
      description: "Beach",
      tags: ["family"],
    });
    assert.equal(result.ok, true);
    assert.equal(result.liveVideoSidecarFile, path.join(dir, "IMG_6.MOV.xmp"));
    assert.equal(result.liveVideoSidecarWritten, true);
    assert.deepEqual(await list(), [
      "IMG_6.MOV",
      "IMG_6.MOV.xmp",
      "IMG_6.jpg",
      "IMG_6.jpg.xmp",
    ]);
    assert.equal(
      await fs.readFile(path.join(dir, "IMG_6.MOV.xmp"), "utf8"),
      await fs.readFile(`${imagePath}.xmp`, "utf8"),
    );

    // Saving the same values again leaves both sidecars alone.
    const again = await saveMetadata({
      frontPath: imagePath,
      backPath: null,
      date: "2019-05-17",
      description: "Beach",
      tags: ["family"],
    });
    assert.equal(again.sidecarWritten, false);
    assert.equal(again.liveVideoSidecarWritten, false);
  } finally {
    await cleanup();
  }
});

test("the image sidecar is the source of truth for a live photo", async () => {
  const { dir, cleanup } = await makeTestDirectory(["IMG_7.mov"]);
  const imagePath = path.join(dir, "IMG_7.jpg");
  await copySampleImage(imagePath);
  try {
    await saveMetadata({
      frontPath: imagePath,
      backPath: null,
      date: "2018-03-01",
      description: "From the image",
      tags: [],
    });
    // A tool that rewrote only the video sidecar does not change what the app reads.
    await fs.writeFile(
      path.join(dir, "IMG_7.mov.xmp"),
      "<x:xmpmeta><dc:description><rdf:Alt><rdf:li xml:lang='x-default'>Edited elsewhere</rdf:li></rdf:Alt></dc:description></x:xmpmeta>",
    );
    assert.equal(
      (await readSidecarMetadata(imagePath)).description,
      "From the image",
    );
    const [livePhoto] = (await readDirectory(dir)).files;
    assert.equal(livePhoto.sidecarDate, "2018-03-01");
  } finally {
    await cleanup();
  }
});

test("setting a date on selected items covers standalone videos and both live photo sidecars", async () => {
  const { dir, cleanup } = await makeTestDirectory(["IMG_8.mov", "trip.mp4"]);
  const imagePath = path.join(dir, "IMG_8.jpg");
  await copySampleImage(imagePath);
  try {
    const result = await setPairsDate(
      [
        { frontPath: imagePath, backPath: null },
        { frontPath: path.join(dir, "trip.mp4"), backPath: null },
      ],
      "2001-09-09",
    );
    assert.equal(result.ok, true, result.errors.join("; "));
    assert.equal(result.updatedPairs, 2);
    for (const filePath of [
      imagePath,
      path.join(dir, "IMG_8.mov"),
      path.join(dir, "trip.mp4"),
    ]) {
      assert.equal(
        (await readSidecarMetadata(filePath)).date,
        "2001-09-09",
        filePath,
      );
    }
  } finally {
    await cleanup();
  }
});

test("resetting a folder removes image and video sidecars", async () => {
  const { dir, list, cleanup } = await makeTestDirectory([
    "IMG_9.jpg",
    "IMG_9.jpg.xmp",
    "IMG_9.mov",
    "IMG_9.mov.xmp",
    "clip.mp4",
    "clip.mp4.xmp",
    "unrelated.xmp",
  ]);
  try {
    const result = await resetFolderMetadata(dir);
    assert.equal(result.ok, true);
    assert.equal(result.deletedFiles, 3);
    assert.equal(result.resetPairs, 2);
    assert.deepEqual(await list(), [
      "IMG_9.jpg",
      "IMG_9.mov",
      "clip.mp4",
      "unrelated.xmp",
    ]);
  } finally {
    await cleanup();
  }
});

test("exclude names cover video sidecars", () => {
  for (const [original, flagged] of [
    ["IMG_1.mov", "IMG_1_exclude.mov"],
    ["IMG_1.mov.xmp", "IMG_1_exclude.mov.xmp"],
    ["clip.MP4.xmp", "clip_exclude.MP4.xmp"],
  ]) {
    assert.equal(toExcludedName(original), flagged, original);
    assert.equal(toIncludedName(flagged), original, flagged);
  }
});

test("flagging a live photo renames the image, the video, and both sidecars", async () => {
  const { dir, list, cleanup } = await makeTestDirectory([
    "IMG_10.jpg",
    "IMG_10.jpg.xmp",
    "IMG_10.mov",
    "IMG_10.mov.xmp",
  ]);
  try {
    const flagged = await setDoNotUpload({
      frontPath: path.join(dir, "IMG_10.jpg"),
      backPath: null,
      value: true,
    });
    assert.equal(flagged.doNotUpload, true);
    assert.equal(flagged.excludeMismatch, false);
    assert.equal(flagged.liveVideoPath, path.join(dir, "IMG_10_exclude.mov"));
    assert.equal(typeof flagged.liveVideoVersion, "string");
    assert.deepEqual(await list(), [
      "IMG_10_exclude.jpg",
      "IMG_10_exclude.jpg.xmp",
      "IMG_10_exclude.mov",
      "IMG_10_exclude.mov.xmp",
    ]);

    const [listed] = (await readDirectory(dir)).files;
    assert.equal(listed.liveVideoPath, path.join(dir, "IMG_10_exclude.mov"));

    const cleared = await setDoNotUpload({
      frontPath: path.join(dir, "IMG_10_exclude.jpg"),
      backPath: null,
      value: false,
    });
    assert.equal(cleared.liveVideoPath, path.join(dir, "IMG_10.mov"));
    assert.deepEqual(await list(), [
      "IMG_10.jpg",
      "IMG_10.jpg.xmp",
      "IMG_10.mov",
      "IMG_10.mov.xmp",
    ]);
  } finally {
    await cleanup();
  }
});

test("flagging a standalone video renames it and its sidecar", async () => {
  const { dir, list, cleanup } = await makeTestDirectory([
    "clip.mp4",
    "clip.mp4.xmp",
  ]);
  try {
    const flagged = await setDoNotUpload({
      frontPath: path.join(dir, "clip.mp4"),
      backPath: null,
      value: true,
    });
    assert.equal(flagged.mediaType, "video");
    assert.deepEqual(await list(), [
      "clip_exclude.mp4",
      "clip_exclude.mp4.xmp",
    ]);
  } finally {
    await cleanup();
  }
});

test("a live photo is not flagged when the video's new name is taken", async () => {
  const { dir, list, cleanup } = await makeTestDirectory([
    "IMG_11.jpg",
    "IMG_11.mov",
    "IMG_11_exclude.mov",
  ]);
  try {
    await assert.rejects(
      setDoNotUpload({
        frontPath: path.join(dir, "IMG_11.jpg"),
        backPath: null,
        value: true,
      }),
      /already exists/,
    );
    assert.deepEqual(await list(), [
      "IMG_11.jpg",
      "IMG_11.mov",
      "IMG_11_exclude.mov",
    ]);
  } finally {
    await cleanup();
  }
});

test("a failed live video rename rolls back the image rename", async () => {
  const { dir, list, cleanup } = await makeTestDirectory([
    "IMG_12.jpg",
    "IMG_12.jpg.xmp",
    "IMG_12.mov",
  ]);
  try {
    const rename = async (from, to) => {
      if (path.basename(from) === "IMG_12.mov") {
        throw new Error("The file is in use.");
      }
      await fs.rename(from, to);
    };
    await assert.rejects(
      setDoNotUpload(
        {
          frontPath: path.join(dir, "IMG_12.jpg"),
          backPath: null,
          value: true,
        },
        { rename },
      ),
      /IMG_12\.mov: The file is in use\. No files were renamed\./,
    );
    assert.deepEqual(await list(), [
      "IMG_12.jpg",
      "IMG_12.jpg.xmp",
      "IMG_12.mov",
    ]);
  } finally {
    await cleanup();
  }
});
