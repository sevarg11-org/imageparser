import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before, beforeEach } from "node:test";
import {
  folderStateFileName,
  listDirectory,
  readDirectory,
  readFolderState,
  setFolderProcessed,
  shutdownCore,
} from "./core.js";

after(() => shutdownCore());

let workspace;
let dir;

before(async () => {
  workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "imageparser-processed-"),
  );
});

// Each test starts from a fresh folder tree.
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(workspace, "case-"));
  for (const folder of ["scans/1990", "scans/1991/rolls", "scans/.cache"]) {
    await fs.mkdir(path.join(dir, folder), { recursive: true });
  }
});

after(() => fs.rm(workspace, { recursive: true, force: true }));

const readMarker = async (folder) =>
  JSON.parse(
    await fs.readFile(path.join(folder, folderStateFileName), "utf8"),
  );

test("a folder without a marker file is not processed", async () => {
  assert.deepEqual(await readFolderState(dir), {
    processed: false,
    processedAt: null,
    processedBy: null,
  });
});

test("a corrupt or unexpected marker file counts as not processed", async () => {
  for (const contents of ["{not json", "[true]", "null", '{"processed":"yes"}']) {
    await fs.writeFile(path.join(dir, folderStateFileName), contents);
    assert.equal((await readFolderState(dir)).processed, false, contents);
  }
});

test("marking a folder processed round-trips who and when", async () => {
  const before = Date.now();
  const result = await setFolderProcessed(dir, true, { actor: " dennis " });
  assert.equal(result.ok, true);
  assert.equal(result.updatedFolders, 1);
  assert.equal(result.state.processed, true);
  assert.equal(result.state.processedBy, "dennis");
  assert.ok(Date.parse(result.state.processedAt) >= before - 1000);
  assert.deepEqual(await readFolderState(dir), result.state);

  const marker = await readMarker(dir);
  assert.equal(marker.version, 1);
  assert.equal(marker.processed, true);
});

test("unmarking keeps the marker file and its other fields", async () => {
  await fs.writeFile(
    path.join(dir, folderStateFileName),
    JSON.stringify({ version: 1, processed: true, futureSetting: "kept" }),
  );
  const result = await setFolderProcessed(dir, false, { actor: "dennis" });
  assert.deepEqual(result.state, {
    processed: false,
    processedAt: null,
    processedBy: null,
  });
  const marker = await readMarker(dir);
  assert.equal(marker.processed, false);
  assert.equal(marker.futureSetting, "kept");
  assert.deepEqual(
    (await fs.readdir(dir)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("marking without a user records no name", async () => {
  const result = await setFolderProcessed(dir, true, { actor: "" });
  assert.equal(result.state.processedBy, null);
});

test("marking rejects non-boolean values and missing folders", async () => {
  await assert.rejects(setFolderProcessed(dir, "true"), /true or false/);
  await assert.rejects(setFolderProcessed(path.join(dir, "missing"), true));
});

test("marking with subfolders reaches every visible subfolder", async () => {
  const scans = path.join(dir, "scans");
  const result = await setFolderProcessed(scans, true, {
    actor: "alice",
    includeSubfolders: true,
  });
  assert.equal(result.updatedFolders, 4);
  for (const folder of ["", "1990", "1991", "1991/rolls"]) {
    assert.equal(
      (await readFolderState(path.join(scans, folder))).processed,
      true,
      folder,
    );
  }
  assert.equal(
    (await readFolderState(path.join(scans, ".cache"))).processed,
    false,
  );

  const unmarked = await setFolderProcessed(scans, false, {
    includeSubfolders: false,
  });
  assert.equal(unmarked.updatedFolders, 1);
  assert.equal(
    (await readFolderState(path.join(scans, "1990"))).processed,
    true,
  );
});

test("the listing includes the processed state of each subfolder and itself", async () => {
  const scans = path.join(dir, "scans");
  await setFolderProcessed(path.join(scans, "1991"), true, { actor: "bob" });

  const listing = await listDirectory(scans);
  assert.equal(listing.processed, false);
  assert.deepEqual(
    listing.directories.map(({ name, processed, processedBy }) => ({
      name,
      processed,
      processedBy,
    })),
    [
      { name: "1990", processed: false, processedBy: null },
      { name: "1991", processed: true, processedBy: "bob" },
    ],
  );

  await setFolderProcessed(scans, true, { actor: "bob" });
  assert.equal((await listDirectory(scans)).processed, true);
});

test("readDirectory reports the folder state and whether it has subfolders", async () => {
  const scans = path.join(dir, "scans");
  await setFolderProcessed(scans, true, { actor: "carol" });
  const result = await readDirectory(scans);
  assert.equal(result.folderState.processed, true);
  assert.equal(result.folderState.processedBy, "carol");
  assert.equal(result.hasSubfolders, true);

  const leaf = await readDirectory(path.join(scans, "1990"));
  assert.equal(leaf.folderState.processed, false);
  assert.equal(leaf.hasSubfolders, false);
});

test("the marker file is not listed as an image or a folder", async () => {
  await setFolderProcessed(dir, true);
  const listing = await listDirectory(dir);
  assert.equal(listing.imageCount, 0);
  assert.deepEqual(
    listing.directories.map((directory) => directory.name),
    ["scans"],
  );
  assert.deepEqual((await readDirectory(dir)).files, []);
});
