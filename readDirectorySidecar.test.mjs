import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { readDirectory, shutdownCore } from "./core.js";

after(() => shutdownCore());

const emptySidecar = `<?xpacket begin='﻿' id='W5M0MpCehiHzreSzNTczkc9d'?><x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'></rdf:RDF></x:xmpmeta><?xpacket end='w'?>`;

/**
 * Creates a temporary directory containing the given files as empty stubs.
 * Returns the directory path and a cleanup function.
 */
const makeTestDirectory = async (fileNames) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "imageparser-test-"));
  for (const name of fileNames) {
    await fs.writeFile(
      path.join(dir, name),
      name.endsWith(".xmp") ? emptySidecar : Buffer.alloc(0),
    );
  }
  return {
    dir,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
};

const sidecarFlagsByLabel = async (dir) => {
  const { files } = await readDirectory(dir);
  return Object.fromEntries(
    files.map((pair) => [pair.imageLabel, pair.hasSidecar]),
  );
};

test("hasSidecar is true for an A file with a name_a.jpg.xmp sidecar", async () => {
  const { dir, cleanup } = await makeTestDirectory([
    "one_a.jpg",
    "one_b.jpg",
    "one_a.jpg.xmp",
  ]);
  try {
    assert.deepEqual(await sidecarFlagsByLabel(dir), { "one_a.jpg": true });
  } finally {
    await cleanup();
  }
});

test("hasSidecar is true for an A file with a legacy name_a.xmp sidecar", async () => {
  const { dir, cleanup } = await makeTestDirectory(["two_a.jpg", "two_a.xmp"]);
  try {
    assert.deepEqual(await sidecarFlagsByLabel(dir), { "two_a.jpg": true });
  } finally {
    await cleanup();
  }
});

test("hasSidecar is false when only the B file has a sidecar", async () => {
  const { dir, cleanup } = await makeTestDirectory([
    "three_a.jpg",
    "three_b.jpg",
    "three_b.jpg.xmp",
    "four.jpg",
  ]);
  try {
    assert.deepEqual(await sidecarFlagsByLabel(dir), {
      "three_a.jpg": false,
      "four.jpg": false,
    });
  } finally {
    await cleanup();
  }
});
