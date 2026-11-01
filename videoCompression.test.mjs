import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import {
  compressFolderVideos,
  loadImmichSettings,
  runImmichUpload,
  runVideoCompression,
  saveImmichSettings,
  shutdownCore,
} from "./core.js";
import {
  buildCompressionArguments,
  defaultVideoCompression,
  normalizeVideoCompression,
  videoCompressionLimits,
} from "./videoMedia.js";

after(() => shutdownCore());

test("the browser's compression limits and defaults match the server's", async () => {
  const model = await import("./src/videoModel.ts");
  assert.deepEqual(
    JSON.parse(JSON.stringify(model.VIDEO_COMPRESSION_LIMITS)),
    JSON.parse(JSON.stringify(videoCompressionLimits)),
  );
  assert.deepEqual(model.DEFAULT_VIDEO_COMPRESSION, {
    ...defaultVideoCompression,
  });
});

const settings = normalizeVideoCompression({ enabled: true });

/** Creates a temporary folder with files of the given sizes (in bytes). */
const makeTestDirectory = async (files) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "imageparser-compress-"));
  for (const [name, size] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), Buffer.alloc(size, 7));
  }
  return {
    dir,
    list: async () => (await fs.readdir(dir)).sort(),
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
};

/**
 * A fake encoder and probe: sources are 10-second videos, the encoder writes `outputBytes` bytes, and the
 * compressed file probes with `outputDuration` seconds. Every encode is recorded.
 */
const makeFakes = ({
  outputBytes = 10,
  outputDuration = 10,
  compressedSources = [],
} = {}) => {
  const encodes = [];
  return {
    encodes,
    compress: async (input, output, _settings, options) => {
      encodes.push({ input, output, options });
      options.onProgress?.(0.5);
      await fs.writeFile(output, Buffer.alloc(outputBytes, 1));
    },
    probe: async (filePath) => {
      const isTemporary = filePath.endsWith(".imageparser-compress.tmp");
      return {
        durationSeconds: isTemporary ? outputDuration : 10,
        videoCodec: "h264",
        audioCodec: "aac",
        width: 720,
        height: 480,
        compressedByImageParser: compressedSources.includes(
          path.basename(filePath),
        ),
        creationTime: null,
      };
    },
  };
};

test("compression settings default to H.264 CRF 21, medium, 160 kbps, and stay in the recommended ranges", () => {
  assert.deepEqual(normalizeVideoCompression(undefined), {
    ...defaultVideoCompression,
  });
  assert.deepEqual(normalizeVideoCompression({ enabled: true }), {
    enabled: true,
    codec: "h264",
    crf: 21,
    preset: "medium",
    audioBitrateKbps: 160,
  });
  assert.equal(normalizeVideoCompression({ codec: "h265" }).crf, 24);
  assert.equal(normalizeVideoCompression({ codec: "bogus" }).codec, "h264");
  assert.equal(
    normalizeVideoCompression({ codec: "h264", crf: 23, preset: "slow" })
      .preset,
    "slow",
  );
  assert.throws(
    () => normalizeVideoCompression({ codec: "h265", crf: 22 }),
    /23 through 26/,
  );
  assert.throws(
    () => normalizeVideoCompression({ codec: "h264", crf: 24 }),
    /20 through 23/,
  );
  assert.throws(
    () => normalizeVideoCompression({ preset: "ultrafast" }),
    /medium or slow/,
  );
  assert.throws(
    () => normalizeVideoCompression({ audioBitrateKbps: 320 }),
    /128 through 192/,
  );
});

test("the ffmpeg arguments follow the recommended settings", () => {
  const input = path.resolve("tape.mov");
  const output = path.resolve(".tape.tmp");
  const args = buildCompressionArguments(input, output, settings, {
    creationTime: "1994-12-25T18:30:00.000Z",
  });
  const valueAfter = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(valueAfter("-i"), `file:${input}`);
  assert.equal(args.at(-1), `file:${output}`);
  assert.equal(valueAfter("-f"), "mp4");
  assert.equal(valueAfter("-c:v"), "libx264");
  assert.equal(valueAfter("-profile:v"), "high");
  assert.equal(valueAfter("-pix_fmt"), "yuv420p");
  assert.equal(valueAfter("-crf"), "21");
  assert.equal(valueAfter("-preset"), "medium");
  assert.equal(valueAfter("-fps_mode"), "cfr");
  assert.ok(!args.includes("-r"), "the source frame rate is kept");
  assert.equal(valueAfter("-vf"), "scale=trunc(iw/2)*2:trunc(ih/2)*2");
  assert.equal(valueAfter("-c:a"), "aac");
  assert.equal(valueAfter("-profile:a"), "aac_low");
  assert.equal(valueAfter("-b:a"), "160k");
  assert.ok(args.includes("creation_time=1994-12-25T18:30:00.000Z"));
  assert.ok(args.includes("imageparser_compressed=1"));

  const h265 = buildCompressionArguments(
    input,
    output,
    normalizeVideoCompression({ codec: "h265", crf: 23, preset: "slow" }),
  );
  assert.equal(h265[h265.indexOf("-c:v") + 1], "libx265");
  assert.equal(h265[h265.indexOf("-tag:v") + 1], "hvc1");
  assert.equal(h265[h265.indexOf("-crf") + 1], "23");
  assert.equal(h265[h265.indexOf("-preset") + 1], "slow");
  assert.ok(!h265.some((arg) => arg.startsWith("creation_time=")));
});

test("a .mov is replaced by a smaller .mp4 and its sidecar follows", async () => {
  const { dir, list, cleanup } = await makeTestDirectory({
    "tape.mov": 1000,
    "tape.mov.xmp": 5,
    "photo.jpg": 50,
  });
  const fakes = makeFakes();
  try {
    const sourceTime = new Date("2001-02-03T04:05:06Z");
    await fs.utimes(path.join(dir, "tape.mov"), sourceTime, sourceTime);
    const progress = [];
    const result = await compressFolderVideos(dir, settings, {
      ...fakes,
      onProgress: (update) => progress.push(update.fraction),
    });
    assert.equal(result.ok, true, result.errors.join("; "));
    assert.deepEqual(result.compressed, [
      {
        status: "compressed",
        from: path.join(dir, "tape.mov"),
        to: path.join(dir, "tape.mp4"),
        originalBytes: 1000,
        compressedBytes: 10,
      },
    ]);
    assert.deepEqual(await list(), ["photo.jpg", "tape.mp4", "tape.mp4.xmp"]);
    assert.equal((await fs.stat(path.join(dir, "photo.jpg"))).size, 50);
    assert.equal(
      (await fs.stat(path.join(dir, "tape.mp4"))).mtimeMs,
      sourceTime.getTime(),
      "the file date is kept",
    );
    assert.deepEqual(progress, [0, 0.5]);
    assert.ok(fakes.encodes[0].options.creationTime, "a date is recorded");
  } finally {
    await cleanup();
  }
});

test("an .mp4 is replaced in place", async () => {
  const { dir, list, cleanup } = await makeTestDirectory({ "clip.mp4": 500 });
  try {
    const result = await compressFolderVideos(dir, settings, makeFakes());
    assert.equal(result.compressed[0].to, path.join(dir, "clip.mp4"));
    assert.deepEqual(await list(), ["clip.mp4"]);
    assert.equal((await fs.stat(path.join(dir, "clip.mp4"))).size, 10);
  } finally {
    await cleanup();
  }
});

test("the original is kept when compressing does not make it smaller", async () => {
  const { dir, list, cleanup } = await makeTestDirectory({ "small.mov": 8 });
  try {
    const result = await compressFolderVideos(
      dir,
      settings,
      makeFakes({ outputBytes: 20 }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.compressed.length, 0);
    assert.match(result.skipped[0].reason, /did not make it smaller/);
    assert.deepEqual(await list(), ["small.mov"]);
  } finally {
    await cleanup();
  }
});

test("the original is kept when the compressed video is incomplete", async () => {
  const { dir, list, cleanup } = await makeTestDirectory({ "tape.mov": 1000 });
  try {
    const result = await compressFolderVideos(
      dir,
      settings,
      makeFakes({ outputDuration: 4 }),
    );
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /incomplete/);
    assert.deepEqual(await list(), ["tape.mov"]);
  } finally {
    await cleanup();
  }
});

test("an existing .mp4 of the same name stops the replacement", async () => {
  const { dir, list, cleanup } = await makeTestDirectory({
    "tape.mov": 1000,
    "tape.mp4": 900,
  });
  const fakes = makeFakes();
  try {
    const result = await compressFolderVideos(dir, settings, fakes);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /tape\.mov: tape\.mp4 already exists/);
    assert.deepEqual(await list(), ["tape.mov", "tape.mp4"]);
    assert.equal(
      fakes.encodes.filter((encode) => encode.input.endsWith("tape.mov"))
        .length,
      0,
      "nothing is encoded when the result would have nowhere to go",
    );
  } finally {
    await cleanup();
  }
});

test("live photo videos, excluded videos, and compressed videos are left alone", async () => {
  const { dir, list, cleanup } = await makeTestDirectory({
    "IMG_1.jpg": 50,
    "IMG_1.mov": 1000,
    "skip_exclude.mov": 1000,
    "done.mp4": 1000,
  });
  const fakes = makeFakes({ compressedSources: ["done.mp4"] });
  try {
    const result = await compressFolderVideos(dir, settings, fakes);
    assert.equal(result.ok, true);
    assert.equal(result.compressed.length, 0);
    assert.deepEqual(
      result.skipped.map((item) => [path.basename(item.filePath), item.reason]),
      [["done.mp4", "it was already compressed"]],
    );
    assert.equal(fakes.encodes.length, 0);
    assert.deepEqual(await list(), [
      "IMG_1.jpg",
      "IMG_1.mov",
      "done.mp4",
      "skip_exclude.mov",
    ]);
  } finally {
    await cleanup();
  }
});

test("the upload does not start when a video cannot be compressed", async () => {
  // An empty file is not a readable video, so compression fails before immich-go would run.
  const { dir, list, cleanup } = await makeTestDirectory({ "broken.mov": 0 });
  const phases = [];
  try {
    const result = await runImmichUpload(
      {
        serverUrl: "https://immich.example.test",
        userApiKey: "key",
        albumName: "Tapes",
        concurrentTasks: 1,
        videoCompression: { enabled: true },
      },
      dir,
      (progress) => phases.push(progress.phase),
    );
    assert.equal(result.ok, false);
    assert.equal(result.compressedVideos, 0);
    assert.match(result.output, /broken\.mov: ffprobe could not read/);
    assert.match(result.output, /The upload did not start/);
    assert.ok(!phases.includes("uploading"));
    assert.deepEqual(await list(), ["broken.mov"]);
  } finally {
    await cleanup();
  }
});

test("videos can be compressed without Immich settings or an upload", async () => {
  // compression "enabled: false" is ignored: the caller asked to compress now.
  const { dir, list, cleanup } = await makeTestDirectory({
    "broken.mov": 0,
    "photo.jpg": 5,
  });
  const phases = [];
  try {
    const result = await runVideoCompression(
      { enabled: false, codec: "h264", crf: 21 },
      dir,
      (progress) => phases.push(progress.phase),
    );
    assert.equal(result.ok, false);
    assert.equal(result.compressedVideos, 0);
    assert.match(result.output, /broken\.mov: ffprobe could not read/);
    assert.match(result.output, /failed: 1/);
    assert.doesNotMatch(result.output, /upload/i);
    assert.ok(phases.length > 0);
    assert.ok(phases.every((phase) => phase === "compressing"));
    assert.deepEqual(await list(), ["broken.mov", "photo.jpg"]);
  } finally {
    await cleanup();
  }
});

test("compression progress lists the videos, then each one's progress and outcome", async () => {
  const { dir, cleanup } = await makeTestDirectory({
    "a.mov": 100,
    "b.mp4": 5,
    "c_exclude.mp4": 100,
  });
  const fakes = makeFakes({ outputBytes: 10 });
  const plans = [];
  const events = [];
  try {
    await compressFolderVideos(dir, settings, {
      ...fakes,
      onPlan: (filePaths) => plans.push(filePaths.map((p) => path.basename(p))),
      onProgress: ({ index, fraction }) =>
        events.push(["progress", index, fraction]),
      onItemDone: ({ index, status }) => events.push(["done", index, status]),
    });
    // The excluded video is not listed; the others are, in order.
    assert.deepEqual(plans, [["a.mov", "b.mp4"]]);
    assert.deepEqual(events, [
      ["progress", 0, 0],
      ["progress", 0, 0.5],
      ["done", 0, "complete"],
      ["progress", 1, 0],
      ["progress", 1, 0.5],
      // b.mp4 is 5 bytes, so the 10-byte result is not smaller and the original is kept.
      ["done", 1, "skipped"],
    ]);
  } finally {
    await cleanup();
  }
});

test("compressing a folder without videos succeeds and changes nothing", async () => {
  const { dir, list, cleanup } = await makeTestDirectory({ "photo.jpg": 5 });
  try {
    const result = await runVideoCompression({}, dir);
    assert.deepEqual(result, {
      ok: true,
      compressedVideos: 0,
      output:
        "Videos compressed: 0, kept as is: 0, failed: 0. Space saved: 0 bytes.",
    });
    assert.deepEqual(await list(), ["photo.jpg"]);
  } finally {
    await cleanup();
  }
});

test("compressing videos rejects bad settings and paths, and releases its lock", async () => {
  const { dir, cleanup } = await makeTestDirectory({ "photo.jpg": 5 });
  try {
    await assert.rejects(
      runVideoCompression({ codec: "h265", crf: 40 }, dir),
      /CRF/,
    );
    await assert.rejects(runVideoCompression({}, ""), /Load a folder/);
    await assert.rejects(
      runVideoCompression({}, path.join(dir, "photo.jpg")),
      /not a directory/,
    );
    // Each failure released the lock, so the next run starts.
    assert.equal((await runVideoCompression({}, dir)).ok, true);
  } finally {
    await cleanup();
  }
});

test("compression settings are saved and loaded with the Immich settings", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "imageparser-settings-"));
  const codec = {
    encrypt: (value) => `x${value}`,
    decrypt: (value) => value.slice(1),
  };
  try {
    await saveImmichSettings(dir, codec, {
      serverUrl: "https://immich.example.test",
      userApiKey: "key",
      albumName: "Tapes",
      concurrentTasks: 2,
      videoCompression: {
        enabled: true,
        codec: "h264",
        crf: 22,
        preset: "slow",
      },
    });
    assert.deepEqual((await loadImmichSettings(dir, codec)).videoCompression, {
      enabled: true,
      codec: "h264",
      crf: 22,
      preset: "slow",
      audioBitrateKbps: 160,
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
