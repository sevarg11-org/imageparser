import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { listDirectory, listDrives, shutdownCore } from "./core.js";

after(() => shutdownCore());

let dir;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "imageparser-list-"));
  for (const folder of ["Folder 10", "Folder 2", "folder 1", ".hidden"]) {
    await fs.mkdir(path.join(dir, folder));
  }
  for (const file of ["a.JPG", "b.tiff", "c.png", "notes.txt", "sidecar.xmp"]) {
    await fs.writeFile(path.join(dir, file), "");
  }
});

after(() => fs.rm(dir, { recursive: true, force: true }));

test("listDirectory lists visible subfolders in natural order", async () => {
  const { directories } = await listDirectory(dir);
  assert.deepEqual(
    directories.map((directory) => directory.name),
    ["folder 1", "Folder 2", "Folder 10"],
  );
  assert.equal(directories[0].path, path.join(dir, "folder 1"));
});

test("listDirectory counts only supported images", async () => {
  const { imageCount } = await listDirectory(dir);
  assert.equal(imageCount, 3);
});

test("listDirectory rejects files and missing paths", async () => {
  await assert.rejects(listDirectory(path.join(dir, "a.JPG")), /not a directory/);
  await assert.rejects(listDirectory(path.join(dir, "missing")));
});

test(
  "listDrives includes the system drive on Windows",
  { skip: process.platform !== "win32" },
  async () => {
    const systemDrive = path.parse(os.homedir()).root.toUpperCase();
    const drives = await listDrives();
    assert.ok(drives.some((drive) => drive.path === systemDrive));
    assert.ok(drives.every((drive) => /^[A-Z]:\\$/.test(drive.path)));
  },
);
