import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import {
  buildImmichUploadArguments,
  readDirectory,
  scanImageFiles,
  setDoNotUpload,
  setFolderDate,
  shutdownCore,
} from "./core.js";

after(() => shutdownCore());

/**
 * Creates a temporary folder tree holding empty files at the given relative paths.
 * Returns the root path and a cleanup function.
 */
const makeTree = async (relativePaths) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "imageparser-nested-"));
  for (const relativePath of relativePaths) {
    const filePath = path.join(root, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.alloc(0));
  }
  return {
    root,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
};

// Junctions need no extra privileges on Windows; other platforms ignore the type.
const linkFolder = (target, linkPath) =>
  fs.symlink(target, linkPath, "junction");

test("pairs images only within their own folder in nested mode", async () => {
  const { root, cleanup } = await makeTree([
    "a/x_a.jpg",
    "a/x_b.jpg",
    "b/x_a.jpg",
  ]);
  try {
    const result = await readDirectory(root, "fileName-asc", {
      recursive: true,
    });

    assert.equal(result.recursive, true);
    assert.equal(result.folderCount, 3);
    assert.deepEqual(
      result.files.map((pair) => [
        pair.imageLabel,
        pair.relativeDirectory,
        pair.backPath ? path.basename(pair.backPath) : null,
      ]),
      [
        ["a/x_a.jpg", "a", "x_b.jpg"],
        ["b/x_a.jpg", "b", null],
      ],
    );
    assert.notEqual(result.files[0].id, result.files[1].id);
  } finally {
    await cleanup();
  }
});

test("ignores subfolders when nested mode is off", async () => {
  const { root, cleanup } = await makeTree(["top_a.jpg", "a/x_a.jpg"]);
  try {
    const result = await readDirectory(root, "fileName-asc");

    assert.equal(result.recursive, false);
    assert.equal(result.folderCount, 1);
    assert.equal(result.hasSubfolders, true);
    assert.deepEqual(
      result.files.map((pair) => [pair.imageLabel, pair.relativeDirectory]),
      [["top_a.jpg", ""]],
    );
  } finally {
    await cleanup();
  }
});

test("groups by folder depth-first in natural order, with the selected folder first", async () => {
  const { root, cleanup } = await makeTree([
    "10/z.jpg",
    "2/b.jpg",
    "2/a.jpg",
    "2/sub/c.jpg",
    "z.jpg",
    "a.jpg",
  ]);
  try {
    const descending = await readDirectory(root, "fileName-desc", {
      recursive: true,
    });

    // The sort direction applies inside each folder; the folder order stays the same.
    assert.deepEqual(
      descending.files.map((pair) => pair.imageLabel),
      ["z.jpg", "a.jpg", "2/b.jpg", "2/a.jpg", "2/sub/c.jpg", "10/z.jpg"],
    );
  } finally {
    await cleanup();
  }
});

test("skips hidden folders in nested mode", async () => {
  const { root, cleanup } = await makeTree([
    "visible/a.jpg",
    ".thumbnails/b.jpg",
  ]);
  try {
    const result = await readDirectory(root, "fileName-asc", {
      recursive: true,
    });

    assert.deepEqual(
      result.files.map((pair) => pair.imageLabel),
      ["visible/a.jpg"],
    );
    assert.equal(result.folderCount, 2);
  } finally {
    await cleanup();
  }
});

test("skips linked folders whose real path is not allowed", async () => {
  const shared = await makeTree(["inside/a.jpg"]);
  const outside = await makeTree(["secret.jpg"]);
  try {
    await linkFolder(outside.root, path.join(shared.root, "escape"));
    const realRoot = await fs.realpath(shared.root);

    const result = await readDirectory(shared.root, "fileName-asc", {
      recursive: true,
      isAllowedPath: (realPath) =>
        realPath === realRoot || realPath.startsWith(realRoot + path.sep),
    });

    assert.deepEqual(
      result.files.map((pair) => pair.imageLabel),
      ["inside/a.jpg"],
    );
  } finally {
    await shared.cleanup();
    await outside.cleanup();
  }
});

test("visits each real folder once, so link loops end", async () => {
  const { root, cleanup } = await makeTree(["a/x.jpg"]);
  try {
    await linkFolder(root, path.join(root, "a", "loop"));

    const result = await readDirectory(root, "fileName-asc", {
      recursive: true,
    });

    assert.deepEqual(
      result.files.map((pair) => pair.imageLabel),
      ["a/x.jpg"],
    );
    assert.equal(result.folderCount, 2);
  } finally {
    await cleanup();
  }
});

test("stops with an error when the scan finds too many images", async () => {
  const { root, cleanup } = await makeTree(["a.jpg", "b/c.jpg", "b/d.jpg"]);
  try {
    await assert.rejects(
      scanImageFiles(root, { recursive: true, maxFiles: 2 }),
      /more than 2 images/,
    );
    const { imageFiles } = await scanImageFiles(root, {
      recursive: true,
      maxFiles: 3,
    });
    assert.equal(imageFiles.length, 3);
  } finally {
    await cleanup();
  }
});

test("stops with an error when nested folders are too deep", async () => {
  const { root, cleanup } = await makeTree(["1/2/3/a.jpg"]);
  try {
    await assert.rejects(
      scanImageFiles(root, { recursive: true, maxDepth: 2 }),
      /more than 2 levels deep/,
    );
    const { folderCount } = await scanImageFiles(root, {
      recursive: true,
      maxDepth: 3,
    });
    assert.equal(folderCount, 4);
  } finally {
    await cleanup();
  }
});

test("collects tag suggestions from nested sidecars", async () => {
  const { root, cleanup } = await makeTree(["a/x.jpg"]);
  try {
    await fs.writeFile(
      path.join(root, "a", "x.jpg.xmp"),
      `<digiKam:TagsList><rdf:Seq><rdf:li>Christmas</rdf:li></rdf:Seq></digiKam:TagsList>`,
    );

    const nested = await readDirectory(root, "fileName-asc", {
      recursive: true,
    });
    const flat = await readDirectory(root, "fileName-asc");

    assert.deepEqual(nested.recentTags, ["Christmas"]);
    assert.deepEqual(flat.recentTags, []);
  } finally {
    await cleanup();
  }
});

test("uploads nested folders recursively and keeps the Do not upload bans", () => {
  const settings = {
    serverUrl: "https://immich.example.test",
    userApiKey: "user-key",
    albumName: "Scans",
    tags: "",
    pauseImmichJobs: true,
    concurrentTasks: 2,
  };

  const nested = buildImmichUploadArguments(settings, "/data/1990s", {
    recursive: true,
  });
  const flat = buildImmichUploadArguments(settings, "/data/1990s");

  assert.ok(nested.includes("--recursive=true"));
  assert.ok(!nested.includes("--recursive=false"));
  assert.ok(flat.includes("--recursive=false"));
  assert.deepEqual(
    nested.filter((_value, index, all) => all[index - 1] === "--ban-file"),
    ["**_b.**", "**_exclude_**", "**_exclude.**"],
  );
});

test("sets the folder date in nested folders only in nested mode", async () => {
  const { root, cleanup } = await makeTree([]);
  try {
    // ExifTool needs real JPEGs to embed the date.
    const fixture = path.join(".smoke-test", "sample_pair_a.jpg");
    await fs.mkdir(path.join(root, "a"));
    await fs.copyFile(fixture, path.join(root, "top.jpg"));
    await fs.copyFile(fixture, path.join(root, "a", "nested.jpg"));

    const flat = await setFolderDate(root, "1991-12-25");
    assert.equal(flat.updatedPairs, 1, flat.errors.join("; "));

    const nested = await setFolderDate(root, "1991-12-25", {
      recursive: true,
    });
    assert.equal(nested.updatedPairs, 1, nested.errors.join("; "));
    assert.equal(nested.skippedPairs, 1);
    assert.ok(
      (await fs.readdir(path.join(root, "a"))).includes("nested.jpg.xmp"),
    );
  } finally {
    await cleanup();
  }
});

test("keeps the folder in the id and label after a Do not upload rename", async () => {
  const { root, cleanup } = await makeTree(["a/x_a.jpg"]);
  try {
    const result = await setDoNotUpload({
      frontPath: path.join(root, "a", "x_a.jpg"),
      backPath: null,
      value: true,
      relativeDirectory: "a",
    });

    assert.equal(result.imageLabel, "a/x_exclude_a.jpg");
    assert.equal(result.relativeDirectory, "a");
    assert.ok(result.id.startsWith("a/"));
  } finally {
    await cleanup();
  }
});
