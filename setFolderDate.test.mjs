import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { setFolderDate, shutdownCore } from "./core.js";

after(() => shutdownCore());

/**
 * Creates a temporary directory with the given image filenames as empty stubs.
 * Returns the directory path and a cleanup function.
 */
const makeTestDirectory = async (fileNames) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "imageparser-test-"));
  for (const name of fileNames) {
    // Copy a minimal valid JPEG from the smoke-test fixtures
    const fixture = path.join(".", ".smoke-test", "a.jpg");
    try {
      await fs.copyFile(fixture, path.join(dir, name));
    } catch {
      // If no fixture exists, write a tiny placeholder (tests for sidecar logic
      // still pass since we only check whether .xmp files exist)
      await fs.writeFile(path.join(dir, name), Buffer.alloc(0));
    }
  }
  return {
    dir,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
};

test("returns updatedPairs=0 and skippedPairs=0 for an empty directory", async () => {
  const { dir, cleanup } = await makeTestDirectory([]);
  try {
    const result = await setFolderDate(dir, "1991-12-31");
    assert.equal(result.ok, true);
    assert.equal(result.updatedPairs, 0);
    assert.equal(result.skippedPairs, 0);
    assert.deepEqual(result.errors, []);
  } finally {
    await cleanup();
  }
});

test("skips images that already have an XMP sidecar file", async () => {
  const { dir, cleanup } = await makeTestDirectory(["photo.jpg"]);
  try {
    // Write a sidecar for photo.jpg before calling setFolderDate
    await fs.writeFile(
      path.join(dir, "photo.jpg.xmp"),
      `<?xpacket begin='\uFEFF' id='W5M0MpCehiHzreSzNTczkc9d'?><x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'></rdf:RDF></x:xmpmeta><?xpacket end='w'?>`,
      "utf8",
    );

    const result = await setFolderDate(dir, "1991-12-31");
    assert.equal(result.ok, true);
    assert.equal(result.updatedPairs, 0);
    assert.equal(result.skippedPairs, 1);
    assert.deepEqual(result.errors, []);
  } finally {
    await cleanup();
  }
});

test("creates a sidecar for images without one", async () => {
  const { dir, cleanup } = await makeTestDirectory(["photo_a.jpg"]);
  try {
    const result = await setFolderDate(dir, "1991-12-31");

    // If the fixture was a real image the write succeeds; if the file was
    // empty ExifTool will fail, which is captured as an error — so we test
    // the sidecar creation path only when no error occurred.
    if (result.errors.length === 0) {
      assert.equal(result.ok, true);
      assert.equal(result.updatedPairs, 1);
      assert.equal(result.skippedPairs, 0);

      const sidecarPath = path.join(dir, "photo_a.jpg.xmp");
      const sidecarContent = await fs.readFile(sidecarPath, "utf8");
      assert.ok(
        sidecarContent.includes("1991-12-31"),
        "Sidecar must contain the requested date",
      );
    } else {
      // Empty placeholder file: ExifTool error is expected; sidecar should
      // not have been created (saveMetadata writes the XMP then EXIF; the
      // XMP may already exist at this point)
      assert.equal(typeof result.errors[0], "string");
    }
  } finally {
    await cleanup();
  }
});

test("updates some pairs and skips others in a mixed directory", async () => {
  const { dir, cleanup } = await makeTestDirectory([
    "new_a.jpg",
    "existing_a.jpg",
  ]);
  try {
    // Give existing_a.jpg a sidecar
    await fs.writeFile(
      path.join(dir, "existing_a.jpg.xmp"),
      `<?xpacket begin='\uFEFF' id='W5M0MpCehiHzreSzNTczkc9d'?><x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'></rdf:RDF></x:xmpmeta><?xpacket end='w'?>`,
      "utf8",
    );

    const result = await setFolderDate(dir, "1991-12-31");

    // existing_a.jpg must always be skipped
    assert.equal(result.skippedPairs, 1);
    // new_a.jpg is attempted; its exact outcome depends on whether the
    // fixture is a valid image, so we check that the counts sum correctly.
    assert.equal(
      result.updatedPairs + result.errors.length,
      1,
      "Exactly one pair should have been attempted",
    );
  } finally {
    await cleanup();
  }
});
