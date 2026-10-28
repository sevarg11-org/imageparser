import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import {
  getGroupKey,
  readDirectory,
  setDoNotUpload,
  setFolderDate,
  shutdownCore,
  toExcludedName,
  toIncludedName,
} from "./core.js";

after(() => shutdownCore());

/**
 * Creates a temporary directory holding empty files with the given names.
 * Returns the directory path, a helper to list its files, and a cleanup function.
 */
const makeTestDirectory = async (fileNames) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "imageparser-dnu-"));
  for (const name of fileNames) {
    await fs.writeFile(path.join(dir, name), Buffer.alloc(0));
  }
  return {
    dir,
    list: async () => (await fs.readdir(dir)).sort(),
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
};

const namingTable = [
  ["img001_a.jpg", "img001_exclude_a.jpg"],
  ["img001_b.jpg", "img001_exclude_b.jpg"],
  ["img001_a.jpg.xmp", "img001_exclude_a.jpg.xmp"],
  ["img001_a.xmp", "img001_exclude_a.xmp"],
  ["img001_front.tif", "img001_exclude_front.tif"],
  ["img001.jpg", "img001_exclude.jpg"],
  ["img001.jpg.xmp", "img001_exclude.jpg.xmp"],
  ["img001-a.jpg", "img001_exclude-a.jpg"],
  ["IMG001_A.JPG", "IMG001_exclude_A.JPG"],
  ["scan.2024_back.png", "scan.2024_exclude_back.png"],
];

test("adds and removes the exclude marker before the side suffix", () => {
  for (const [original, flagged] of namingTable) {
    assert.equal(toExcludedName(original), flagged, original);
    assert.equal(toIncludedName(flagged), original, flagged);
  }
});

test("leaves names unchanged when the marker is already in the wanted state", () => {
  assert.equal(toExcludedName("img001_exclude_a.jpg"), "img001_exclude_a.jpg");
  assert.equal(toIncludedName("img001_a.jpg"), "img001_a.jpg");
  assert.equal(toIncludedName("exclude.jpg"), "exclude.jpg");
});

test("groups a flagged side with an unflagged side", () => {
  assert.equal(getGroupKey("x_exclude_a.jpg"), getGroupKey("x_b.jpg"));
  assert.equal(getGroupKey("x_exclude.jpg"), getGroupKey("x.jpg"));
});

test("flags and clears a pair with both sidecar namings", async () => {
  const { dir, list, cleanup } = await makeTestDirectory([
    "img001_a.jpg",
    "img001_b.jpg",
    "img001_a.jpg.xmp",
    "img001_b.xmp",
    "img002_a.jpg",
  ]);
  try {
    const flagged = await setDoNotUpload({
      frontPath: path.join(dir, "img001_a.jpg"),
      backPath: path.join(dir, "img001_b.jpg"),
      value: true,
    });
    assert.equal(flagged.ok, true);
    assert.equal(flagged.doNotUpload, true);
    assert.equal(flagged.excludeMismatch, false);
    assert.equal(flagged.frontPath, path.join(dir, "img001_exclude_a.jpg"));
    assert.equal(flagged.backPath, path.join(dir, "img001_exclude_b.jpg"));
    assert.equal(flagged.renamed.length, 4);
    assert.deepEqual(await list(), [
      "img001_exclude_a.jpg",
      "img001_exclude_a.jpg.xmp",
      "img001_exclude_b.jpg",
      "img001_exclude_b.xmp",
      "img002_a.jpg",
    ]);

    const { files } = await readDirectory(dir, "fileName-asc");
    assert.equal(files.length, 2);
    assert.equal(files[0].doNotUpload, true);
    assert.equal(files[0].backPath, path.join(dir, "img001_exclude_b.jpg"));
    assert.equal(files[1].doNotUpload, false);

    const cleared = await setDoNotUpload({
      frontPath: flagged.frontPath,
      backPath: flagged.backPath,
      value: false,
    });
    assert.equal(cleared.doNotUpload, false);
    assert.deepEqual(await list(), [
      "img001_a.jpg",
      "img001_a.jpg.xmp",
      "img001_b.jpg",
      "img001_b.xmp",
      "img002_a.jpg",
    ]);
  } finally {
    await cleanup();
  }
});

test("flags a single image without a side suffix", async () => {
  const { dir, list, cleanup } = await makeTestDirectory([
    "img001.jpg",
    "img001.jpg.xmp",
  ]);
  try {
    await setDoNotUpload({
      frontPath: path.join(dir, "img001.jpg"),
      backPath: null,
      value: true,
    });
    assert.deepEqual(await list(), [
      "img001_exclude.jpg",
      "img001_exclude.jpg.xmp",
    ]);
  } finally {
    await cleanup();
  }
});

test("renames nothing when a target name already exists", async () => {
  const { dir, list, cleanup } = await makeTestDirectory([
    "img001_a.jpg",
    "img001_b.jpg",
    "img001_exclude_b.jpg",
  ]);
  try {
    await assert.rejects(
      setDoNotUpload({
        frontPath: path.join(dir, "img001_a.jpg"),
        backPath: path.join(dir, "img001_b.jpg"),
        value: true,
      }),
      /img001_exclude_b\.jpg already exists/,
    );
    assert.deepEqual(await list(), [
      "img001_a.jpg",
      "img001_b.jpg",
      "img001_exclude_b.jpg",
    ]);
  } finally {
    await cleanup();
  }
});

test("undoes earlier renames when a later rename fails", async () => {
  const { dir, list, cleanup } = await makeTestDirectory([
    "img001_a.jpg",
    "img001_b.jpg",
    "img001_a.jpg.xmp",
  ]);
  let calls = 0;
  const failingRename = async (from, to) => {
    calls += 1;
    if (calls === 3) {
      throw new Error("Simulated failure.");
    }
    await fs.rename(from, to);
  };
  try {
    await assert.rejects(
      setDoNotUpload(
        {
          frontPath: path.join(dir, "img001_a.jpg"),
          backPath: path.join(dir, "img001_b.jpg"),
          value: true,
        },
        { rename: failingRename },
      ),
      /Simulated failure\. No files were renamed\./,
    );
    assert.deepEqual(await list(), [
      "img001_a.jpg",
      "img001_a.jpg.xmp",
      "img001_b.jpg",
    ]);
  } finally {
    await cleanup();
  }
});

test("lists current file names when a rollback also fails", async () => {
  const { dir, cleanup } = await makeTestDirectory([
    "img001_a.jpg",
    "img001_b.jpg",
  ]);
  let calls = 0;
  const failingRename = async (from, to) => {
    calls += 1;
    if (calls >= 2) {
      throw new Error("Simulated failure.");
    }
    await fs.rename(from, to);
  };
  try {
    await assert.rejects(
      setDoNotUpload(
        {
          frontPath: path.join(dir, "img001_a.jpg"),
          backPath: path.join(dir, "img001_b.jpg"),
          value: true,
        },
        { rename: failingRename },
      ),
      (error) => {
        assert.match(error.message, /could not be undone/);
        assert.match(
          error.message,
          /img001_a\.jpg is now img001_exclude_a\.jpg/,
        );
        assert.match(error.message, /img001_b\.jpg is now img001_b\.jpg/);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("reports and repairs a group with only one side flagged", async () => {
  const { dir, list, cleanup } = await makeTestDirectory([
    "x_exclude_a.jpg",
    "x_b.jpg",
  ]);
  try {
    const { files } = await readDirectory(dir);
    assert.equal(files.length, 1);
    assert.equal(files[0].doNotUpload, true);
    assert.equal(files[0].excludeMismatch, true);

    const result = await setDoNotUpload({
      frontPath: files[0].frontPath,
      backPath: files[0].backPath,
      value: false,
    });
    assert.equal(result.excludeMismatch, false);
    assert.deepEqual(await list(), ["x_a.jpg", "x_b.jpg"]);
  } finally {
    await cleanup();
  }
});

test("rejects a back image from a different group", async () => {
  const { dir, list, cleanup } = await makeTestDirectory([
    "img001_a.jpg",
    "img002_b.jpg",
  ]);
  try {
    await assert.rejects(
      setDoNotUpload({
        frontPath: path.join(dir, "img001_a.jpg"),
        backPath: path.join(dir, "img002_b.jpg"),
        value: true,
      }),
      /same group/,
    );
    assert.deepEqual(await list(), ["img001_a.jpg", "img002_b.jpg"]);
  } finally {
    await cleanup();
  }
});

test("set date for folder skips flagged groups", async () => {
  const { dir, list, cleanup } = await makeTestDirectory([
    "img001_exclude_a.jpg",
  ]);
  try {
    const result = await setFolderDate(dir, "1991-12-31");
    assert.equal(result.ok, true);
    assert.equal(result.updatedPairs, 0);
    assert.equal(result.excludedPairs, 1);
    assert.deepEqual(await list(), ["img001_exclude_a.jpg"]);
  } finally {
    await cleanup();
  }
});
