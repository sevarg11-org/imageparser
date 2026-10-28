import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import sharp from "sharp";
import {
  applyImageRotations,
  getThumbnail,
  normalizeThumbnailSize,
  readDirectory,
  renderThumbnail,
  shutdownCore,
} from "./core.js";

after(() => shutdownCore());

/**
 * Builds an XMP sidecar holding the given xmp:CreateDate, or no date when omitted.
 */
const makeSidecar = (
  createDate,
) => `<?xpacket begin='﻿' id='W5M0MpCehiHzreSzNTczkc9d'?>
<x:xmpmeta xmlns:x='adobe:ns:meta/'>
<rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>
${
  createDate
    ? ` <rdf:Description rdf:about='' xmlns:xmp='http://ns.adobe.com/xap/1.0/'>
  <xmp:CreateDate>${createDate}</xmp:CreateDate>
 </rdf:Description>`
    : ""
}
</rdf:RDF>
</x:xmpmeta>
<?xpacket end='w'?>`;

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
const writePng = (filePath, width, height) =>
  sharp({
    create: { width, height, channels: 3, background: "#3366cc" },
  })
    .png()
    .toFile(filePath);

test("renderThumbnail returns a WebP no larger than 320 px on the long edge", async () => {
  const { dir, cleanup } = await makeTestDirectory();
  try {
    const imagePath = path.join(dir, "wide_a.png");
    await writePng(imagePath, 800, 400);

    const metadata = await sharp(await renderThumbnail(imagePath)).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.width, 320);
    assert.equal(metadata.height, 160);
  } finally {
    await cleanup();
  }
});

test("renderThumbnail applies the requested rotation", async () => {
  const { dir, cleanup } = await makeTestDirectory();
  try {
    const imagePath = path.join(dir, "wide_a.png");
    await writePng(imagePath, 800, 400);

    const metadata = await sharp(
      await renderThumbnail(imagePath, { rotation: 90 }),
    ).metadata();
    assert.equal(metadata.width, 160);
    assert.equal(metadata.height, 320);
  } finally {
    await cleanup();
  }
});

test("renderThumbnail does not enlarge small images", async () => {
  const { dir, cleanup } = await makeTestDirectory();
  try {
    const imagePath = path.join(dir, "small_a.png");
    await writePng(imagePath, 100, 50);

    const metadata = await sharp(await renderThumbnail(imagePath)).metadata();
    assert.equal(metadata.width, 100);
    assert.equal(metadata.height, 50);
  } finally {
    await cleanup();
  }
});

test("normalizeThumbnailSize defaults invalid sizes and clamps large ones", () => {
  assert.equal(normalizeThumbnailSize(undefined), 320);
  assert.equal(normalizeThumbnailSize("abc"), 320);
  assert.equal(normalizeThumbnailSize("200"), 200);
  assert.equal(normalizeThumbnailSize(10_000), 640);
  assert.equal(normalizeThumbnailSize(1), 64);
});

test("readDirectory returns sidecarDate from both sidecar namings, or an empty string", async () => {
  const { dir, cleanup } = await makeTestDirectory();
  try {
    const files = {
      "one_a.jpg": Buffer.alloc(0),
      "one_a.jpg.xmp": makeSidecar("1991-12-25T10:30:00"),
      "two_a.jpg": Buffer.alloc(0),
      "two_a.xmp": makeSidecar("1985:07:04 08:00:00"),
      "three_a.jpg": Buffer.alloc(0),
      "four_a.jpg": Buffer.alloc(0),
      "four_a.jpg.xmp": makeSidecar(""),
      // Only the B side has a date; the A sidecar is the source of truth.
      "five_a.jpg": Buffer.alloc(0),
      "five_b.jpg": Buffer.alloc(0),
      "five_b.jpg.xmp": makeSidecar("2001-01-01T00:00:00"),
    };
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(dir, name), content);
    }

    const { files: pairs } = await readDirectory(dir);
    const byLabel = Object.fromEntries(
      pairs.map((pair) => [
        pair.imageLabel,
        { sidecarDate: pair.sidecarDate, hasSidecar: pair.hasSidecar },
      ]),
    );
    assert.deepEqual(byLabel, {
      "one_a.jpg": { sidecarDate: "1991-12-25", hasSidecar: true },
      "two_a.jpg": { sidecarDate: "1985-07-04", hasSidecar: true },
      "three_a.jpg": { sidecarDate: "", hasSidecar: false },
      "four_a.jpg": { sidecarDate: "", hasSidecar: true },
      "five_a.jpg": { sidecarDate: "", hasSidecar: false },
    });
    for (const pair of pairs) {
      assert.equal(typeof pair.frontVersion, "string");
    }
  } finally {
    await cleanup();
  }
});

test("readDirectory still sorts by the B date when the A sidecar has none", async () => {
  const { dir, cleanup } = await makeTestDirectory();
  try {
    await fs.writeFile(path.join(dir, "late_a.jpg"), Buffer.alloc(0));
    await fs.writeFile(
      path.join(dir, "late_a.jpg.xmp"),
      makeSidecar("2020-01-01T00:00:00"),
    );
    await fs.writeFile(path.join(dir, "early_a.jpg"), Buffer.alloc(0));
    await fs.writeFile(path.join(dir, "early_b.jpg"), Buffer.alloc(0));
    await fs.writeFile(
      path.join(dir, "early_b.jpg.xmp"),
      makeSidecar("1990-01-01T00:00:00"),
    );

    const { files: pairs } = await readDirectory(dir, "dateTaken-asc");
    assert.deepEqual(
      pairs.map((pair) => pair.imageLabel),
      ["early_a.jpg", "late_a.jpg"],
    );
  } finally {
    await cleanup();
  }
});

test("getThumbnail serves the cache for the same revision and renders again for a new one", async () => {
  const { dir, cleanup } = await makeTestDirectory();
  try {
    const imagePath = path.join(dir, "cached_a.png");
    await writePng(imagePath, 600, 300);

    const first = await getThumbnail(imagePath);
    const second = await getThumbnail(imagePath);
    assert.equal(second, first, "the cached buffer is reused");

    const rotation = await applyImageRotations({
      frontPath: imagePath,
      backPath: null,
      frontRotation: 90,
      backRotation: 0,
    });
    assert.equal(rotation.ok, true);

    const third = await getThumbnail(imagePath);
    assert.notEqual(third, first, "a rotated image is rendered again");
    const metadata = await sharp(third).metadata();
    assert.equal(metadata.width, 160);
    assert.equal(metadata.height, 320);
  } finally {
    await cleanup();
  }
});

test("getThumbnail does not render when its signal is already aborted", async () => {
  const { dir, cleanup } = await makeTestDirectory();
  try {
    const imagePath = path.join(dir, "aborted_a.png");
    await writePng(imagePath, 200, 200);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      getThumbnail(imagePath, { signal: controller.signal }),
      { name: "AbortError" },
    );
  } finally {
    await cleanup();
  }
});
