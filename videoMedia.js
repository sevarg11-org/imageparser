import { spawn } from "node:child_process";
import path from "node:path";
import sharp from "sharp";

/**
 * The longest a single ffprobe or ffmpeg run may take before it is stopped.
 * @type {number}
 */
const mediaCommandTimeoutMs = 60_000;

/**
 * The most bytes a command may write to stdout; a poster or sprite is far smaller.
 * @type {number}
 */
const maxCommandOutputBytes = 64 * 1024 * 1024;

/**
 * The seek-bar sprite layout. src/videoModel.ts builds the same layout for the player, and
 * videoModel.test.mjs keeps the two in step.
 */
export const seekSpriteLayout = Object.freeze({
  columns: 10,
  tileWidth: 160,
  tileHeight: 90,
  maxFrames: 60,
});

/**
 * How many frames a seek-bar sprite holds: about one a second, at most seekSpriteLayout.maxFrames.
 * @param {number} durationSeconds - The video's duration.
 * @returns {number} The frame count, at least 1.
 */
export const getSeekSpriteFrameCount = (durationSeconds) =>
  Math.min(
    seekSpriteLayout.maxFrames,
    Math.max(1, Math.ceil(Number(durationSeconds) || 0)),
  );

/**
 * Loads the path of a binary from an optional npm package that bundles it.
 * @param {string} packageName - ffmpeg-static or ffprobe-static.
 * @returns {Promise<string|null>} The binary path, or null when the package is not installed.
 */
const loadBundledBinaryPath = async (packageName) => {
  try {
    const module = await import(packageName);
    const exported = module.default ?? module;
    const binaryPath = typeof exported === "string" ? exported : exported?.path;
    return typeof binaryPath === "string" && binaryPath ? binaryPath : null;
  } catch {
    return null;
  }
};

const binaryPaths = new Map();

/**
 * Finds ffmpeg or ffprobe: FFMPEG_PATH / FFPROBE_PATH first, then the bundled npm binary
 * (Electron and development), then the name on PATH (the container installs ffmpeg with apt).
 * @param {"ffmpeg"|"ffprobe"} name - The binary to find.
 * @returns {Promise<string>} The path or command name to spawn.
 */
export const resolveMediaBinary = (name) => {
  if (!binaryPaths.has(name)) {
    binaryPaths.set(
      name,
      (async () =>
        process.env[`${name.toUpperCase()}_PATH`] ||
        (await loadBundledBinaryPath(`${name}-static`)) ||
        name)(),
    );
  }
  return binaryPaths.get(name);
};

/**
 * Builds the input argument for a local file, so a name that starts with "-" or looks like a URL
 * is never read as an option or a network protocol.
 * @param {string} filePath - The absolute path to the video.
 * @returns {string} The ffmpeg input argument.
 * @throws {Error} If the path is not absolute.
 */
const toFileInput = (filePath) => {
  if (!path.isAbsolute(filePath)) {
    throw new Error("Video paths must be absolute.");
  }
  return `file:${filePath}`;
};

/**
 * Runs ffmpeg or ffprobe without a shell and returns its standard output.
 * @param {"ffmpeg"|"ffprobe"} name - The binary to run.
 * @param {string[]} args - The arguments.
 * @param {{signal?: AbortSignal}} [options] - Stops the command when aborted.
 * @returns {Promise<Buffer>} The standard output.
 * @throws {Error} If the binary is missing, the command fails, or it runs too long.
 */
export const runMediaCommand = async (name, args, { signal } = {}) => {
  const binary = await resolveMediaBinary(name);
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    let outputBytes = 0;
    let errorOutput = "";
    let settled = false;
    const finish = (error, output) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (error) {
        reject(error);
      } else {
        resolve(output);
      }
    };
    const stop = () => {
      child.kill();
      finish(signal?.reason ?? new Error(`${name} was stopped.`));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`${name} took too long.`));
    }, mediaCommandTimeoutMs);
    signal?.addEventListener("abort", stop, { once: true });

    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxCommandOutputBytes) {
        child.kill();
        finish(new Error(`${name} wrote more output than expected.`));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      errorOutput = (errorOutput + chunk.toString()).slice(-2000);
    });
    child.on("error", (error) =>
      finish(
        error?.code === "ENOENT"
          ? new Error(
              `${name} is not installed. Install ffmpeg or set ${name.toUpperCase()}_PATH.`,
            )
          : error,
      ),
    );
    child.on("close", (code) => {
      if (code === 0) {
        finish(null, Buffer.concat(chunks));
      } else {
        finish(
          new Error(
            `${name} failed (exit code ${code}): ${errorOutput.trim() || "no details"}`,
          ),
        );
      }
    });
  });
};

/**
 * Reads a video's duration and codecs with ffprobe.
 * @param {string} filePath - The absolute path to the video.
 * @param {{run?: typeof runMediaCommand}} [options] - A replaceable command runner, for tests.
 * @returns {Promise<{durationSeconds: number|null, videoCodec: string|null, audioCodec: string|null, width: number|null, height: number|null}>}
 */
export const probeVideo = async (filePath, { run = runMediaCommand } = {}) => {
  const output = await run("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_entries",
    "format=duration:stream=codec_type,codec_name,width,height",
    toFileInput(filePath),
  ]);
  return parseProbeOutput(output.toString("utf8"));
};

/**
 * Parses ffprobe's JSON output.
 * @param {string} text - The ffprobe output.
 * @returns {{durationSeconds: number|null, videoCodec: string|null, audioCodec: string|null, width: number|null, height: number|null}}
 */
export const parseProbeOutput = (text) => {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = {};
  }
  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const video = streams.find((stream) => stream?.codec_type === "video");
  const audio = streams.find((stream) => stream?.codec_type === "audio");
  const duration = Number(parsed?.format?.duration);
  const toDimension = (value) =>
    Number.isInteger(value) && value > 0 ? value : null;
  return {
    durationSeconds:
      Number.isFinite(duration) && duration > 0
        ? Math.round(duration * 1000) / 1000
        : null,
    videoCodec: typeof video?.codec_name === "string" ? video.codec_name : null,
    audioCodec: typeof audio?.codec_name === "string" ? audio.codec_name : null,
    width: toDimension(video?.width),
    height: toDimension(video?.height),
  };
};

/**
 * Renders one frame of a video as a WebP image that fits within a square of the given size.
 * ffmpeg applies the video's rotation metadata, so phone videos come out upright.
 * @param {string} filePath - The absolute path to the video.
 * @param {{size: number, atSeconds?: number, signal?: AbortSignal}} options - The long-edge size, the frame time,
 *   and a cancellation signal.
 * @returns {Promise<Buffer>} The WebP frame.
 */
export const renderVideoFrame = async (
  filePath,
  { size, atSeconds = 0, signal },
) => {
  const frame = await runMediaCommand(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(Math.max(0, atSeconds)),
      "-i",
      toFileInput(filePath),
      "-frames:v",
      "1",
      "-vf",
      `scale=${size}:${size}:force_original_aspect_ratio=decrease`,
      "-f",
      "image2pipe",
      "-c:v",
      "png",
      "pipe:1",
    ],
    { signal },
  );
  if (!frame.length) {
    throw new Error("The video has no frame to show.");
  }
  return sharp(frame).webp({ quality: 70 }).toBuffer();
};

/**
 * Renders the seek-bar preview sprite: getSeekSpriteFrameCount frames, evenly spaced, in a grid of
 * seekSpriteLayout tiles (letterboxed to keep each frame's shape). Only key frames are decoded, so long
 * videos stay quick.
 * @param {string} filePath - The absolute path to the video.
 * @param {{durationSeconds: number, signal?: AbortSignal}} options - The video's duration and a cancellation signal.
 * @returns {Promise<Buffer>} The WebP sprite.
 */
export const renderSeekSprite = async (
  filePath,
  { durationSeconds, signal },
) => {
  const { columns, tileWidth, tileHeight } = seekSpriteLayout;
  const frames = getSeekSpriteFrameCount(durationSeconds);
  const rows = Math.ceil(frames / columns);
  const sprite = await runMediaCommand(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-skip_frame",
      "nokey",
      "-i",
      toFileInput(filePath),
      "-an",
      "-vf",
      [
        `fps=${frames}/${durationSeconds}`,
        `scale=${tileWidth}:${tileHeight}:force_original_aspect_ratio=decrease`,
        `pad=${tileWidth}:${tileHeight}:(ow-iw)/2:(oh-ih)/2`,
        `tile=${columns}x${rows}`,
      ].join(","),
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-c:v",
      "png",
      "pipe:1",
    ],
    { signal },
  );
  if (!sprite.length) {
    throw new Error("The video has no frames to preview.");
  }
  return sharp(sprite).webp({ quality: 60 }).toBuffer();
};

/**
 * Parses a single-range HTTP Range header ("bytes=start-end", "bytes=start-" or "bytes=-suffix").
 * Multiple ranges are not supported; the whole file is sent instead.
 * @param {string|undefined|null} header - The Range header value.
 * @param {number} size - The file size in bytes.
 * @returns {{start: number, end: number}|null|"unsatisfiable"} The inclusive byte range, null to send the whole
 *   file, or "unsatisfiable" for a 416 response.
 */
export const parseByteRange = (header, size) => {
  if (typeof header !== "string" || !header.trim()) {
    return null;
  }
  const match = header.trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || (!match[1] && !match[2])) {
    // A malformed or multi-range header is ignored, as RFC 9110 allows.
    return null;
  }
  if (size <= 0) {
    return "unsatisfiable";
  }
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (suffixLength === 0) {
      return "unsatisfiable";
    }
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || end < start) {
    return "unsatisfiable";
  }
  return { start, end };
};

/**
 * The content types of the supported video formats.
 */
export const videoContentTypes = Object.freeze({
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
});
