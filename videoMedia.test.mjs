import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  getSeekSpriteFrameCount,
  parseByteRange,
  parseProbeOutput,
  probeVideo,
  seekSpriteLayout,
} from "./videoMedia.js";
import {
  buildSeekStoryboard,
  formatVideoDuration,
  getPlayerSourceType,
  getSeekSpriteFrameCount as getClientFrameCount,
  SEEK_SPRITE_LAYOUT,
} from "./src/videoModel.ts";
import {
  canRotateGridCell,
  describeGridCell,
} from "./src/thumbnailGridModel.ts";

test("parses single byte ranges", () => {
  assert.equal(parseByteRange(undefined, 100), null);
  assert.equal(parseByteRange("", 100), null);
  assert.deepEqual(parseByteRange("bytes=0-", 100), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(parseByteRange("bytes=90-500", 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange("bytes=-500", 100), { start: 0, end: 99 });
});

test("reports unsatisfiable ranges and ignores ones it does not understand", () => {
  assert.equal(parseByteRange("bytes=100-", 100), "unsatisfiable");
  assert.equal(parseByteRange("bytes=50-40", 100), "unsatisfiable");
  assert.equal(parseByteRange("bytes=-0", 100), "unsatisfiable");
  assert.equal(parseByteRange("bytes=0-", 0), "unsatisfiable");
  // Multiple ranges, other units, and garbage fall back to the whole file.
  assert.equal(parseByteRange("bytes=0-1,5-6", 100), null);
  assert.equal(parseByteRange("items=0-1", 100), null);
  assert.equal(parseByteRange("bytes=-", 100), null);
});

test("reads duration and codecs from ffprobe output", () => {
  assert.deepEqual(
    parseProbeOutput(
      JSON.stringify({
        streams: [
          { codec_type: "audio", codec_name: "aac" },
          {
            codec_type: "video",
            codec_name: "hevc",
            width: 1920,
            height: 1080,
          },
        ],
        format: {
          duration: "12.3456",
          tags: {
            creation_time: "1994-12-25T18:30:00.000000Z",
            imageparser_compressed: "1",
          },
        },
      }),
    ),
    {
      durationSeconds: 12.346,
      videoCodec: "hevc",
      audioCodec: "aac",
      width: 1920,
      height: 1080,
      compressedByImageParser: true,
      creationTime: "1994-12-25T18:30:00.000000Z",
    },
  );
  assert.deepEqual(parseProbeOutput("not json"), {
    durationSeconds: null,
    videoCodec: null,
    audioCodec: null,
    width: null,
    height: null,
    compressedByImageParser: false,
    creationTime: null,
  });
});

test("probes local files without a shell and never as options or URLs", async () => {
  const calls = [];
  const run = async (name, args) => {
    calls.push({ name, args });
    return Buffer.from(JSON.stringify({ format: { duration: "3" } }));
  };
  const filePath = path.resolve("-i http-looking name.mov");
  const info = await probeVideo(filePath, { run });
  assert.equal(info.durationSeconds, 3);
  assert.equal(calls[0].name, "ffprobe");
  assert.equal(calls[0].args.at(-1), `file:${filePath}`);
  await assert.rejects(probeVideo("relative.mov", { run }), /absolute/);
});

test("the player's seek-bar layout matches the rendered sprite", () => {
  assert.deepEqual({ ...SEEK_SPRITE_LAYOUT }, { ...seekSpriteLayout });
  for (const duration of [0.4, 1, 7.5, 59, 60, 61, 3600]) {
    assert.equal(
      getClientFrameCount(duration),
      getSeekSpriteFrameCount(duration),
    );
  }
});

test("builds a storyboard with one tile per sprite frame", () => {
  const storyboard = buildSeekStoryboard("sprite.webp", 25);
  assert.equal(storyboard.tileWidth, 160);
  assert.equal(storyboard.tiles.length, 25);
  assert.deepEqual(storyboard.tiles[0], { startTime: 0, x: 0, y: 0 });
  assert.deepEqual(storyboard.tiles[11], { startTime: 11, x: 160, y: 90 });
  assert.equal(buildSeekStoryboard("sprite.webp", 600).tiles.length, 60);
  assert.equal(buildSeekStoryboard("sprite.webp", null), null);
});

test("formats video lengths and player source types", () => {
  assert.equal(formatVideoDuration(null), "");
  assert.equal(formatVideoDuration(7.4), "0:07");
  assert.equal(formatVideoDuration(65), "1:05");
  assert.equal(formatVideoDuration(3723), "1:02:03");
  assert.equal(getPlayerSourceType("/a/IMG_1.MOV"), "video/mp4");
  assert.equal(getPlayerSourceType("/a/clip.mkv"), "video/webm");
});

test("grid cells describe videos and live photos, and only images rotate", () => {
  const base = {
    imageLabel: "clip.mp4",
    date: "2024-07-04",
    isPaired: false,
    doNotUpload: false,
    isUnprocessed: false,
  };
  assert.equal(
    describeGridCell({
      ...base,
      mediaType: "video",
      isLivePhoto: false,
      durationSeconds: 65,
    }),
    "clip.mp4, video, 1:05, dated 2024-07-04",
  );
  assert.equal(
    describeGridCell({
      ...base,
      imageLabel: "IMG_1.jpg",
      mediaType: "image",
      isLivePhoto: true,
      durationSeconds: null,
    }),
    "IMG_1.jpg, live photo, dated 2024-07-04",
  );
  assert.equal(canRotateGridCell({ mediaType: "video" }), false);
  assert.equal(canRotateGridCell({ mediaType: "image" }), true);
});
