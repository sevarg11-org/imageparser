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
 * @param {{signal?: AbortSignal, timeoutMs?: number|null, onStdout?: (chunk: Buffer) => void}} [options] - Stops
 *   the command when aborted; a time limit (null for none, as for compression); and a listener that receives
 *   standard output instead of it being collected.
 * @returns {Promise<Buffer>} The standard output (empty when onStdout is given).
 * @throws {Error} If the binary is missing, the command fails, or it runs too long.
 */
export const runMediaCommand = async (
  name,
  args,
  { signal, timeoutMs = mediaCommandTimeoutMs, onStdout } = {},
) => {
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
    const timer =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            child.kill();
            finish(new Error(`${name} took too long.`));
          }, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });

    child.stdout.on("data", (chunk) => {
      if (onStdout) {
        onStdout(chunk);
        return;
      }
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
    `format=duration:format_tags=${compressedMarkerTag},creation_time:stream=codec_type,codec_name,width,height`,
    toFileInput(filePath),
  ]);
  return parseProbeOutput(output.toString("utf8"));
};

/**
 * Parses ffprobe's JSON output.
 * @param {string} text - The ffprobe output.
 * @returns {{durationSeconds: number|null, videoCodec: string|null, audioCodec: string|null, width: number|null, height: number|null, compressedByImageParser: boolean, creationTime: string|null}}
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
    compressedByImageParser: Object.entries(parsed?.format?.tags ?? {}).some(
      ([key, value]) =>
        key.toLowerCase() === compressedMarkerTag && String(value) === "1",
    ),
    creationTime: (() => {
      const value = parsed?.format?.tags?.creation_time;
      return typeof value === "string" && !Number.isNaN(Date.parse(value))
        ? value
        : null;
    })(),
  };
};

/**
 * The container tag Image Parser writes into every video it compresses, so a compressed video is never
 * compressed again (each pass would lose quality).
 * @type {string}
 */
export const compressedMarkerTag = "imageparser_compressed";

/**
 * The compression choices, kept inside the recommended ranges for digitized tape: H.265 at CRF 23-26 or
 * H.264 at CRF 20-23, the medium or slow preset, and AAC-LC at 128-192 kbps.
 */
export const videoCompressionLimits = Object.freeze({
  h265: Object.freeze({ minCrf: 23, maxCrf: 26, defaultCrf: 24 }),
  h264: Object.freeze({ minCrf: 20, maxCrf: 23, defaultCrf: 21 }),
  presets: Object.freeze(["medium", "slow"]),
  minAudioBitrateKbps: 128,
  maxAudioBitrateKbps: 192,
});

/**
 * The default compression settings: off, H.265 at CRF 24, medium preset, 160 kbps AAC.
 */
export const defaultVideoCompression = Object.freeze({
  enabled: false,
  codec: "h265",
  crf: videoCompressionLimits.h265.defaultCrf,
  preset: "medium",
  audioBitrateKbps: 160,
});

/**
 * Validates compression settings. Missing values take the defaults; out-of-range values are rejected so a
 * typo never produces a much larger or much worse file than intended.
 * @param {*} value - The raw settings.
 * @returns {{enabled: boolean, codec: "h265"|"h264", crf: number, preset: "medium"|"slow", audioBitrateKbps: number}}
 * @throws {Error} If a value is outside the recommended range.
 */
export const normalizeVideoCompression = (value) => {
  const codec = value?.codec === "h264" ? "h264" : "h265";
  const limits = videoCompressionLimits[codec];
  const crf =
    value?.crf === undefined || value?.crf === null || value?.crf === ""
      ? limits.defaultCrf
      : Number(value.crf);
  const preset = value?.preset ?? defaultVideoCompression.preset;
  const audioBitrateKbps =
    value?.audioBitrateKbps === undefined ||
    value?.audioBitrateKbps === null ||
    value?.audioBitrateKbps === ""
      ? defaultVideoCompression.audioBitrateKbps
      : Number(value.audioBitrateKbps);

  if (!Number.isInteger(crf) || crf < limits.minCrf || crf > limits.maxCrf) {
    throw new Error(
      `The ${codec === "h265" ? "H.265" : "H.264"} quality (CRF) must be a whole number from ${limits.minCrf} through ${limits.maxCrf}.`,
    );
  }
  if (!videoCompressionLimits.presets.includes(preset)) {
    throw new Error("The encoder preset must be medium or slow.");
  }
  if (
    !Number.isInteger(audioBitrateKbps) ||
    audioBitrateKbps < videoCompressionLimits.minAudioBitrateKbps ||
    audioBitrateKbps > videoCompressionLimits.maxAudioBitrateKbps
  ) {
    throw new Error(
      `The audio bitrate must be a whole number of kbps from ${videoCompressionLimits.minAudioBitrateKbps} through ${videoCompressionLimits.maxAudioBitrateKbps}.`,
    );
  }
  return {
    enabled: value?.enabled === true,
    codec,
    crf,
    preset,
    audioBitrateKbps,
  };
};

/**
 * Builds the ffmpeg arguments that compress one video to MP4:
 * - the native resolution (never scaled; only an odd width or height loses its last pixel, which the
 *   encoders require),
 * - the source frame rate as a constant frame rate,
 * - H.265 (tagged hvc1 so Apple devices and browsers play it) or H.264 with CRF quality and the chosen preset,
 * - AAC-LC audio at the chosen bitrate, keeping the source's channel layout,
 * - the source's metadata, its recording date when it has none, and the Image Parser marker.
 * @param {string} inputPath - The absolute path of the source video.
 * @param {string} outputPath - The absolute path to write; it gets no extension, so the format is set explicitly.
 * @param {ReturnType<typeof normalizeVideoCompression>} settings - The compression settings.
 * @param {{creationTime?: string|null}} [options] - The date to record when the source has none (ISO 8601).
 * @returns {string[]} The ffmpeg arguments.
 */
export const buildCompressionArguments = (
  inputPath,
  outputPath,
  settings,
  { creationTime = null } = {},
) => {
  const videoArguments =
    settings.codec === "h264"
      ? ["-c:v", "libx264", "-profile:v", "high"]
      : [
          "-c:v",
          "libx265",
          "-tag:v",
          "hvc1",
          "-x265-params",
          "log-level=error",
        ];
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostats",
    "-progress",
    "pipe:1",
    "-y",
    "-i",
    toFileInput(inputPath),
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-map_metadata",
    "0",
    ...videoArguments,
    "-crf",
    String(settings.crf),
    "-preset",
    settings.preset,
    "-pix_fmt",
    "yuv420p",
    "-vf",
    "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-fps_mode",
    "cfr",
    "-c:a",
    "aac",
    "-profile:a",
    "aac_low",
    "-b:a",
    `${settings.audioBitrateKbps}k`,
    "-movflags",
    "+faststart+use_metadata_tags",
    ...(creationTime ? ["-metadata", `creation_time=${creationTime}`] : []),
    "-metadata",
    `${compressedMarkerTag}=1`,
    "-f",
    "mp4",
    toFileInput(outputPath),
  ];
};

/**
 * Compresses one video with ffmpeg. There is no time limit: a long tape at the slow preset can take hours.
 * @param {string} inputPath - The absolute path of the source video.
 * @param {string} outputPath - The absolute path to write.
 * @param {ReturnType<typeof normalizeVideoCompression>} settings - The compression settings.
 * @param {{creationTime?: string|null, durationSeconds?: number|null, signal?: AbortSignal, onProgress?: (fraction: number) => void, run?: typeof runMediaCommand}} [options] -
 *   The date to record when the source has none, the source duration (for progress), a cancellation signal,
 *   a progress listener (0 to 1), and a replaceable command runner, for tests.
 * @returns {Promise<void>}
 */
export const compressVideo = async (
  inputPath,
  outputPath,
  settings,
  {
    creationTime = null,
    durationSeconds = null,
    signal,
    onProgress,
    run = runMediaCommand,
  } = {},
) => {
  let pending = "";
  await run(
    "ffmpeg",
    buildCompressionArguments(inputPath, outputPath, settings, {
      creationTime,
    }),
    {
      signal,
      timeoutMs: null,
      onStdout: (chunk) => {
        pending += chunk.toString();
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const match = line.match(/^out_time_us=(\d+)/);
          if (match && durationSeconds && onProgress) {
            onProgress(
              Math.min(1, Number(match[1]) / 1_000_000 / durationSeconds),
            );
          }
        }
      },
    },
  );
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
