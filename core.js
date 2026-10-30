import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { exiftool } from "exiftool-vendored";
import sharp from "sharp";
import { createKeyedQueue } from "./imageFileQueue.js";
import {
  buildImageVersion,
  buildPreviewCacheKey,
  buildThumbnailCacheKey,
  createPreviewCache,
} from "./previewCache.js";

/**
 * The set of supported image file extensions.
 */
const allowedExtensions = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".tif",
  ".tiff",
]);

/**
 * Matches the `_a`/`_b` (or front/back) side suffix at the end of a file stem.
 * @type {RegExp}
 */
const sideSuffixPattern = /[_-](?:a|b|front|back)$/i;

/**
 * The file name marker for image groups flagged "Do not upload". It is placed before the
 * side suffix (img001_exclude_a.jpg), so the fixed immich-go ban patterns skip the files.
 * @type {string}
 */
const excludeMarker = "_exclude";

/**
 * The default sort field and direction for directory listings.
 * @type {string}
 */
const defaultSortBy = "createdAt-asc";

/**
 * The valid field names for sorting image files.
 * @type {Set<string>}
 */
const sortFields = new Set(["createdAt", "dateTaken", "fileName"]);

/**
 * The valid direction values for sorting.
 * @type {Set<string>}
 */
const sortDirections = new Set(["asc", "desc"]);

/**
 * Regular expression patterns for extracting dates from XMP metadata.
 * Used to parse date values from sidecar files.
 * @type {Array<RegExp>}
 */
const sidecarDatePatterns = [
  /<xmp:SubSecCreateDate[^>]*>([\s\S]*?)<\/xmp:SubSecCreateDate>/i,
  /<xmp:CreateDate[^>]*>([\s\S]*?)<\/xmp:CreateDate>/i,
  /<exif:DateTimeOriginal[^>]*>([\s\S]*?)<\/exif:DateTimeOriginal>/i,
  /<photoshop:DateCreated[^>]*>([\s\S]*?)<\/photoshop:DateCreated>/i,
];

/**
 * The filename for storing Immich settings.
 * @type {string}
 */
const immichSettingsFileName = "immich-settings.json";

/**
 * The maximum character limit for Immich upload output logs.
 * Prevents excessive memory usage from large log buffers.
 * @type {number}
 */
const maxImmichOutputLength = 32_000;

/**
 * Extensions that support EXIF metadata-based rotation.
 * @type {Set<string>}
 */
const metadataRotationExtensions = new Set([".jpg", ".jpeg", ".tif", ".tiff"]);

/**
 * Extensions that require pixel-level rotation via image processing.
 * @type {Set<string>}
 */
const pixelRotationExtensions = new Set([".png", ".webp"]);

/**
 * Serializes operations per image file: reads and writes of the same file stay ordered,
 * while previews and saves for unrelated files (or other users) run concurrently.
 * @type {{run: Function, whenIdle: () => Promise<void>, size: () => number}}
 */
const imageFileLock = createKeyedQueue();

/**
 * Runs an operation while holding the lock for each of the given image files.
 * @param {Array<string|null|undefined>} filePaths - The image files the operation reads or writes.
 * @param {() => Promise<*>} operation - The operation to run.
 * @returns {Promise<*>} The operation's result.
 */
const runImageFileOperation = (filePaths, operation) =>
  imageFileLock.run(
    filePaths.filter(Boolean).map((filePath) => path.resolve(filePath)),
    operation,
  );

/**
 * The longest side, in pixels, of a rendered preview.
 * Large enough for the 2.5x magnifier on a typical display.
 * @type {number}
 */
const previewMaxDimension = 2560;

/**
 * The number of previews rendered at the same time, to bound memory use on small servers.
 * @type {number}
 */
const maxConcurrentPreviewRenders = 2;

/**
 * The number of thumbnails rendered at the same time. Thumbnails have their own slots, so a
 * filling grid never delays the Review image.
 * @type {number}
 */
const maxConcurrentThumbnailRenders = 2;

/**
 * The preview cache, or null until configurePreviewCache is called.
 * @type {ReturnType<typeof createPreviewCache>|null}
 */
let previewCache = null;

/**
 * The default long-edge size, in pixels, of grid thumbnails.
 * @type {number}
 */
const defaultThumbnailSize = 320;

/**
 * The smallest and largest thumbnail sizes a request may ask for.
 * @type {number}
 */
const minThumbnailSize = 64;
const maxThumbnailSize = 640;

/**
 * The memory limit for cached thumbnails (about 2,000 thumbnails at 320 px).
 * @type {number}
 */
const maxThumbnailCacheBytes = 64 * 1024 * 1024;

/**
 * Rendered thumbnails by cache key, in least- to most-recently-used order.
 * @type {Map<string, Buffer>}
 */
const thumbnailCache = new Map();

/**
 * The total size of the buffers in the thumbnail cache.
 * @type {number}
 */
let thumbnailCacheBytes = 0;

/**
 * The default Immich settings object with empty or default values.
 * @type {{serverUrl: string, userApiKey: string, adminApiKey: string, albumName: string, tags: string, pauseImmichJobs: boolean, concurrentTasks: number}}
 */
const defaultImmichSettings = Object.freeze({
  serverUrl: "",
  userApiKey: "",
  adminApiKey: "",
  albumName: "",
  tags: "",
  pauseImmichJobs: false,
  concurrentTasks: 2,
});

/**
 * Lock keys of the Immich uploads currently running.
 * Prevents simultaneous uploads for the same key (one per user on the web server).
 * @type {Set<string>}
 */
const runningImmichUploads = new Set();

/**
 * Normalizes Immich tags from either an array or comma-separated string.
 * Deduplicates tags, trims whitespace, and filters out empty values.
 * @param {*} value - The tags value (array, string, or undefined).
 * @returns {string} Comma-separated string of unique, trimmed tag names.
 */
const normalizeImmichTags = (value) => {
  const tags = Array.isArray(value) ? value : String(value ?? "").split(",");
  return Array.from(
    new Set(tags.map((tag) => String(tag).trim()).filter(Boolean)),
  );
};

/**
 * Validates and normalizes Immich settings object.
 * Ensures required fields are present and values are within acceptable ranges.
 * Throws errors for invalid URLs, missing API keys, or out-of-range values.
 * @param {*} settings - The raw settings object (may be undefined).
 * @returns {{serverUrl: string, userApiKey: string, adminApiKey: string, albumName: string, tags: string, pauseImmichJobs: boolean, concurrentTasks: number}}
 * @throws {Error} If URL is invalid, required keys are missing, or values are out of range.
 */
const normalizeImmichSettings = (settings) => {
  const normalizedSettings = {
    serverUrl: String(settings?.serverUrl ?? "")
      .trim()
      .replace(/\/+$/, ""),
    userApiKey: String(settings?.userApiKey ?? "").trim(),
    adminApiKey: String(settings?.adminApiKey ?? "").trim(),
    albumName: String(settings?.albumName ?? "").trim(),
    tags: normalizeImmichTags(settings?.tags).join(", "),
    pauseImmichJobs: String(settings?.adminApiKey ?? "") !== "",
    concurrentTasks: Number(settings?.concurrentTasks),
  };

  let serverUrl;
  try {
    serverUrl = new URL(normalizedSettings.serverUrl);
  } catch {
    throw new Error("Enter a valid Immich server URL.");
  }

  if (!["http:", "https:"].includes(serverUrl.protocol)) {
    throw new Error("The Immich server URL must use HTTP or HTTPS.");
  }

  if (!normalizedSettings.userApiKey) {
    throw new Error("Enter the user API key.");
  }

  if (normalizedSettings.pauseImmichJobs && !normalizedSettings.adminApiKey) {
    throw new Error("Enter an admin API key or turn off pausing Immich jobs.");
  }

  if (!normalizedSettings.albumName) {
    throw new Error("Enter the target album name.");
  }

  if (
    !Number.isInteger(normalizedSettings.concurrentTasks) ||
    normalizedSettings.concurrentTasks < 1 ||
    normalizedSettings.concurrentTasks > 20
  ) {
    throw new Error(
      "Concurrent tasks must be a whole number from 1 through 20.",
    );
  }

  return normalizedSettings;
};

/**
 * Builds command-line arguments for immich-go upload from settings.
 * Constructs the full upload command with all required and optional flags.
 * @param {{serverUrl: string, userApiKey: string, adminApiKey?: string, albumName: string, tags: string, pauseImmichJobs: boolean, concurrentTasks: number}} settings - The validated Immich settings.
 * @param {string} directoryPath - The path to the directory containing images to upload.
 * @param {{debug?: boolean, recursive?: boolean}} [options] - Set debug to request verbose immich-go logging,
 *   and recursive to upload every nested folder as well.
 * @returns {string[]} An array of command-line arguments for immich-go.
 */
const buildImmichUploadArguments = (
  settings,
  directoryPath,
  { debug = false, recursive = false } = {},
) => {
  const tags = normalizeImmichTags(settings.tags);
  const uploadArguments = [
    "upload",
    "from-folder",
    "--concurrent-tasks",
    String(settings.concurrentTasks),
    "--no-ui",
    "--server",
    String(settings.serverUrl),
    `--recursive=${recursive === true}`,
    "--api-key",
    String(settings.userApiKey),
    `--pause-immich-jobs=${settings.pauseImmichJobs}`,
    "--into-album",
    String(settings.albumName),
    "--ban-file",
    "**_b.**",
    // Groups flagged "Do not upload" carry the _exclude marker in their file names.
    "--ban-file",
    "**_exclude_**",
    "--ban-file",
    "**_exclude.**",
  ];

  if (settings.adminApiKey) {
    uploadArguments.push("--admin-api-key", String(settings.adminApiKey));
  }

  for (const tag of tags) {
    uploadArguments.push("--tag", String(tag));
  }

  if (debug) {
    uploadArguments.push("--log-level", "DEBUG");
  }

  uploadArguments.push(directoryPath);
  return uploadArguments;
};

/**
 * Appends chunks to output while respecting the maximum size limit.
 * Keeps only the most recent characters once the threshold is exceeded.
 * @param {string} currentOutput - The accumulated output so far.
 * @param {string} chunk - The new chunk of data to append.
 * @returns {string} The bounded output string.
 */
const appendBoundedOutput = (currentOutput, chunk) => {
  const nextOutput = currentOutput + chunk.toString();
  return nextOutput.length > maxImmichOutputLength
    ? nextOutput.slice(nextOutput.length - maxImmichOutputLength)
    : nextOutput;
};

/**
 * Redacts API keys from Immich output logs before displaying them.
 * Protects against leaking credentials in progress reports.
 * @param {string} output - The raw output string (may contain API keys).
 * @param {{userApiKey: string, adminApiKey?: string}} settings - The settings containing API keys to redact.
 * @returns {string} The output with API keys replaced by "[REDACTED]".
 */
const redactImmichSecrets = (output, settings) => {
  return [settings.userApiKey, settings.adminApiKey]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .reduce(
      (redactedOutput, secret) =>
        redactedOutput.split(secret).join("[REDACTED]"),
      output,
    );
};

/**
 * Known immich-go failure signatures paired with a hint explaining the likely cause.
 * @type {Array<{pattern: RegExp, hint: string}>}
 */
const immichFailureHints = [
  {
    pattern: /x509|certificate signed by unknown authority|tls: failed/i,
    hint: "Hint: the Immich server's TLS certificate is not trusted. In Docker, confirm the image includes ca-certificates; for a self-signed certificate, use the server's HTTP URL on a trusted network.",
  },
  {
    pattern:
      /connection refused|actively refused|no such host|i\/o timeout|network is unreachable/i,
    hint: "Hint: immich-go could not reach the Immich server URL. Inside a container, localhost refers to the container itself; use the server's LAN IP address or hostname.",
  },
  {
    pattern: /permission denied|read-only file system/i,
    hint: "Hint: immich-go hit a filesystem permission error. Confirm the PUID/PGID user can read the photo folder and write to its temporary directory.",
  },
  {
    pattern: /unknown flag|unknown command|unknown shorthand flag/i,
    hint: "Hint: the installed immich-go version does not accept these options. Check that it matches the supported immich-go release.",
  },
];

/**
 * Builds hint lines for recognized immich-go failure messages.
 * @param {string} output - The combined immich-go output.
 * @returns {string[]} The hints matching the output.
 */
const getImmichFailureHints = (output) =>
  immichFailureHints
    .filter(({ pattern }) => pattern.test(output))
    .map(({ hint }) => hint);

/**
 * Describes the current process user for diagnostics, where supported.
 * @returns {string} The uid:gid pair, or "n/a" on platforms without POSIX IDs.
 */
const describeProcessUser = () =>
  typeof process.getuid === "function"
    ? `${process.getuid()}:${process.getgid()}`
    : "n/a";

/**
 * Runs `immich-go version` to confirm the binary is installed and runnable.
 * @returns {Promise<{ok: boolean, output: string}>} The version output or the failure reason.
 */
const getImmichGoDiagnostics = () =>
  new Promise((resolve) => {
    let output = "";
    const versionProcess = spawn("immich-go", ["version"], {
      shell: false,
      timeout: 10_000,
      windowsHide: true,
    });
    versionProcess.stdout.on("data", (chunk) => {
      output = appendBoundedOutput(output, chunk);
    });
    versionProcess.stderr.on("data", (chunk) => {
      output = appendBoundedOutput(output, chunk);
    });
    versionProcess.on("error", (error) => {
      resolve({
        ok: false,
        output: `${error.code ?? ""} ${error.message}`.trim(),
      });
    });
    versionProcess.on("close", (exitCode, signal) => {
      resolve({
        ok: exitCode === 0,
        output: output.trim() || `exit code ${exitCode}, signal ${signal}`,
      });
    });
  });

/**
 * Runs immich-go to upload images from a folder to the Immich server.
 * Executes asynchronously and prevents concurrent uploads.
 * @param {{serverUrl: string, userApiKey: string, adminApiKey?: string, albumName: string, tags: string, pauseImmichJobs: boolean, concurrentTasks: number}} settings - The validated Immich settings.
 * @param {string} directoryPath - The path to the directory containing images to upload.
 * @param {(progress: {phase: string, output: string}) => void} [reportProgress] - Optional callback for progress updates.
 * @param {{debug?: boolean, recursive?: boolean, log?: {debug: Function, info: Function, warn: Function, error: Function}, lockKey?: string}} [options] - Optional verbose immich-go logging, whether to upload nested folders too, a logger for diagnostics, and the key that serializes uploads (default: one upload at a time).
 * @returns {{ok: boolean, exitCode: number, output: string}} The result of the upload operation with redacted output.
 * @throws {Error} If an upload is already running or the directory path is invalid.
 */
const runImmichUpload = async (
  settings,
  directoryPath,
  reportProgress = () => {},
  { debug = false, recursive = false, log, lockKey = "default" } = {},
) => {
  if (runningImmichUploads.has(lockKey)) {
    throw new Error("An Immich upload is already running.");
  }

  runningImmichUploads.add(lockKey);

  try {
    const normalizedDirectoryPath = String(directoryPath ?? "").trim();
    if (!normalizedDirectoryPath) {
      throw new Error("Load an image directory before uploading.");
    }

    const directoryStats = await fs.stat(normalizedDirectoryPath);
    if (!directoryStats.isDirectory()) {
      throw new Error("The selected upload path is not a directory.");
    }

    const normalizedSettings = normalizeImmichSettings(settings);
    const uploadArguments = buildImmichUploadArguments(
      normalizedSettings,
      normalizedDirectoryPath,
      { debug, recursive },
    );
    const redact = (text) => redactImmichSecrets(text, normalizedSettings);

    log?.info("Starting immich-go upload.", {
      command: redact(["immich-go", ...uploadArguments].join(" ")),
      cwd: normalizedDirectoryPath,
      user: describeProcessUser(),
    });

    return await new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const uploadProcess = spawn("immich-go", uploadArguments, {
        cwd: normalizedDirectoryPath,
        shell: false,
        windowsHide: true,
      });

      reportProgress({ phase: "uploading", output: "" });

      uploadProcess.stdout.on("data", (chunk) => {
        stdout = appendBoundedOutput(stdout, chunk);
        log?.debug(`immich-go stdout: ${redact(chunk.toString()).trimEnd()}`);
        reportProgress({
          phase: "uploading",
          output: redact(chunk.toString()),
        });
      });
      uploadProcess.stderr.on("data", (chunk) => {
        stderr = appendBoundedOutput(stderr, chunk);
        log?.debug(`immich-go stderr: ${redact(chunk.toString()).trimEnd()}`);
        reportProgress({
          phase: "uploading",
          output: redact(chunk.toString()),
        });
      });
      uploadProcess.on("error", (error) => {
        log?.error("immich-go could not be started.", error);
        reject(
          error?.code === "ENOENT"
            ? new Error(
                "immich-go was not found. Confirm it is installed and available on PATH.",
              )
            : error,
        );
      });
      uploadProcess.on("close", (exitCode, signal) => {
        const ok = exitCode === 0;
        const combinedOutput = [stdout.trim(), stderr.trim()]
          .filter(Boolean)
          .join("\n");
        const hints = ok ? [] : getImmichFailureHints(combinedOutput);
        if (!ok && signal) {
          hints.push(
            `Hint: immich-go was stopped by ${signal}. In a container this often means it ran out of memory; try fewer concurrent tasks.`,
          );
        }
        if (ok) {
          log?.info("immich-go finished.", { exitCode, signal });
        } else {
          log?.error("immich-go failed.", { exitCode, signal, hints });
        }
        resolve({
          ok,
          exitCode: exitCode ?? -1,
          output: redact([combinedOutput, ...hints].filter(Boolean).join("\n")),
        });
      });
    });
  } finally {
    runningImmichUploads.delete(lockKey);
  }
};

/**
 * Normalizes a date value to ISO 8601 format without timezone information.
 * Returns the current timestamp if no date is provided or the input is invalid.
 * @param {*} value - The date value to normalize (string, Date object, or null/undefined).
 * @returns {string} A normalized date string in "YYYY-MM-DD HH:mm:ss" format.
 */
const normalizeDateValue = (value) => {
  if (!value) {
    return new Date().toISOString().slice(0, 19).replace("T", " ");
  }

  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString().slice(0, 19).replace("T", " ");
  }

  return value;
};

/**
 * Normalizes an XMP date string to ISO 8601 format with timezone.
 * Handles space-separated dates and converts them to proper ISO format.
 * @param {*} value - The raw date value from metadata (string or null/undefined).
 * @returns {string} The normalized ISO 8601 timestamp with seconds.
 */
const normalizeXmpDate = (value) => {
  const rawValue = String(value ?? "").trim();
  if (!rawValue) {
    return "";
  }

  const isoLike = rawValue.includes("T")
    ? rawValue
    : rawValue.replace(" ", "T");
  const matched = isoLike.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/,
  );
  if (matched) {
    return `${matched[1]}-${matched[2]}-${matched[3]}T${matched[4]}:${matched[5]}:${matched[6]}`;
  }

  const date = new Date(rawValue);
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString().slice(0, 19);
  }

  return rawValue;
};

/**
 * Normalizes an EXIF date to "MM:DD:YYYY HH:mm:ss" format for EXIF compatibility.
 * Validates the input and throws an error if the date is invalid.
 * @param {string} value - The raw date string to normalize.
 * @returns {string} The date in EXIF-compatible format.
 * @throws {Error} If the date cannot be parsed as a valid ISO timestamp.
 */
const normalizeExifDate = (value) => {
  const normalizedDate = normalizeXmpDate(value);
  const matched = normalizedDate.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/,
  );

  if (!matched) {
    throw new Error("Enter a valid date before saving image metadata.");
  }

  return `${matched[1]}:${matched[2]}:${matched[3]} ${matched[4]}:${matched[5]}:${matched[6]}`;
};

/**
 * Escapes special XML characters for safe inclusion in XMP metadata.
 * @param {string} value - The string to escape.
 * @returns {string} The escaped string with XML-safe replacements.
 */
const escapeXml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/**
 * Unescapes XML entities back to their original characters.
 * The inverse operation of escapeXml.
 * @param {string} value - The escaped string to unescape.
 * @returns {string} The unescaped string with original characters restored.
 */
const unescapeXml = (value = "") =>
  String(value)
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");

/**
 * Normalizes tags from either an array or single value, removing duplicates.
 * Converts all tags to lowercase for comparison while preserving original casing.
 * @param {*} values - Tags as an array or individual value.
 * @returns {string[]} An array of unique tag names with original casing preserved.
 */
const normalizeTags = (values) => {
  const tags = Array.isArray(values) ? values : [];
  const uniqueTagsByName = new Map();

  for (const value of tags) {
    const tag = String(value ?? "").trim();
    const normalizedName = tag.toLocaleLowerCase();
    if (tag && !uniqueTagsByName.has(normalizedName)) {
      uniqueTagsByName.set(normalizedName, tag);
    }
  }

  return Array.from(uniqueTagsByName.values());
};

/**
 * Extracts tags from XMP TagsList metadata.
 * Parses the XML and returns a deduplicated list of tag names.
 * @param {string} rawXml - The raw XMP XML content string.
 * @returns {string[]} An array of tag strings extracted from the TagsList.
 */
const readTagsFromXmp = (rawXml) => {
  const tagsListMatch = String(rawXml).match(
    /<digiKam:TagsList[^>]*>([\s\S]*?)<\/digiKam:TagsList>/i,
  );
  if (!tagsListMatch) {
    return [];
  }

  return normalizeTags(
    Array.from(
      tagsListMatch[1].matchAll(/<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/gi),
    ).map((match) => unescapeXml(match[1].trim())),
  );
};

/**
 * A place saved in a sidecar.
 * @typedef {{latitude: number, longitude: number, name: string}} SidecarLocation
 */

/**
 * Formats a coordinate in XMP's GPS form, DDD,MM.mmmmN|S|E|W (degrees, decimal minutes, hemisphere).
 * @param {number} value - Decimal degrees.
 * @param {"latitude"|"longitude"} axis - Which coordinate this is, which sets the range and the hemispheres.
 * @returns {string} For example "41,52.6860N".
 * @throws {Error} If the value is not a number or is outside -90..90 (latitude) or -180..180 (longitude).
 */
const formatXmpCoordinate = (value, axis) => {
  const limit = axis === "latitude" ? 90 : 180;
  const number = typeof value === "string" ? Number(value) : value;
  if (
    typeof number !== "number" ||
    !Number.isFinite(number) ||
    Math.abs(number) > limit
  ) {
    throw new Error(`The ${axis} must be a number from -${limit} to ${limit}.`);
  }

  const absolute = Math.abs(number);
  let degrees = Math.floor(absolute);
  let minutes = Number(((absolute - degrees) * 60).toFixed(4));
  if (minutes >= 60) {
    degrees += 1;
    minutes = 0;
  }
  const hemisphere =
    axis === "latitude" ? (number < 0 ? "S" : "N") : number < 0 ? "W" : "E";
  return `${degrees},${minutes.toFixed(4)}${hemisphere}`;
};

/**
 * Parses an XMP GPS coordinate (DDD,MM.mmmmN|S|E|W) into decimal degrees.
 * @param {string} text - The coordinate text.
 * @returns {number|null} Decimal degrees, or null when the text is not a valid coordinate.
 */
const parseXmpCoordinate = (text) => {
  const match = String(text ?? "")
    .trim()
    .match(/^(\d{1,3}),(\d{1,2}(?:\.\d+)?)([NSEW])$/i);
  if (!match) {
    return null;
  }
  const hemisphere = match[3].toUpperCase();
  const limit = "NS".includes(hemisphere) ? 90 : 180;
  const degrees = Number(match[1]) + Number(match[2]) / 60;
  if (Number(match[2]) >= 60 || degrees > limit) {
    return null;
  }
  const signed = "SW".includes(hemisphere) ? -degrees : degrees;
  return Number(signed.toFixed(6));
};

/**
 * Validates a location before it is written, so a bad place never reaches a sidecar.
 * @param {*} location - The location to check, or null/undefined for none.
 * @returns {SidecarLocation|null} The cleaned location, or null for none.
 * @throws {Error} If the coordinates are missing or out of range.
 */
const normalizeLocation = (location) => {
  if (location === null || location === undefined) {
    return null;
  }
  // Formatting validates both coordinates.
  formatXmpCoordinate(location.latitude, "latitude");
  formatXmpCoordinate(location.longitude, "longitude");
  return {
    latitude: Number(location.latitude),
    longitude: Number(location.longitude),
    name: String(location.name ?? "").trim(),
  };
};

/**
 * Reads the saved place from XMP metadata.
 * @param {string} rawXml - The raw XMP XML content string.
 * @returns {SidecarLocation|null} The place, or null when the sidecar has no valid GPS position.
 */
const readLocationFromXmp = (rawXml) => {
  const readElement = (name) =>
    String(rawXml).match(
      new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"),
    )?.[1] ?? "";
  const latitude = parseXmpCoordinate(readElement("exif:GPSLatitude"));
  const longitude = parseXmpCoordinate(readElement("exif:GPSLongitude"));
  if (latitude === null || longitude === null) {
    return null;
  }
  return {
    latitude,
    longitude,
    name: unescapeXml(readElement("imageparser:LocationName").trim()),
  };
};

/**
 * Normalizes a rotation value to one of the four cardinal rotations (0°, 90°, 180°, 270°).
 * Rounds arbitrary angles to the nearest quarter-turn and normalizes modulo 360°.
 * @param {*} value - The rotation angle in degrees (number, string, or null/undefined).
 * @returns {number} The normalized rotation as an angle (0, 90, 180, or 270) or 0 if invalid.
 */
const normalizeRotationValue = (value) => {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  const roundedQuarterTurns = Math.round(numericValue / 90);
  const normalizedRotation = ((roundedQuarterTurns % 4) + 4) % 4;
  return normalizedRotation * 90;
};

const clockwiseOrientationByOrientation = Object.freeze({
  1: 6,
  2: 7,
  3: 8,
  4: 5,
  5: 2,
  6: 3,
  7: 4,
  8: 1,
});

/**
 * Composes a new EXIF Orientation value by applying clockwise rotations.
 * Maps the current orientation through each quarter-turn rotation.
 * @param {*} orientation - The current EXIF orientation value (1-8, or null/undefined).
 * @param {number} rotation - The rotation angle in degrees.
 * @returns {number} The composed orientation value (1-8).
 */
const composeExifOrientation = (orientation, rotation) => {
  let composedOrientation = Number.isInteger(Number(orientation))
    ? Number(orientation)
    : 1;
  if (composedOrientation < 1 || composedOrientation > 8) {
    composedOrientation = 1;
  }

  const quarterTurns = normalizeRotationValue(rotation) / 90;
  for (let turn = 0; turn < quarterTurns; turn += 1) {
    composedOrientation =
      clockwiseOrientationByOrientation[composedOrientation];
  }

  return composedOrientation;
};

/**
 * Builds the path to a standard XMP sidecar file.
 * Appends .xmp extension to the image file path.
 * @param {string} filePath - The path to the image file.
 * @returns {string} The sidecar file path (imagePath.xmp).
 */
const buildSidecarPath = (filePath) => {
  return `${filePath}.xmp`;
};

/**
 * Builds the path to a legacy XMP sidecar file.
 * Replaces the image extension with .xmp (e.g., IMG_001.jpg.xmp).
 * Used for compatibility with older sidecar naming conventions.
 * @param {string} filePath - The path to the image file.
 * @returns {string} The legacy-style sidecar file path.
 */
const buildLegacySidecarPath = (filePath) => {
  const extension = path.extname(filePath);
  return filePath.slice(0, filePath.length - extension.length) + ".xmp";
};

const getSidecarCandidatePaths = (filePath) => {
  return [buildSidecarPath(filePath), buildLegacySidecarPath(filePath)].filter(
    (candidatePath, index, candidates) =>
      candidates.indexOf(candidatePath) === index,
  );
};

const resolveExistingSidecarPath = async (filePath) => {
  for (const sidecarPath of getSidecarCandidatePaths(filePath)) {
    try {
      await fs.access(sidecarPath);
      return sidecarPath;
    } catch {
      // Try the next supported sidecar naming convention.
    }
  }

  return null;
};

/**
 * Extracts the file name without its extension (the stem).
 * @param {string} fileName - The full file name with extension.
 * @returns {string} The file name without the extension.
 */
const getStem = (fileName) => fileName.replace(/\.[^.]+$/, "");

/**
 * Generates a unique key for grouping image pairs.
 * Removes pairing suffixes (a|b|front|back) and normalizes the stem.
 * @param {string} fileName - The full file name with extension.
 * @returns {string} A lowercase string key without pairing suffixes.
 */
const getGroupKey = (fileName) => {
  const stem = getStem(fileName);
  // The exclude marker is ignored so a group still pairs when only one side was renamed.
  const normalizedStem = stem
    .replace(sideSuffixPattern, "")
    .replace(/[_-]exclude$/i, "");
  return normalizedStem.toLowerCase();
};

/**
 * Extracts whether a file represents the front or back of a paired image.
 * Parses A/a/FRONT suffixes as "a" (front) and B/back as "b" (back), defaulting to "front".
 * @param {string} fileName - The full file name with extension.
 * @returns {"a"|"b"} The side designation ("a" for front, "b" for back).
 */
const getSideFromFileName = (fileName) => {
  const stem = getStem(fileName);
  const match =
    stem.match(/[_-]((?:a|front))$/i) || stem.match(/[_-]((?:b|back))$/i);
  if (!match) {
    return "front";
  }

  const side = match[1].toLowerCase();
  return side === "front" || side === "a" ? "a" : "b";
};

/**
 * Rewrites the part of an image or sidecar file name that sits before the side suffix.
 * Sidecars named `name.ext.xmp` are rewritten through the image name they wrap; legacy
 * `name.xmp` sidecars and images are rewritten directly.
 * @param {string} fileName - The image or sidecar file name.
 * @param {(base: string) => string} transform - Maps the stem without its side suffix.
 * @returns {string} The rewritten file name.
 */
const transformImageBaseName = (fileName, transform) => {
  const sidecarMatch = fileName.match(/^(.+)(\.xmp)$/i);
  if (
    sidecarMatch &&
    allowedExtensions.has(path.extname(sidecarMatch[1]).toLowerCase())
  ) {
    return transformImageBaseName(sidecarMatch[1], transform) + sidecarMatch[2];
  }

  const extension = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - extension.length);
  const sideSuffix = stem.match(sideSuffixPattern)?.[0] ?? "";
  const base = stem.slice(0, stem.length - sideSuffix.length);
  return `${transform(base)}${sideSuffix}${extension}`;
};

/**
 * Adds the exclude marker before the side suffix (or before the extension for singles).
 * @param {string} fileName - The image or sidecar file name.
 * @returns {string} The flagged file name; unchanged if it is already flagged.
 */
const toExcludedName = (fileName) =>
  transformImageBaseName(fileName, (base) =>
    base.endsWith(excludeMarker) ? base : `${base}${excludeMarker}`,
  );

/**
 * Removes the exclude marker from before the side suffix.
 * @param {string} fileName - The image or sidecar file name.
 * @returns {string} The unflagged file name; unchanged if it is not flagged.
 */
const toIncludedName = (fileName) =>
  transformImageBaseName(fileName, (base) =>
    base.endsWith(excludeMarker)
      ? base.slice(0, base.length - excludeMarker.length)
      : base,
  );

/**
 * Checks whether a file name carries the exclude marker before its side suffix.
 * @param {string} fileName - The image or sidecar file name.
 * @returns {boolean} True when the file is flagged "Do not upload".
 */
const isExcludedName = (fileName) => toIncludedName(fileName) !== fileName;

/**
 * Normalizes a sort-by value into a field and direction object.
 * Validates against allowed fields (createdAt, dateTaken, fileName) and directions (asc, desc).
 * Defaults to createdAt-asc if the input is invalid or missing.
 * @param {*} sortBy - The sort specification as a string (e.g., "createdAt-asc").
 * @returns {{field: "createdAt"|"dateTaken"|"fileName", direction: "asc"|"desc"}}
 */
const normalizeSortBy = (sortBy) => {
  const [field, direction = "asc"] = String(sortBy ?? "").split("-");
  if (!sortFields.has(field) || !sortDirections.has(direction)) {
    return { field: "createdAt", direction: "asc" };
  }

  return { field, direction };
};

/**
 * Compares two file names using locale-aware, case-insensitive ordering.
 * Enables consistent sorting of image file pairs by their original names.
 * @param {string} left - The first file name to compare.
 * @param {string} right - The second file name to compare.
 * @returns {number} A negative number if left sorts before right, positive otherwise, or 0 if equal.
 */
const compareFileNames = (left, right) =>
  left.imageLabel.localeCompare(right.imageLabel, undefined, {
    numeric: true,
    sensitivity: "base",
  });

/**
 * Orders folders relative to the scanned folder depth-first, in natural name order, with a folder
 * before its subfolders. The scanned folder itself ("") comes first.
 * @param {string} left - The first folder, as forward-slash separated segments.
 * @param {string} right - The second folder, as forward-slash separated segments.
 * @returns {number} The sort order.
 */
const compareRelativeDirectories = (left, right) => {
  const leftSegments = left ? left.split("/") : [];
  const rightSegments = right ? right.split("/") : [];
  const sharedLength = Math.min(leftSegments.length, rightSegments.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const order = leftSegments[index].localeCompare(
      rightSegments[index],
      undefined,
      { numeric: true },
    );
    if (order !== 0) {
      return order;
    }
  }
  return leftSegments.length - rightSegments.length;
};

/**
 * Sorts pairs by folder (see compareRelativeDirectories), then by the chosen sort inside each folder.
 * @param {Array} pairs - The pairs to sort in place.
 * @param {*} sortBy - The sort field and direction.
 * @returns {Array} The sorted pairs.
 */
const sortPairs = (pairs, sortBy) => {
  const { field, direction } = normalizeSortBy(sortBy);
  const directionFactor = direction === "desc" ? -1 : 1;

  return pairs.sort((left, right) => {
    const folderOrder = compareRelativeDirectories(
      left.relativeDirectory,
      right.relativeDirectory,
    );
    if (folderOrder !== 0) {
      return folderOrder;
    }

    if (field === "fileName") {
      return compareFileNames(left, right) * directionFactor;
    }

    const leftValue = left[field];
    const rightValue = right[field];
    const isLeftMissing = leftValue === null || leftValue === undefined;
    const isRightMissing = rightValue === null || rightValue === undefined;

    // Photos without a value (e.g. no saved date taken) always sort after dated photos.
    if (isLeftMissing !== isRightMissing) {
      return isLeftMissing ? 1 : -1;
    }

    if (!isLeftMissing && leftValue !== rightValue) {
      return (leftValue - rightValue) * directionFactor;
    }

    return compareFileNames(left, right) * directionFactor;
  });
};

/**
 * Reads the raw date value from a sidecar file.
 * @param {string} sidecarPath - The path to the XMP sidecar file.
 * @returns {Promise<string>} The raw date, or an empty string when the sidecar has none.
 */
const readRawDateFromSidecar = async (sidecarPath) => {
  try {
    const rawXml = String(await fs.readFile(sidecarPath, "utf8"));
    for (const pattern of sidecarDatePatterns) {
      const match = rawXml.match(pattern);
      if (match?.[1]?.trim()) {
        return match[1].trim();
      }
    }
  } catch {
    // Unreadable sidecars are treated as having no date taken.
  }

  return "";
};

/**
 * Reads an image's sidecar once, reporting whether it exists and its raw date.
 * @param {string} filePath - The path to the image file.
 * @returns {Promise<{hasSidecar: boolean, rawDate: string}>} The sidecar summary.
 */
const readSidecarSummary = async (filePath) => {
  const sidecarPath = await resolveExistingSidecarPath(filePath);
  return {
    hasSidecar: sidecarPath !== null,
    rawDate: sidecarPath ? await readRawDateFromSidecar(sidecarPath) : "",
  };
};

const readSidecarRawDate = async (filePath) =>
  (await readSidecarSummary(filePath)).rawDate;

/**
 * Converts a raw sidecar date to a timestamp for sorting by date taken.
 * @param {string} rawDate - The raw date read from a sidecar file.
 * @returns {number|null} The timestamp, or null when the date is missing or invalid.
 */
const toDateTakenTimestamp = (rawDate) => {
  const normalizedDate = normalizeXmpDate(rawDate);
  const timestamp = normalizedDate ? Date.parse(normalizedDate) : Number.NaN;
  return Number.isNaN(timestamp) ? null : timestamp;
};

/**
 * Converts a raw sidecar date to the calendar day shown in the thumbnail grid.
 * Accepts ISO dates and the EXIF-style "YYYY:MM:DD" form some tools write into XMP.
 * @param {string} rawDate - The raw date read from a sidecar file.
 * @returns {string} The date as YYYY-MM-DD, or an empty string when there is no valid date.
 */
const toSidecarDay = (rawDate) => {
  const match = normalizeXmpDate(rawDate).match(
    /^(\d{4})[-:](\d{2})[-:](\d{2})/,
  );
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
};

/**
 * Builds the identity and "Do not upload" state of a pair from its file paths.
 * The flag is read from the A file name; a B file that disagrees marks the group as mixed.
 * @param {string} frontPath - The path to the front (A) image.
 * @param {string|null} backPath - The path to the back (B) image, if any.
 * @param {string} [relativeDirectory=""] - The pair's folder relative to the scanned folder, with forward
 *   slashes; it scopes the id and prefixes the label so equal names in different folders stay apart.
 * @returns {{id: string, imageLabel: string, relativeDirectory: string, frontPath: string, backPath: string|null, doNotUpload: boolean, excludeMismatch: boolean}}
 */
const describePair = (frontPath, backPath, relativeDirectory = "") => {
  const frontName = path.basename(frontPath);
  const doNotUpload = isExcludedName(frontName);
  const folderPrefix = relativeDirectory ? `${relativeDirectory}/` : "";
  return {
    id: `${folderPrefix}${getGroupKey(frontName)}-${frontName}`,
    imageLabel: `${folderPrefix}${frontName}`,
    relativeDirectory,
    frontPath,
    backPath,
    doNotUpload,
    excludeMismatch: backPath
      ? isExcludedName(path.basename(backPath)) !== doNotUpload
      : false,
  };
};

/**
 * Groups image files by their base name and creates front/back pairs.
 * Supports date-taken sorting when available, falling back to file creation time.
 * Files only pair with files in the same folder.
 * @param {string[]} filePaths - The image file paths.
 * @param {*} [sortBy=defaultSortBy] - The sort field and direction (default: createdAt-asc).
 * @param {string} [baseDirectory] - The scanned folder; when given, each pair records its folder relative to it.
 * @returns {Promise<Array<{id: string, imageLabel: string, relativeDirectory: string, frontPath: string, backPath: string|null, frontVersion: string, backVersion: string|null, createdAt: number, dateTaken: number|null, hasSidecar: boolean, sidecarDate: string}>>}
 */
const pairFiles = async (filePaths, sortBy = defaultSortBy, baseDirectory) => {
  const shouldReadDateTaken = normalizeSortBy(sortBy).field === "dateTaken";
  const grouped = new Map();

  for (const filePath of filePaths) {
    const fileName = path.basename(filePath);
    const relativeDirectory = baseDirectory
      ? path
          .relative(baseDirectory, path.dirname(filePath))
          .split(path.sep)
          .join("/")
      : "";
    const key = `${relativeDirectory}/${getGroupKey(fileName)}`;
    const group = grouped.get(key) ?? [];
    group.push({
      filePath,
      fileName,
      relativeDirectory,
      side: getSideFromFileName(fileName),
    });
    grouped.set(key, group);
  }

  const pairs = await Promise.all(
    Array.from(grouped.values()).map(async (items) => {
      const frontCandidate =
        items.find((item) => item.side === "a") ?? items[0];
      const backCandidate = items.find((item) => item.side === "b") ?? null;
      // The A sidecar is read once: it is the source of truth for the grid date and filters.
      const [frontStats, backStats, frontSidecar] = await Promise.all([
        fs.stat(frontCandidate.filePath),
        backCandidate ? fs.stat(backCandidate.filePath) : null,
        readSidecarSummary(frontCandidate.filePath),
      ]);
      const frontSidecarDateTaken = toDateTakenTimestamp(frontSidecar.rawDate);
      const backSidecarDateTaken =
        shouldReadDateTaken && frontSidecarDateTaken === null && backCandidate
          ? toDateTakenTimestamp(
              await readSidecarRawDate(backCandidate.filePath),
            )
          : null;
      // Without a sidecar date, the date comes from the A image itself and is shown and sorted on instead.
      const frontRawDate =
        toSidecarDay(frontSidecar.rawDate) === ""
          ? await resolveImageDateWithoutSidecar(frontCandidate.filePath, {
              stats: frontStats,
            })
          : frontSidecar.rawDate;
      const dateTaken =
        frontSidecarDateTaken ??
        backSidecarDateTaken ??
        toDateTakenTimestamp(frontRawDate);

      return {
        ...describePair(
          frontCandidate.filePath,
          backCandidate ? backCandidate.filePath : null,
          frontCandidate.relativeDirectory,
        ),
        frontVersion: buildImageVersion(frontStats),
        backVersion: backStats ? buildImageVersion(backStats) : null,
        createdAt:
          frontStats.birthtimeMs || frontStats.ctimeMs || frontStats.mtimeMs,
        dateTaken: shouldReadDateTaken ? dateTaken : null,
        hasSidecar: frontSidecar.hasSidecar,
        sidecarDate: toSidecarDay(frontRawDate),
      };
    }),
  );

  return sortPairs(pairs, sortBy);
};

/**
 * Builds an XMP metadata XML document with embedded date, description, and tags.
 * Creates properly formatted XMP blocks for each metadata type when provided.
 * @param {{dateValue: string, description: string, tags: string[], location?: SidecarLocation|null}} options - The
 *   metadata options; a location adds the GPS position (and the place name) when given.
 * @returns {string} A complete XMP metadata XML document ready to be written to a sidecar file.
 */
const buildSidecarDocument = ({ dateValue, description, tags, location }) => {
  const safeLocation = normalizeLocation(location);
  const xmpDate =
    normalizeXmpDate(dateValue) || new Date().toISOString().slice(0, 19);
  const safeDescription = String(description ?? "").trim();
  const safeTags = normalizeTags(tags);

  const descriptionBlock = safeDescription
    ? ` <rdf:Description rdf:about=''
  xmlns:dc='http://purl.org/dc/elements/1.1/'>
  <dc:description>
   <rdf:Alt>
    <rdf:li xml:lang='x-default'>${escapeXml(safeDescription)}</rdf:li>
   </rdf:Alt>
  </dc:description>
 </rdf:Description>`
    : "";

  const tagsBlock = safeTags.length
    ? ` <rdf:Description rdf:about=''
  xmlns:digiKam='http://www.digikam.org/ns/1.0/'>
  <digiKam:TagsList>
   <rdf:Seq>
${safeTags.map((tag) => `    <rdf:li>${escapeXml(tag)}</rdf:li>`).join("\n")}
   </rdf:Seq>
  </digiKam:TagsList>
 </rdf:Description>`
    : "";

  const exifBlock = ` <rdf:Description rdf:about=''
  xmlns:exif='http://ns.adobe.com/exif/1.0/'>
  <exif:DateTimeOriginal>${escapeXml(xmpDate)}</exif:DateTimeOriginal>
 </rdf:Description>`;

  const gpsBlock = safeLocation
    ? ` <rdf:Description rdf:about=''
  xmlns:exif='http://ns.adobe.com/exif/1.0/'
  xmlns:imageparser='https://github.com/sevarg11-org/imageparser/ns/1.0/'>
  <exif:GPSVersionID>2.3.0.0</exif:GPSVersionID>
  <exif:GPSLatitude>${formatXmpCoordinate(safeLocation.latitude, "latitude")}</exif:GPSLatitude>
  <exif:GPSLongitude>${formatXmpCoordinate(safeLocation.longitude, "longitude")}</exif:GPSLongitude>${
    safeLocation.name
      ? `
  <imageparser:LocationName>${escapeXml(safeLocation.name)}</imageparser:LocationName>`
      : ""
  }
 </rdf:Description>`
    : "";

  const photoshopBlock = ` <rdf:Description rdf:about=''
  xmlns:photoshop='http://ns.adobe.com/photoshop/1.0/'>
  <photoshop:DateCreated>${escapeXml(xmpDate)}</photoshop:DateCreated>
 </rdf:Description>`;

  const xmpBlock = ` <rdf:Description rdf:about=''
  xmlns:xmp='http://ns.adobe.com/xap/1.0/'>
  <xmp:SubSecCreateDate>${escapeXml(xmpDate)}</xmp:SubSecCreateDate>
  <xmp:CreateDate>${escapeXml(xmpDate)}</xmp:CreateDate>
  <xmp:ModifyDate>${escapeXml(xmpDate)}</xmp:ModifyDate>
 </rdf:Description>`;

  const blocks = [
    descriptionBlock,
    tagsBlock,
    exifBlock,
    gpsBlock,
    photoshopBlock,
    xmpBlock,
  ]
    .filter(Boolean)
    .join("\n\n");

  return `<?xpacket begin='\uFEFF' id='W5M0MpCehiHzreSzNTczkc9d'?>
<x:xmpmeta xmlns:x='adobe:ns:meta/' x:xmptk='Image::ExifTool 13.59'>
<rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>

${blocks}
</rdf:RDF>
</x:xmpmeta>
<?xpacket end='w'?>`;
};

/**
 * Builds an ISO date-time from date and time parts, rejecting impossible dates and times.
 * Years before 1800 or more than a year ahead are rejected, so EXIF's "0000:00:00" and stray digits in file
 * names are not mistaken for dates.
 * @param {string[]} parts - Year, month, day, and optionally hour, minute, and second, as digit strings.
 * @returns {string} The date as YYYY-MM-DDTHH:mm:ss (midnight without a time), or an empty string when invalid.
 */
const buildIsoDateTime = ([year, month, day, hour, minute, second]) => {
  const [y, m, d] = [year, month, day].map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    y < 1800 ||
    y > new Date().getFullYear() + 1 ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return "";
  }
  const hasValidTime =
    hour !== undefined &&
    Number(hour) < 24 &&
    Number(minute) < 60 &&
    Number(second) < 60;
  return `${year}-${month}-${day}T${hasValidTime ? `${hour}:${minute}:${second}` : "00:00:00"}`;
};

/**
 * Converts an embedded date ("YYYY:MM:DD HH:mm:ss", as ExifTool prints EXIF and XMP dates) to an ISO date-time.
 * @param {*} value - The raw tag value.
 * @returns {string} The date as YYYY-MM-DDTHH:mm:ss, or an empty string when it is not a real date.
 */
const toIsoEmbeddedDate = (value) => {
  const match = String(value ?? "")
    .trim()
    .match(/^(\d{4})[-:](\d{2})[-:](\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/);
  return match ? buildIsoDateTime(match.slice(1)) : "";
};

/**
 * File name date formats, tried in order: "2007-07-03", "2007_07_03 17.27.14", "2007.07.03", and the compact
 * camera and phone forms "20070703" and "IMG_20070703_172714". A date must not touch other digits.
 * @type {Array<RegExp>}
 */
const fileNameDatePatterns = [
  /(?<!\d)(\d{4})[-_.](\d{2})[-_.](\d{2})(?:[ T_.-](\d{2})[-_.:h]?(\d{2})[-_.:m]?(\d{2}))?(?!\d)/i,
  /(?<!\d)(\d{4})(\d{2})(\d{2})(?:[ T_-]?(\d{2})(\d{2})(\d{2}))?(?!\d)/,
];

/**
 * Parses the date (and time, when present) from an image file name.
 * @param {string} filePath - The image file's path; only its name is parsed.
 * @returns {string} The date as YYYY-MM-DDTHH:mm:ss, or an empty string when the name holds no valid date.
 */
const parseDateFromFileName = (filePath) => {
  const fileName = path.basename(filePath, path.extname(filePath));
  for (const pattern of fileNameDatePatterns) {
    const match = fileName.match(pattern);
    const isoDate = match ? buildIsoDateTime(match.slice(1)) : "";
    if (isoDate) {
      return isoDate;
    }
  }
  return "";
};

/**
 * Formats a file's created time as a local ISO date-time, the way cameras record the date taken.
 * Falls back to the change and modified times on file systems that do not record a creation time.
 * @param {import("node:fs").Stats} stats - The file's stats.
 * @returns {string} The date as YYYY-MM-DDTHH:mm:ss in local time.
 */
const toFileCreatedDate = (stats) => {
  const created = new Date(stats.birthtimeMs || stats.ctimeMs || stats.mtimeMs);
  const pad = (value) => String(value).padStart(2, "0");
  return `${created.getFullYear()}-${pad(created.getMonth() + 1)}-${pad(created.getDate())}T${pad(created.getHours())}:${pad(created.getMinutes())}:${pad(created.getSeconds())}`;
};

/**
 * Reads the date an image was taken from its embedded metadata ("Date taken" in Windows Explorer), without
 * taking the image file lock. Callers must already hold the lock, or use readEmbeddedDateTaken.
 * Prefers DateTimeOriginal over CreateDate, and EXIF over embedded XMP, as ExifTool does.
 * @param {string} filePath - The path to the image file.
 * @returns {Promise<string>} The date as an ISO date-time, or an empty string when the image has no valid date.
 */
const readEmbeddedDateTakenUnlocked = async (filePath) => {
  try {
    const tags = await exiftool.readRaw(filePath, {
      readArgs: ["-fast", "-DateTimeOriginal", "-CreateDate"],
    });
    return (
      [tags?.DateTimeOriginal, tags?.CreateDate]
        .map(toIsoEmbeddedDate)
        .find(Boolean) ?? ""
    );
  } catch {
    return "";
  }
};

/**
 * Reads the embedded date taken in the image file queue, so it never reads an image while a save rewrites it.
 * @param {string} filePath - The path to the image file.
 * @returns {Promise<string>} The date as an ISO date-time, or an empty string when the image has no valid date.
 */
const readEmbeddedDateTaken = (filePath) =>
  runImageFileOperation([filePath], () =>
    readEmbeddedDateTakenUnlocked(filePath),
  );

/**
 * Finds the date of an image whose sidecar has no date, in this order: the date taken embedded in the image,
 * a date in the file name, then the file's created date. Always returns a date.
 * @param {string} filePath - The path to the image file.
 * @param {{stats?: import("node:fs").Stats, readEmbeddedDate?: (filePath: string) => Promise<string>}} [options] -
 *   The file's stats when already known, and the embedded date reader (the unlocked one inside a save).
 * @returns {Promise<string>} The date as YYYY-MM-DDTHH:mm:ss.
 */
const resolveImageDateWithoutSidecar = async (
  filePath,
  { stats, readEmbeddedDate = readEmbeddedDateTaken } = {},
) =>
  (await readEmbeddedDate(filePath)) ||
  parseDateFromFileName(filePath) ||
  toFileCreatedDate(stats ?? (await fs.stat(filePath)));

/**
 * Reads image metadata (date, description, tags, rotation) from a sidecar file.
 * When the sidecar is missing or has no date, the date comes from the image itself (embedded date taken, then
 * the file name, then the file's created date). The A-file sidecar stays the source of truth whenever it has one.
 * @param {string} filePath - The path to the image file whose sidecar metadata is being read.
 * @returns {Promise<Object>} An object with date, description, tags, rotation (default: 0), and whether a sidecar exists.
 */
const readSidecarMetadata = async (filePath) => {
  const sidecarPath = await resolveExistingSidecarPath(filePath);
  if (!sidecarPath) {
    return {
      ...emptySidecarMetadata(),
      date: toSidecarDay(await resolveImageDateWithoutSidecar(filePath)),
    };
  }

  try {
    const xml = await fs.readFile(sidecarPath, "utf8");
    const rawXml = String(xml);

    const getTagValue = (...patterns) => {
      for (const pattern of patterns) {
        const match = rawXml.match(pattern);
        if (match?.[1]) {
          return match[1].trim();
        }
      }
      return "";
    };

    const date =
      toSidecarDay(getTagValue(...sidecarDatePatterns)) ||
      toSidecarDay(await resolveImageDateWithoutSidecar(filePath));

    const description = getTagValue(
      /<rdf:li[^>]*xml:lang="x-default"[^>]*>([\s\S]*?)<\/rdf:li>/i,
      /<dc:description[^>]*>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>[\s\S]*?<\/dc:description>/i,
    );

    return {
      date,
      description,
      tags: readTagsFromXmp(rawXml),
      location: readLocationFromXmp(rawXml),
      rotation: 0,
      hasSidecar: true,
    };
  } catch {
    // An unreadable sidecar still exists, so it is rewritten on the next save.
    return { ...emptySidecarMetadata(), hasSidecar: true };
  }
};

/**
 * Writes image metadata (date, description, tags) to a sidecar file and embeds the date in image files.
 * Creates or updates an XMP sidecar file and writes the normalized date to both images.
 * @param {string} filePath - The path to the image file whose sidecar is being written.
 * @param {string} dateValue - The date value to normalize and store.
 * @param {string} description - The description text to store (can be empty).
 * @param {string[]} [tags=[]] - An optional array of tag strings.
 * @param {SidecarLocation|null} [location] - The place to save: omit it to keep the place already in the
 *   sidecar, or pass null to remove it.
 * @returns {Promise<{sidecarPath: string, written: boolean}>} The sidecar path and whether it changed.
 */
const writeSidecarFile = async (
  filePath,
  dateValue,
  description,
  tags,
  location,
) => {
  const existingSidecarPath = await resolveExistingSidecarPath(filePath);
  const sidecarPath = existingSidecarPath ?? buildSidecarPath(filePath);
  const currentXml = existingSidecarPath
    ? await fs.readFile(existingSidecarPath, "utf8").catch(() => null)
    : null;
  const xml = buildSidecarDocument({
    dateValue,
    description,
    tags,
    location:
      location === undefined
        ? (readLocationFromXmp(currentXml ?? "") ?? null)
        : location,
  });

  if (existingSidecarPath) {
    if (currentXml === xml) {
      return { sidecarPath, written: false };
    }
  }

  await fs.writeFile(sidecarPath, xml, "utf8");
  return { sidecarPath, written: true };
};

/**
 * The most sidecars read for tag suggestions, so a large nested scan does not read every sidecar.
 * @type {number}
 */
const maxRecentTagSidecars = 500;

/**
 * Reads tag suggestions from .xmp sidecar files, most recently modified first.
 * Only the newest maxRecentTagSidecars sidecars are read.
 * @param {string[]} sidecarPaths - The sidecar files found by the directory scan.
 * @returns {Promise<string[]>} An array of unique tag strings found in sidecar files.
 */
const readRecentTags = async (sidecarPaths) => {
  const sidecarsByRecency = await mapWithConcurrency(
    sidecarPaths,
    folderListingConcurrency,
    async (sidecarPath) => ({
      sidecarPath,
      modifiedAt: (await fs.stat(sidecarPath)).mtimeMs,
    }),
  );
  sidecarsByRecency.sort((left, right) => right.modifiedAt - left.modifiedAt);

  const recentTags = [];
  for (const { sidecarPath } of sidecarsByRecency.slice(
    0,
    maxRecentTagSidecars,
  )) {
    try {
      recentTags.push(
        ...readTagsFromXmp(await fs.readFile(sidecarPath, "utf8")),
      );
    } catch {
      // Ignore unreadable sidecars while collecting optional tag suggestions.
    }
  }

  return normalizeTags(recentTags);
};

/**
 * Asserts that embedded metadata can be written to an image file.
 * @param {string} filePath - The path to the image file.
 * @throws {Error} If the file type doesn't support embedded metadata.
 */
const assertEmbeddedMetadataSupported = (filePath) => {
  const extension = path.extname(filePath).toLowerCase();
  if (!allowedExtensions.has(extension)) {
    throw new Error(
      `Embedded metadata is not supported for ${extension || "this file type"}.`,
    );
  }
};

/**
 * Reads the embedded tags that saving compares against: the EXIF dates and the orientation.
 * Reads only these tags, so it does not scan or rewrite the whole image.
 * @param {string} filePath - The path to the image file.
 * @returns {Promise<{CreateDate?: string, DateTimeOriginal?: string, SubSecTimeOriginal?: number|string, Orientation?: number}>}
 */
const readEmbeddedImageTags = (filePath) =>
  exiftool.readRaw(filePath, {
    readArgs: [
      "-fast",
      "-n",
      "-EXIF:CreateDate",
      "-EXIF:DateTimeOriginal",
      "-EXIF:SubSecTimeOriginal",
      "-Orientation",
    ],
  });

/**
 * Checks whether an image already stores the given EXIF date, so writing it again can be skipped.
 * @param {{CreateDate?: string, DateTimeOriginal?: string, SubSecTimeOriginal?: number|string}} tags - Tags from readEmbeddedImageTags.
 * @param {string} exifDate - The date in EXIF format ("YYYY:MM:DD HH:mm:ss").
 * @returns {boolean} True when the stored date matches.
 */
const hasEmbeddedImageDate = (tags, exifDate) =>
  String(tags?.CreateDate ?? "") === exifDate &&
  String(tags?.DateTimeOriginal ?? "") === exifDate &&
  tags?.SubSecTimeOriginal !== undefined &&
  Number(tags.SubSecTimeOriginal) === 0;

/**
 * Writes embedded EXIF tags with ExifTool, replacing the original file.
 * @param {string} filePath - The path to the image file.
 * @param {Object} tags - The tags to write.
 * @param {string} description - What is being updated, for the error message.
 * @throws {Error} If ExifTool fails to update the file.
 */
const writeEmbeddedTags = async (filePath, tags, description) => {
  const result = await exiftool.write(filePath, tags, {
    writeArgs: ["-overwrite_original"],
  });

  if (result.updated !== 1 && result.unchanged !== 1) {
    throw new Error(
      `ExifTool did not update the ${description} for ${path.basename(filePath)}.`,
    );
  }
};

/**
 * Builds the EXIF tags that store a date taken.
 * @param {string} exifDate - The date in EXIF format.
 * @returns {Object} The tags for ExifTool.
 */
const buildEmbeddedDateTags = (exifDate) => ({
  "EXIF:CreateDate": exifDate,
  "EXIF:DateTimeOriginal": exifDate,
  SubSecTimeOriginal: 0,
});

/**
 * Writes a date and an optional rotation into one image file with as few rewrites as possible.
 * JPEG and TIFF rotations update the Orientation tag in the same ExifTool write as the date.
 * PNG and WebP rotations rewrite the pixels, which keeps the embedded date.
 * Nothing is written when the stored date already matches and no rotation is requested.
 * @param {string} filePath - The path to the image file.
 * @param {string} dateValue - The date value to embed.
 * @param {*} [rotation=0] - The clockwise rotation to apply, in degrees.
 * @returns {Promise<{dateWritten: boolean, rotated: boolean}>} What was written.
 * @throws {Error} If the file type is unsupported or a write fails.
 */
const writeEmbeddedImageMetadata = async (
  filePath,
  dateValue,
  rotation = 0,
) => {
  assertEmbeddedMetadataSupported(filePath);
  const exifDate = normalizeExifDate(dateValue);
  const normalizedRotation = normalizeRotationValue(rotation);
  const extension = path.extname(filePath).toLowerCase();
  const tags = await readEmbeddedImageTags(filePath);
  const needsDate = !hasEmbeddedImageDate(tags, exifDate);

  if (normalizedRotation && metadataRotationExtensions.has(extension)) {
    await writeEmbeddedTags(
      filePath,
      {
        ...(needsDate ? buildEmbeddedDateTags(exifDate) : {}),
        "Orientation#": composeExifOrientation(
          tags.Orientation,
          normalizedRotation,
        ),
      },
      needsDate ? "created date and orientation" : "orientation",
    );
    return { dateWritten: needsDate, rotated: true };
  }

  if (normalizedRotation && !pixelRotationExtensions.has(extension)) {
    throw new Error(
      `Rotation is not supported for ${extension || "this file type"}.`,
    );
  }

  if (normalizedRotation) {
    await rotateImagePixels(filePath, normalizedRotation);
  }
  if (needsDate) {
    await writeEmbeddedTags(
      filePath,
      buildEmbeddedDateTags(exifDate),
      "created date",
    );
  }
  return { dateWritten: needsDate, rotated: Boolean(normalizedRotation) };
};

/**
 * Rotates an image by applying a pixel-level transformation using Sharp.
 * Creates a temporary file, applies auto-orientation and rotation, then replaces the original.
 * @param {string} filePath - The path to the image file being rotated.
 * @param {number} rotation - The rotation angle in degrees.
 * @throws {Error} If Sharp fails to rotate the image or file permission is lost.
 */
const rotateImagePixels = async (filePath, rotation) => {
  const extension = path.extname(filePath).toLowerCase();
  const fileStats = await fs.stat(filePath);
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath, extension)}.imageparser-${randomUUID()}${extension}`,
  );

  try {
    const sourceBuffer = await fs.readFile(filePath);
    await sharp(sourceBuffer)
      .autoOrient()
      .rotate(rotation)
      .withMetadata({ orientation: 1 })
      .toFile(temporaryPath);
    await fs.chmod(temporaryPath, fileStats.mode);
    await fs.rename(temporaryPath, filePath);
    await fs.utimes(filePath, fileStats.atime, fileStats.mtime);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
};

/**
 * Applies a rotation to an image file using the appropriate method for its format.
 * Updates EXIF Orientation for JPEG/TIFF or rotates pixels for PNG/WebP.
 * @param {string} filePath - The path to the image file being rotated.
 * @param {*} rotation - The requested rotation angle in degrees.
 * @returns {Promise<boolean>} True if rotation was applied, false if no rotation is needed.
 * @throws {Error} If the file format doesn't support rotation or is invalid.
 */
const applyImageRotation = async (filePath, rotation) => {
  const normalizedRotation = normalizeRotationValue(rotation);
  if (!normalizedRotation) {
    return false;
  }

  const extension = path.extname(filePath).toLowerCase();
  if (!allowedExtensions.has(extension)) {
    throw new Error(`Unsupported image format: ${extension || "unknown"}.`);
  }

  if (metadataRotationExtensions.has(extension)) {
    const tags = await readEmbeddedImageTags(filePath);
    await writeEmbeddedTags(
      filePath,
      {
        "Orientation#": composeExifOrientation(
          tags.Orientation,
          normalizedRotation,
        ),
      },
      "orientation",
    );
  } else if (pixelRotationExtensions.has(extension)) {
    await rotateImagePixels(filePath, normalizedRotation);
  } else {
    throw new Error(
      `Rotation is not supported for ${extension || "this file type"}.`,
    );
  }

  return true;
};

/**
 * Applies rotations to both front and back images in a pair (if needed).
 * Processes up to two images simultaneously using Promise.all for efficiency.
 * @param {{frontPath: string|null, frontRotation: number|null, backPath: string|null, backRotation: number|null}} request - The rotation request containing file paths and angles.
 * @returns {Promise<{ok: boolean, updatedFiles: number, results: Array}>>} The result object with success status, count of successfully rotated files, and detailed results for each image.
 */
const applyImageRotations = async (request) => {
  const rotations = [
    {
      field: "front",
      filePath: String(request?.frontPath ?? ""),
      rotation: request?.frontRotation,
    },
    {
      field: "back",
      filePath: String(request?.backPath ?? ""),
      rotation: request?.backRotation,
    },
  ].filter(
    ({ filePath, rotation }) =>
      filePath && normalizeRotationValue(rotation) !== 0,
  );

  const results = await Promise.all(
    rotations.map(async ({ field, filePath, rotation }) => {
      try {
        await applyImageRotation(filePath, rotation);
        return {
          field,
          filePath,
          ok: true,
          version: buildImageVersion(await fs.stat(filePath)),
        };
      } catch (error) {
        return {
          field,
          filePath,
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "Unable to apply image rotation.",
        };
      }
    }),
  );

  return {
    ok: results.every((result) => result.ok),
    updatedFiles: results.filter((result) => result.ok).length,
    results,
  };
};

/**
 * Returns an empty metadata object with default placeholder values.
 * Used when no metadata exists or as a fallback return value.
 * @returns {{date: string, description: string, tags: string[], rotation: number, hasSidecar: boolean}} An object with empty date/description and empty tags array.
 */
const emptySidecarMetadata = () => ({
  date: "",
  description: "",
  tags: [],
  location: null,
  rotation: 0,
  hasSidecar: false,
});

/**
 * Loads Immich settings from encrypted storage and decrypts API keys.
 * Returns default settings object if the settings file doesn't exist.
 * @param {string} settingsDirectory - The path to the user's application data directory.
 * @param {{encrypt: (value: string) => string, decrypt: (value: string) => string}} secretCodec - An object with encrypt and decrypt functions for secure storage.
 * @returns {Promise<Object>} The decrypted and normalized Immich settings object.
 */
const loadImmichSettings = async (settingsDirectory, secretCodec) => {
  try {
    const settingsPath = path.join(settingsDirectory, immichSettingsFileName);
    const storedSettings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    return {
      ...defaultImmichSettings,
      serverUrl: String(storedSettings.serverUrl ?? ""),
      userApiKey: storedSettings.userApiKey
        ? secretCodec.decrypt(storedSettings.userApiKey)
        : "",
      adminApiKey: storedSettings.adminApiKey
        ? secretCodec.decrypt(storedSettings.adminApiKey)
        : "",
      albumName: String(storedSettings.albumName ?? ""),
      tags: String(storedSettings.tags ?? ""),
      pauseImmichJobs: storedSettings.pauseImmichJobs !== false,
      concurrentTasks:
        Number(storedSettings.concurrentTasks) ||
        defaultImmichSettings.concurrentTasks,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ...defaultImmichSettings };
    }

    throw error;
  }
};

/**
 * Saves Immich settings to encrypted storage with normalized values.
 * Encrypts API keys before writing to ensure they remain secure on disk.
 * Creates the directory if it doesn't exist and sets restrictive file permissions.
 * @param {string} settingsDirectory - The path to the user's application data directory.
 * @param {{encrypt: (value: string) => string, decrypt: (value: string) => string}} secretCodec - An object with encrypt and decrypt functions for secure storage.
 * @param {{serverUrl: string, userApiKey: string, adminApiKey?: string, albumName: string, tags: string, pauseImmichJobs: boolean, concurrentTasks: number}} settings - The normalized settings to save (may contain unencrypted keys).
 * @param {{managedFields?: Array<"serverUrl"|"userApiKey"|"adminApiKey">}} [options] - Fields provided by the server
 *   (environment or sign-in session). They are validated with the rest but always stored empty, so a managed key is
 *   never written to disk, not even encrypted.
 * @returns {Promise<Object>} The normalized settings, including any managed values.
 */
const saveImmichSettings = async (
  settingsDirectory,
  secretCodec,
  settings,
  { managedFields = [] } = {},
) => {
  const normalizedSettings = normalizeImmichSettings(settings);
  const unmanagedSettings = { ...normalizedSettings };
  for (const field of managedFields) {
    unmanagedSettings[field] = "";
  }
  const storedSettings = {
    ...unmanagedSettings,
    userApiKey: unmanagedSettings.userApiKey
      ? secretCodec.encrypt(unmanagedSettings.userApiKey)
      : "",
    adminApiKey: unmanagedSettings.adminApiKey
      ? secretCodec.encrypt(unmanagedSettings.adminApiKey)
      : "",
  };

  await fs.mkdir(settingsDirectory, { recursive: true });
  await fs.writeFile(
    path.join(settingsDirectory, immichSettingsFileName),
    JSON.stringify(storedSettings, null, 2),
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );

  return normalizedSettings;
};

/**
 * Compares folder names the way the folder browser displays them, with numbers in natural order.
 * @param {{name: string}} left - The first folder.
 * @param {{name: string}} right - The second folder.
 * @returns {number} The sort order.
 */
const compareFolderNames = (left, right) =>
  left.name.localeCompare(right.name, undefined, { numeric: true });

/**
 * The hidden marker file that holds folder-level state, such as whether a reviewer finished the folder.
 * The leading dot keeps it out of the folder browser and the image scan; immich-go skips non-media files.
 * @type {string}
 */
const folderStateFileName = ".imageparser.json";

/**
 * The marker file format version written by this build.
 * @type {number}
 */
const folderStateVersion = 1;

const maxProcessedByLength = 128;

/**
 * The state of a folder without a marker file, or with one that cannot be read.
 * @type {Readonly<{processed: false, processedAt: null, processedBy: null}>}
 */
const unprocessedFolderState = Object.freeze({
  processed: false,
  processedAt: null,
  processedBy: null,
});

/**
 * Reads the raw contents of a folder's marker file.
 * @param {string} directoryPath - The folder to read.
 * @returns {Promise<Object>} The parsed marker, or an empty object when it is missing, unreadable, or not a JSON object.
 */
const readFolderMarker = async (directoryPath) => {
  try {
    const marker = JSON.parse(
      await fs.readFile(path.join(directoryPath, folderStateFileName), "utf8"),
    );
    return marker && typeof marker === "object" && !Array.isArray(marker)
      ? marker
      : {};
  } catch {
    return {};
  }
};

/**
 * Reads whether a folder is marked processed, and who marked it when.
 * A missing, unreadable, or corrupt marker file means the folder is not processed.
 * @param {string} directoryPath - The folder to read.
 * @returns {Promise<{processed: boolean, processedAt: string|null, processedBy: string|null}>} The folder state.
 */
const readFolderState = async (directoryPath) => {
  const marker = await readFolderMarker(directoryPath);
  if (marker.processed !== true) {
    return unprocessedFolderState;
  }
  return {
    processed: true,
    processedAt:
      typeof marker.processedAt === "string" ? marker.processedAt : null,
    processedBy:
      typeof marker.processedBy === "string" ? marker.processedBy : null,
  };
};

/**
 * How many subfolders a listing reads at once, so large folders do not open hundreds of files together.
 * @type {number}
 */
const folderListingConcurrency = 16;

/**
 * Maps items through an async function, running at most `limit` calls at a time.
 * @template T, R
 * @param {T[]} items - The items to map.
 * @param {number} limit - The maximum number of calls in flight.
 * @param {(item: T) => Promise<R>} mapper - The async mapping function.
 * @returns {Promise<R[]>} The results, in the same order as the items.
 */
const mapWithConcurrency = async (items, limit, mapper) => {
  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
};

/**
 * Reads when a folder was created on disk, for sorting the folder browser.
 * Filesystems that do not report a creation time (birthtime 0, as on some NFS and SMB mounts) fall
 * back to the modification time, and say so through `createdAtSource`.
 * @param {string} directoryPath - The folder to read.
 * @returns {Promise<{createdAt: number|null, createdAtSource: "created"|"modified"|null}>}
 *   The time in milliseconds and where it came from, or nulls when the folder cannot be read.
 */
const readFolderCreatedAt = async (directoryPath) => {
  try {
    const stats = await fs.stat(directoryPath);
    return stats.birthtimeMs > 0
      ? { createdAt: Math.floor(stats.birthtimeMs), createdAtSource: "created" }
      : { createdAt: Math.floor(stats.mtimeMs), createdAtSource: "modified" };
  } catch {
    return { createdAt: null, createdAtSource: null };
  }
};

/**
 * Reads one folder browser entry: the folder's processed state and its filesystem date.
 * @param {string} name - The name to show.
 * @param {string} directoryPath - The folder's path.
 * @returns {Promise<{name: string, path: string, processed: boolean, processedAt: string|null, processedBy: string|null, createdAt: number|null, createdAtSource: "created"|"modified"|null}>}
 *   The entry.
 */
const readFolderEntry = async (name, directoryPath) => {
  const [state, created] = await Promise.all([
    readFolderState(directoryPath),
    readFolderCreatedAt(directoryPath),
  ]);
  return { name, path: directoryPath, ...state, ...created };
};

/**
 * Normalizes the name recorded as the person who marked a folder processed.
 * @param {*} actor - The signed-in or local user name.
 * @returns {string|null} The trimmed name, or null when there is none.
 */
const normalizeProcessedBy = (actor) =>
  typeof actor === "string" && actor.trim()
    ? actor.trim().slice(0, maxProcessedByLength)
    : null;

/**
 * Writes the processed flag into one folder's marker file, keeping any other fields it holds.
 * Unmarking keeps the file and sets `processed` to false. The file is replaced atomically, so a
 * concurrent listing never reads a partial file. Serialized with other operations on the marker.
 * @param {string} directoryPath - The folder to mark.
 * @param {boolean} value - Whether the folder is processed.
 * @param {string|null} processedBy - Who marked the folder.
 * @returns {Promise<{processed: boolean, processedAt: string|null, processedBy: string|null}>} The new folder state.
 */
const writeFolderProcessed = (directoryPath, value, processedBy) => {
  const markerPath = path.join(directoryPath, folderStateFileName);
  return runImageFileOperation([markerPath], async () => {
    const marker = {
      ...(await readFolderMarker(directoryPath)),
      version: folderStateVersion,
      processed: value,
      processedAt: value ? new Date().toISOString() : null,
      processedBy: value ? processedBy : null,
    };
    const temporaryPath = path.join(
      directoryPath,
      `${folderStateFileName}.${process.pid}.${Date.now()}.tmp`,
    );
    try {
      await fs.writeFile(
        temporaryPath,
        `${JSON.stringify(marker, null, 2)}\n`,
        "utf8",
      );
      await fs.rename(temporaryPath, markerPath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true });
      throw error;
    }
    return readFolderState(directoryPath);
  });
};

/**
 * Lists a folder and every visible folder below it. Hidden folders and symbolic links are skipped,
 * so the walk never leaves the starting folder.
 * @param {string} directoryPath - The folder to start from.
 * @returns {Promise<string[]>} The folder followed by its descendants.
 */
const listFolderTree = async (directoryPath) => {
  const folders = [directoryPath];
  for (let index = 0; index < folders.length; index += 1) {
    const entries = await fs.readdir(folders[index], { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        folders.push(path.join(folders[index], entry.name));
      }
    }
  }
  return folders;
};

/**
 * Marks a folder, and optionally every visible subfolder, as processed or not processed.
 * Callers are responsible for confining the path; the web server resolves it for the user first.
 * @param {string} directoryPath - The folder to mark.
 * @param {boolean} value - Whether the folder is processed.
 * @param {{actor?: string|null, includeSubfolders?: boolean}} [options] - Who is marking the folder,
 *   and whether to mark its subfolders too.
 * @returns {Promise<{ok: boolean, state: {processed: boolean, processedAt: string|null, processedBy: string|null}, updatedFolders: number, errors: string[]}>}
 *   The selected folder's new state, the number of folders written, and any per-subfolder failures.
 * @throws {Error} If the value is not a boolean, the path is not a directory, or the selected folder cannot be written.
 */
const setFolderProcessed = async (
  directoryPath,
  value,
  { actor = null, includeSubfolders = false } = {},
) => {
  if (typeof value !== "boolean") {
    throw new Error("The processed value must be true or false.");
  }
  const stats = await fs.stat(directoryPath);
  if (!stats.isDirectory()) {
    throw new Error("The requested path is not a directory.");
  }

  const processedBy = normalizeProcessedBy(actor);
  const state = await writeFolderProcessed(directoryPath, value, processedBy);
  const errors = [];
  let updatedFolders = 1;
  if (includeSubfolders === true) {
    const [, ...subfolders] = await listFolderTree(directoryPath);
    for (const subfolder of subfolders) {
      try {
        await writeFolderProcessed(subfolder, value, processedBy);
        updatedFolders += 1;
      } catch (error) {
        errors.push(
          `${path.relative(directoryPath, subfolder)}: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    }
  }

  return { ok: errors.length === 0, state, updatedFolders, errors };
};

/**
 * Lists the visible subfolders of a directory, with their processed state and filesystem date, and counts
 * its supported images. Reads one small marker file and runs one stat per subfolder, a limited number at a time.
 * Callers are responsible for confining the path; the web server resolves it for the user first.
 * @param {string} directoryPath - The directory to list.
 * @returns {Promise<{directories: {name: string, path: string, processed: boolean, processedAt: string|null, processedBy: string|null, createdAt: number|null, createdAtSource: "created"|"modified"|null}[], imageCount: number, processed: boolean, processedAt: string|null, processedBy: string|null}>}
 *   The sorted subfolders, skipping hidden ones, the number of supported images directly inside the
 *   directory, and the directory's own processed state.
 * @throws {Error} If the path does not exist or is not a directory.
 */
const listDirectory = async (directoryPath) => {
  const stats = await fs.stat(directoryPath);
  if (!stats.isDirectory()) {
    throw new Error("The requested path is not a directory.");
  }

  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const directories = await mapWithConcurrency(
    entries.filter(
      (entry) => entry.isDirectory() && !entry.name.startsWith("."),
    ),
    folderListingConcurrency,
    (entry) =>
      readFolderEntry(entry.name, path.join(directoryPath, entry.name)),
  );
  directories.sort(compareFolderNames);
  const imageCount = entries.filter(
    (entry) =>
      entry.isFile() &&
      allowedExtensions.has(path.extname(entry.name).toLowerCase()),
  ).length;

  return {
    directories,
    imageCount,
    ...(await readFolderState(directoryPath)),
  };
};

/**
 * Lists the drive roots that are currently readable, such as C:\ and mapped network drives.
 * Only meaningful on Windows; other platforms have a single filesystem root.
 * @returns {Promise<{name: string, path: string, processed: false, processedAt: null, processedBy: null, createdAt: null, createdAtSource: null}[]>}
 *   The available drives in letter order. Drive roots are never marked processed and have no date.
 */
const listDrives = async () => {
  const letters = Array.from({ length: 26 }, (_, index) =>
    String.fromCharCode(65 + index),
  );
  const drives = await Promise.all(
    letters.map(async (letter) => {
      const drivePath = `${letter}:\\`;
      try {
        await fs.access(drivePath);
        return {
          name: `${letter}:`,
          path: drivePath,
          ...unprocessedFolderState,
          createdAt: null,
          createdAtSource: null,
        };
      } catch {
        return null;
      }
    }),
  );
  return drives.filter(Boolean);
};

/**
 * How many folder levels below the selected folder a nested scan may enter.
 * @type {number}
 */
const maxNestedScanDepth = 10;

/**
 * How many supported image files a nested scan may find before it stops.
 * @type {number}
 */
const maxNestedScanFiles = 1000;

/**
 * How many folders a nested scan reads at once; kept small so network shares are not flooded.
 * @type {number}
 */
const nestedScanConcurrency = 4;

/**
 * Splits one folder's entries into supported images, sidecars, and visible subfolders.
 * Symbolic links are followed with stat, so linked folders count as folders.
 * @param {string} directoryPath - The folder that was read.
 * @param {import("node:fs").Dirent[]} entries - The folder's entries.
 * @returns {Promise<{imageFiles: string[], sidecarFiles: string[], subfolders: string[]}>} The sorted entries.
 */
const classifyDirectoryEntries = async (directoryPath, entries) => {
  const imageFiles = [];
  const sidecarFiles = [];
  const subfolders = [];
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    let isDirectory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      isDirectory = await fs
        .stat(entryPath)
        .then((stats) => stats.isDirectory())
        .catch(() => false);
    }
    if (isDirectory) {
      if (!entry.name.startsWith(".")) {
        subfolders.push(entryPath);
      }
      continue;
    }
    const extension = path.extname(entry.name).toLowerCase();
    if (allowedExtensions.has(extension)) {
      imageFiles.push(entryPath);
    } else if (extension === ".xmp" && entry.isFile()) {
      sidecarFiles.push(entryPath);
    }
  }
  return { imageFiles, sidecarFiles, subfolders };
};

/**
 * Finds the supported images in a folder and, when recursive, in every visible folder below it.
 * Hidden folders are skipped. Each folder is visited once by its real path, so symbolic-link loops end,
 * and a folder whose real path the isAllowedPath callback rejects is skipped. Going over the depth or
 * file limit throws instead of returning a partial result.
 * @param {string} directoryPath - The folder to scan.
 * @param {{recursive?: boolean, isAllowedPath?: (realPath: string) => boolean, maxDepth?: number, maxFiles?: number}} [options]
 *   Whether to scan nested folders, a confinement check for the real path of each nested folder, and the limits.
 * @returns {Promise<{imageFiles: string[], sidecarFiles: string[], folderCount: number, hasSubfolders: boolean}>}
 *   The image and sidecar files, the number of folders scanned, and whether the folder has visible subfolders.
 * @throws {Error} If a folder cannot be read or the scan goes over a limit.
 */
const scanImageFiles = async (
  directoryPath,
  {
    recursive = false,
    isAllowedPath = () => true,
    maxDepth = maxNestedScanDepth,
    maxFiles = maxNestedScanFiles,
  } = {},
) => {
  const rootListing = await classifyDirectoryEntries(
    directoryPath,
    await fs.readdir(directoryPath, { withFileTypes: true }),
  );
  const imageFiles = [...rootListing.imageFiles];
  const sidecarFiles = [...rootListing.sidecarFiles];
  const hasSubfolders = rootListing.subfolders.length > 0;
  if (!recursive) {
    return { imageFiles, sidecarFiles, folderCount: 1, hasSubfolders };
  }

  const tooManyFiles = () =>
    new Error(
      `The folder and its nested folders contain more than ${maxFiles} images. Choose a smaller folder.`,
    );
  if (imageFiles.length > maxFiles) {
    throw tooManyFiles();
  }

  const visitedRealPaths = new Set([await fs.realpath(directoryPath)]);
  let folderCount = 1;
  let currentLevel = rootListing.subfolders;
  for (let depth = 1; currentLevel.length; depth += 1) {
    const candidates = await mapWithConcurrency(
      currentLevel,
      nestedScanConcurrency,
      async (folderPath) => {
        const realPath = await fs.realpath(folderPath).catch(() => null);
        return realPath && isAllowedPath(realPath)
          ? { folderPath, realPath }
          : null;
      },
    );
    const folders = [];
    for (const candidate of candidates) {
      if (candidate && !visitedRealPaths.has(candidate.realPath)) {
        visitedRealPaths.add(candidate.realPath);
        folders.push(candidate.folderPath);
      }
    }
    if (folders.length && depth > maxDepth) {
      throw new Error(
        `The folder has nested folders more than ${maxDepth} levels deep. Choose a folder closer to the images.`,
      );
    }

    const listings = await mapWithConcurrency(
      folders,
      nestedScanConcurrency,
      async (folderPath) => {
        try {
          return await classifyDirectoryEntries(
            folderPath,
            await fs.readdir(folderPath, { withFileTypes: true }),
          );
        } catch (error) {
          throw new Error(
            `Unable to read ${path.relative(directoryPath, folderPath)}: ${error instanceof Error ? error.message : "Unknown error"}`,
          );
        }
      },
    );
    folderCount += folders.length;
    currentLevel = [];
    for (const listing of listings) {
      imageFiles.push(...listing.imageFiles);
      sidecarFiles.push(...listing.sidecarFiles);
      currentLevel.push(...listing.subfolders);
    }
    if (imageFiles.length > maxFiles) {
      throw tooManyFiles();
    }
  }

  return { imageFiles, sidecarFiles, folderCount, hasSubfolders };
};

/**
 * Reads all image files from a directory, and optionally its nested folders, and groups them into pairs.
 * Returns file listings with pairing information, creation dates, and date-taken if sorting by date.
 * Also collects tag suggestions from existing sidecar metadata files.
 * @param {string} directoryPath - The path to the directory containing image files.
 * @param {*} [sortBy=defaultSortBy] - The sort field and direction for ordering results (default: createdAt-asc).
 * @param {{recursive?: boolean, isAllowedPath?: (realPath: string) => boolean}} [options] - Whether to include
 *   nested folders, and a check the web server supplies to confine nested folders by their real path.
 * @returns {Promise<{directoryPath: string, recursive: boolean, folderCount: number, files: Array, recentTags: string[], folderState: {processed: boolean, processedAt: string|null, processedBy: string|null}, hasSubfolders: boolean}>}
 *   An object with directory path, whether nested folders were included and how many folders were scanned,
 *   array of paired images, tag suggestions, the folder's processed state, and whether it has visible subfolders.
 * @throws {Error} If a folder cannot be read or a nested scan goes over its limits.
 */
const readDirectory = async (
  directoryPath,
  sortBy = defaultSortBy,
  { recursive = false, isAllowedPath } = {},
) => {
  const isRecursive = recursive === true;
  if (!directoryPath) {
    return {
      directoryPath,
      recursive: isRecursive,
      folderCount: 0,
      files: [],
      recentTags: [],
      folderState: unprocessedFolderState,
      hasSubfolders: false,
    };
  }

  const { imageFiles, sidecarFiles, folderCount, hasSubfolders } =
    await scanImageFiles(directoryPath, {
      recursive: isRecursive,
      isAllowedPath,
    });

  return {
    directoryPath,
    recursive: isRecursive,
    folderCount,
    files: await pairFiles(imageFiles, sortBy, directoryPath),
    recentTags: await readRecentTags(sidecarFiles),
    folderState: await readFolderState(directoryPath),
    hasSubfolders,
  };
};

/**
 * Keeps an image's time of day when the form sends only a calendar day, because the editor edits only the day.
 * The time comes from the A image's current date: its sidecar, or else the image itself (embedded date taken,
 * file name, created date). Must run while the caller holds the A image's lock.
 * @param {string} frontPath - The path to the A image.
 * @param {string} dateValue - The normalized date to save ("YYYY-MM-DD HH:mm:ss").
 * @param {*} requestedDate - The date as sent; only a plain "YYYY-MM-DD" day takes the current time.
 * @returns {Promise<string>} The date to save, with the current time of day when it applies.
 */
const withCurrentTimeOfDay = async (frontPath, dateValue, requestedDate) => {
  const day = String(requestedDate ?? "").trim();
  // An impossible day is left as is, so saving still rejects it.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !buildIsoDateTime(day.split("-"))) {
    return dateValue;
  }
  const currentDate =
    normalizeXmpDate(await readSidecarRawDate(frontPath)) ||
    (await resolveImageDateWithoutSidecar(frontPath, {
      readEmbeddedDate: readEmbeddedDateTakenUnlocked,
    }));
  const time = currentDate.match(/T(\d{2}:\d{2}:\d{2})/)?.[1];
  // Built directly: parsing it with Date would shift the photo's local time by the UTC offset.
  return time ? `${day} ${time}` : dateValue;
};

/**
 * Updates image metadata with provided date, description, and tags, and applies any requested rotations.
 * Writes the A-file sidecar and embeds the date in each image, combining a rotation with the date in one
 * ExifTool write per file. Writes whose stored values already match are skipped.
 * Holds the lock for both images so reads and writes of the same files stay ordered.
 * @param {{frontPath: string, backPath: string|null, date: string, description: string, tags: string[], frontRotation?: number, backRotation?: number}} metadata - The metadata update request containing paths, values, and rotations.
 * @returns {Promise<{ok: boolean, updatedFiles: number, sidecarFile: string, sidecarWritten: boolean, results: Array<{field: "front"|"back", filePath: string, ok: boolean, dateWritten: boolean, rotated: boolean, version?: string, error?: string}>}>} The per-image results; ok is false when any image could not be updated.
 * @throws {Error} If no image is selected, the date is invalid, or the sidecar cannot be written.
 */
const saveMetadata = (metadata) =>
  runImageFileOperation([metadata?.frontPath, metadata?.backPath], async () => {
    if (!metadata?.frontPath) {
      throw new Error("No image selected for metadata update.");
    }

    const dateValue = await withCurrentTimeOfDay(
      metadata.frontPath,
      normalizeDateValue(metadata.date),
      metadata.date,
    );
    normalizeExifDate(dateValue);

    const { sidecarPath, written } = await writeSidecarFile(
      metadata.frontPath,
      dateValue,
      metadata.description,
      metadata.tags,
      metadata.location,
    );

    const images = [
      {
        field: "front",
        filePath: metadata.frontPath,
        rotation: metadata.frontRotation,
      },
      {
        field: "back",
        filePath: metadata.backPath,
        rotation: metadata.backRotation,
      },
    ].filter(({ filePath }) => filePath);

    const results = await Promise.all(
      images.map(async ({ field, filePath, rotation }) => {
        try {
          const { dateWritten, rotated } = await writeEmbeddedImageMetadata(
            filePath,
            dateValue,
            rotation,
          );
          return {
            field,
            filePath,
            ok: true,
            dateWritten,
            rotated,
            version: buildImageVersion(await fs.stat(filePath)),
          };
        } catch (error) {
          return {
            field,
            filePath,
            ok: false,
            dateWritten: false,
            rotated: false,
            error:
              error instanceof Error
                ? error.message
                : "Unable to update the image metadata.",
          };
        }
      }),
    );

    return {
      ok: results.every((result) => result.ok),
      updatedFiles: results.filter(
        (result) => result.ok && (result.dateWritten || result.rotated),
      ).length,
      sidecarFile: sidecarPath,
      sidecarWritten: written,
      results,
    };
  });

/**
 * Reads metadata from an image's sidecar file or returns empty defaults if not found.
 * @param {string} [filePath] - The path to the image file (optional).
 * @returns {Promise<Object>} An object containing date, description, tags array, rotation value, and whether a sidecar exists.
 */
const readSidecarMetadataForFile = async (filePath) => {
  if (!filePath) {
    return emptySidecarMetadata();
  }

  return readSidecarMetadata(filePath);
};

/**
 * Returns the current version string of an image file.
 * The version changes whenever the file is rewritten, so it can be used to refresh cached previews.
 * @param {string} filePath - The path to the image file.
 * @returns {Promise<string>} The version string.
 */
const getImageVersion = async (filePath) =>
  buildImageVersion(await fs.stat(filePath));

/**
 * Checks whether the desktop app needs a rendered preview because the browser cannot show the file.
 * TIFF images always need rendering; so do images with a non-zero rotation.
 * @param {string} filePath - The path to the image file.
 * @param {number} [rotation=0] - The current rotation angle in degrees.
 * @returns {boolean} True if the image needs a rendered preview, false otherwise.
 */
const needsRenderedPreview = (filePath, rotation = 0) => {
  const extension = path.extname(filePath).toLowerCase();
  return (
    normalizeRotationValue(rotation) !== 0 ||
    [".tif", ".tiff"].includes(extension)
  );
};

/**
 * Renders an image file as a WebP preview whose longest side is at most previewMaxDimension pixels.
 * First applies EXIF auto-orientation, then rotates if needed.
 * @param {string} filePath - The path to the source image file.
 * @param {number} [rotation=0] - The rotation angle in degrees to apply after auto-orientation.
 * @returns {Promise<Buffer>} A Promise resolving to a WebP image buffer.
 */
const renderPreview = (filePath, rotation = 0) => {
  const normalizedRotation = normalizeRotationValue(rotation);
  let image = sharp(filePath).autoOrient();
  if (normalizedRotation) {
    image = image.rotate(normalizedRotation);
  }
  return image
    .resize({
      width: previewMaxDimension,
      height: previewMaxDimension,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ preset: "photo", quality: 80 })
    .toBuffer();
};

/**
 * Creates a limiter that runs at most the given number of renders at the same time.
 * @param {number} maxConcurrent - The number of renders that may run at once.
 * @returns {(operation: () => Promise<Buffer>) => Promise<Buffer>} Runs a render once a slot is free.
 */
const createRenderLimiter = (maxConcurrent) => {
  let active = 0;
  const waiting = [];

  return async (operation) => {
    if (active >= maxConcurrent) {
      // The finishing render hands its slot straight to the next waiting render.
      await new Promise((resolve) => waiting.push(resolve));
    } else {
      active += 1;
    }

    try {
      return await operation();
    } finally {
      const next = waiting.shift();
      if (next) {
        next();
      } else {
        active -= 1;
      }
    }
  };
};

/**
 * Runs a preview render once one of the limited preview render slots is free.
 */
const withPreviewRenderSlot = createRenderLimiter(maxConcurrentPreviewRenders);

/**
 * Runs a thumbnail render once one of the limited thumbnail render slots is free.
 */
const withThumbnailRenderSlot = createRenderLimiter(
  maxConcurrentThumbnailRenders,
);

/**
 * Returns a resized WebP preview of an image, from the preview cache when possible.
 * Holds only this file's lock, so previews never wait behind writes to other files.
 * @param {string} filePath - The path to the source image file.
 * @param {number} [rotation=0] - The rotation angle in degrees to apply after auto-orientation.
 * @returns {Promise<{buffer: Buffer, version: string, contentType: string}>} The preview and the source file's version.
 */
const getImagePreview = (filePath, rotation = 0) =>
  runImageFileOperation([filePath], async () => {
    const normalizedRotation = normalizeRotationValue(rotation);
    const stats = await fs.stat(filePath);
    const version = buildImageVersion(stats);
    const cache = previewCache;
    const cacheKey = cache
      ? buildPreviewCacheKey(filePath, stats, normalizedRotation)
      : null;

    const cachedBuffer = cacheKey ? await cache.get(cacheKey) : null;
    if (cachedBuffer) {
      return { buffer: cachedBuffer, version, contentType: "image/webp" };
    }

    const buffer = await withPreviewRenderSlot(() =>
      renderPreview(filePath, normalizedRotation),
    );
    if (cacheKey) {
      // Storing the preview does not touch the source file, so it does not need to hold the lock.
      void cache.put(cacheKey, buffer);
    }
    return { buffer, version, contentType: "image/webp" };
  });

/**
 * Enables the on-disk preview cache.
 * @param {{directory: string, maxBytes?: number}} options - The cache directory (outside the photo root) and its size cap.
 * @returns {ReturnType<typeof createPreviewCache>} The configured cache.
 */
const configurePreviewCache = (options) => {
  previewCache = createPreviewCache(options);
  // Trim the cache left by earlier runs without delaying startup.
  void previewCache.prune().catch(() => {});
  return previewCache;
};

/**
 * Renders a small WebP thumbnail that fits within a square of the given size.
 * Applies EXIF auto-orientation first, so saved rotations show in the thumbnail.
 * @param {string} filePath - The path to the source image file.
 * @param {{size?: number, rotation?: number}} [options] - The long-edge size in pixels and an extra rotation.
 * @returns {Promise<Buffer>} A Promise resolving to a WebP image buffer.
 */
const renderThumbnail = async (
  filePath,
  { size = defaultThumbnailSize, rotation = 0 } = {},
) => {
  const normalizedRotation = normalizeRotationValue(rotation);
  let image = sharp(filePath).autoOrient();
  if (normalizedRotation) {
    image = image.rotate(normalizedRotation);
  }
  return image
    .resize(size, size, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 60 })
    .toBuffer();
};

/**
 * Renders a thumbnail from a cached preview, which is already oriented and rotated.
 * Decoding the small preview is much cheaper than decoding a large original.
 * @param {Buffer} preview - The cached WebP preview.
 * @param {number} size - The long-edge size in pixels.
 * @returns {Promise<Buffer>} A Promise resolving to a WebP image buffer.
 */
const renderThumbnailFromPreview = (preview, size) =>
  sharp(preview)
    .resize(size, size, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 60 })
    .toBuffer();

/**
 * Clamps a requested thumbnail size to the supported range.
 * @param {*} value - The requested long-edge size in pixels.
 * @returns {number} A whole number of pixels, or the default size when the value is invalid.
 */
const normalizeThumbnailSize = (value) => {
  const size = Math.round(Number(value));
  if (!Number.isFinite(size) || size <= 0) {
    return defaultThumbnailSize;
  }
  return Math.min(Math.max(size, minThumbnailSize), maxThumbnailSize);
};

/**
 * Builds the cache key for a thumbnail. Any rewrite of the file (rotation, metadata write)
 * changes its version, and a rename changes its path, so stale thumbnails are never served.
 * @param {string} filePath - The path to the source image file.
 * @param {import("node:fs").Stats} stats - The file's current stats.
 * @param {number} size - The thumbnail size in pixels.
 * @param {number} rotation - The normalized extra rotation.
 * @returns {string} The cache key.
 */
const getThumbnailCacheKey = (filePath, stats, size, rotation) =>
  [path.resolve(filePath), buildImageVersion(stats), rotation, size].join("|");

/**
 * Returns a cached thumbnail and marks it as recently used.
 * @param {string} key - The thumbnail cache key.
 * @returns {Buffer|null} The cached thumbnail, or null when it is not cached.
 */
const readCachedThumbnail = (key) => {
  const buffer = thumbnailCache.get(key);
  if (!buffer) {
    return null;
  }
  thumbnailCache.delete(key);
  thumbnailCache.set(key, buffer);
  return buffer;
};

/**
 * Stores a thumbnail, evicting the least recently used ones beyond the cache size limit.
 * @param {string} key - The thumbnail cache key.
 * @param {Buffer} buffer - The rendered thumbnail.
 */
const cacheThumbnail = (key, buffer) => {
  if (buffer.length > maxThumbnailCacheBytes) {
    return;
  }
  const previous = thumbnailCache.get(key);
  if (previous) {
    thumbnailCacheBytes -= previous.length;
    thumbnailCache.delete(key);
  }
  thumbnailCache.set(key, buffer);
  thumbnailCacheBytes += buffer.length;

  for (const [oldestKey, oldestBuffer] of thumbnailCache) {
    if (thumbnailCacheBytes <= maxThumbnailCacheBytes) {
      break;
    }
    thumbnailCache.delete(oldestKey);
    thumbnailCacheBytes -= oldestBuffer.length;
  }
};

/**
 * Clears the in-memory thumbnail cache, as an app or container restart would.
 * The on-disk preview cache keeps its thumbnails.
 */
const clearThumbnailMemoryCache = () => {
  thumbnailCache.clear();
  thumbnailCacheBytes = 0;
};

/**
 * Returns a thumbnail from the memory cache or the on-disk preview cache.
 * @param {string} filePath - The path to the source image file.
 * @param {import("node:fs").Stats} stats - The file's current stats.
 * @param {number} size - The thumbnail size in pixels.
 * @param {number} rotation - The normalized extra rotation.
 * @returns {Promise<Buffer|null>} The cached thumbnail, or null when it is not cached.
 */
const readStoredThumbnail = async (filePath, stats, size, rotation) => {
  const memoryKey = getThumbnailCacheKey(filePath, stats, size, rotation);
  const cached = readCachedThumbnail(memoryKey);
  if (cached) {
    return cached;
  }
  const cache = previewCache;
  const stored = cache
    ? await cache.get(buildThumbnailCacheKey(filePath, stats, rotation, size))
    : null;
  if (stored) {
    cacheThumbnail(memoryKey, stored);
  }
  return stored;
};

/**
 * Returns a thumbnail from the memory or on-disk cache without taking a render slot, or
 * renders it while holding the file's lock and one of the thumbnail render slots. A thumbnail
 * is built from the file's cached preview when one exists, and from the original otherwise.
 * A request whose signal is aborted before rendering starts is dropped, so thumbnails for a
 * grid the user has left do not delay previews or metadata writes.
 * @param {string} filePath - The path to the source image file.
 * @param {{size?: number, rotation?: number, signal?: AbortSignal}} [options] - The thumbnail size, extra rotation, and cancellation signal.
 * @returns {Promise<Buffer>} A Promise resolving to a WebP image buffer.
 * @throws {DOMException} An AbortError when the signal is aborted before rendering starts.
 */
const getThumbnail = async (filePath, { size, rotation, signal } = {}) => {
  const thumbnailSize = normalizeThumbnailSize(size);
  const normalizedRotation = normalizeRotationValue(rotation);
  const cached = await readStoredThumbnail(
    filePath,
    await fs.stat(filePath),
    thumbnailSize,
    normalizedRotation,
  );
  if (cached) {
    return cached;
  }

  signal?.throwIfAborted();
  return runImageFileOperation([filePath], async () => {
    signal?.throwIfAborted();
    // A write queued ahead of this request may have changed the file.
    const stats = await fs.stat(filePath);
    const current = await readStoredThumbnail(
      filePath,
      stats,
      thumbnailSize,
      normalizedRotation,
    );
    if (current) {
      return current;
    }
    const cache = previewCache;
    const preview = cache
      ? await cache.get(
          buildPreviewCacheKey(filePath, stats, normalizedRotation),
        )
      : null;
    const buffer = await withThumbnailRenderSlot(() => {
      signal?.throwIfAborted();
      return preview
        ? renderThumbnailFromPreview(preview, thumbnailSize)
        : renderThumbnail(filePath, {
            size: thumbnailSize,
            rotation: normalizedRotation,
          });
    });
    cacheThumbnail(
      getThumbnailCacheKey(filePath, stats, thumbnailSize, normalizedRotation),
      buffer,
    );
    if (cache) {
      // Storing the thumbnail does not touch the source file, so it does not need to hold the lock.
      void cache.put(
        buildThumbnailCacheKey(
          filePath,
          stats,
          normalizedRotation,
          thumbnailSize,
        ),
        buffer,
      );
    }
    return buffer;
  });
};

/**
 * Queues an image rotation request while holding the lock for both images.
 * @param {{frontPath: string|null, frontRotation: number|null, backPath: string|null, backRotation: number|null}} request - The rotation request with file paths and angles.
 * @returns {Promise<{ok: boolean, updatedFiles: number, results: Array}>>} The result of applying rotations to both images (if present).
 */
const applyImageRotationsQueued = (request) =>
  runImageFileOperation([request?.frontPath, request?.backPath], () =>
    applyImageRotations(request),
  );

/**
 * Checks whether a path exists without following symlinks.
 * @param {string} filePath - The path to check.
 * @returns {Promise<boolean>} True if something exists at the path.
 */
const pathExists = async (filePath) => {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

/**
 * Lists the renames that set or clear the exclude marker on a group's images and sidecars.
 * Sidecars are looked up under both the flagged and unflagged image names, so a group that
 * was partly renamed by hand is brought back in line. Every target stays in its source folder.
 * @param {string[]} imagePaths - The group's image paths.
 * @param {boolean} value - True to flag the group, false to clear the flag.
 * @returns {Promise<Array<{from: string, to: string}>>} The renames still needed.
 */
const planDoNotUploadRenames = async (imagePaths, value) => {
  const renameFileName = value ? toExcludedName : toIncludedName;
  const plannedSources = new Set();
  const plan = [];
  const addRename = (from) => {
    if (plannedSources.has(from)) {
      return;
    }
    plannedSources.add(from);
    const to = path.join(
      path.dirname(from),
      renameFileName(path.basename(from)),
    );
    if (to !== from) {
      plan.push({ from, to });
    }
  };

  for (const imagePath of imagePaths) {
    addRename(imagePath);
    const directory = path.dirname(imagePath);
    const imageName = path.basename(imagePath);
    for (const name of new Set([
      toIncludedName(imageName),
      toExcludedName(imageName),
    ])) {
      for (const sidecarPath of getSidecarCandidatePaths(
        path.join(directory, name),
      )) {
        if (await pathExists(sidecarPath)) {
          addRename(sidecarPath);
        }
      }
    }
  }

  return plan;
};

/**
 * Flags an image group "Do not upload" by renaming its images and sidecars to carry the
 * exclude marker, or clears the flag by removing it. Nothing is renamed when a target name
 * already exists, and renames already done are undone if a later one fails.
 * @param {{frontPath: string, backPath: string|null, value: boolean, relativeDirectory?: string}} request - The group,
 *   the flag value, and the group's folder relative to the loaded folder, used only for the returned id and label.
 * @param {{rename?: (from: string, to: string) => Promise<void>}} [options] - Overrides the rename function (for tests).
 * @returns {Promise<{ok: boolean, id: string, imageLabel: string, relativeDirectory: string, frontPath: string, backPath: string|null, frontVersion: string, backVersion: string|null, doNotUpload: boolean, excludeMismatch: boolean, renamed: Array<{from: string, to: string}>}>}
 * @throws {Error} If the request is invalid, a target exists, or a rename fails.
 */
const setDoNotUpload = async (request, { rename = fs.rename } = {}) => {
  const frontPath = String(request?.frontPath ?? "");
  const backPath = request?.backPath ? String(request.backPath) : null;
  const value = request?.value;
  const relativeDirectory =
    typeof request?.relativeDirectory === "string"
      ? request.relativeDirectory
      : "";
  if (!frontPath) {
    throw new Error("No image selected to flag.");
  }
  if (typeof value !== "boolean") {
    throw new Error("Choose whether the image group should be uploaded.");
  }

  const imagePaths = [frontPath, backPath].filter(Boolean);
  for (const imagePath of imagePaths) {
    if (!allowedExtensions.has(path.extname(imagePath).toLowerCase())) {
      throw new Error(`${path.basename(imagePath)} is not a supported image.`);
    }
  }
  if (
    backPath &&
    (path.dirname(backPath) !== path.dirname(frontPath) ||
      getGroupKey(path.basename(backPath)) !==
        getGroupKey(path.basename(frontPath)))
  ) {
    throw new Error("The front and back images must belong to the same group.");
  }
  for (const imagePath of imagePaths) {
    if (!(await pathExists(imagePath))) {
      throw new Error(
        `${path.basename(imagePath)} no longer exists. Reload the folder.`,
      );
    }
  }

  const plan = await planDoNotUploadRenames(imagePaths, value);
  const action = value ? "flag" : "clear the flag on";
  const plannedTargets = new Set();
  for (const { to } of plan) {
    if (plannedTargets.has(to) || (await pathExists(to))) {
      throw new Error(
        `Unable to ${action} this image group because ${path.basename(to)} already exists. No files were renamed.`,
      );
    }
    plannedTargets.add(to);
  }

  const renamed = [];
  for (const operation of plan) {
    try {
      await rename(operation.from, operation.to);
      renamed.push(operation);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown error";
      const notRolledBack = new Set();
      for (const done of [...renamed].reverse()) {
        try {
          await rename(done.to, done.from);
        } catch {
          notRolledBack.add(done);
        }
      }

      if (!notRolledBack.size) {
        throw new Error(
          `Unable to rename ${path.basename(operation.from)}: ${reason} No files were renamed.`,
        );
      }

      const currentNames = plan
        .map(
          (planned) =>
            `${path.basename(planned.from)} is now ${path.basename(
              notRolledBack.has(planned) ? planned.to : planned.from,
            )}`,
        )
        .join("; ");
      throw new Error(
        `Unable to rename ${path.basename(operation.from)}: ${reason} Some renames could not be undone. Current names: ${currentNames}.`,
      );
    }
  }

  // Preview URLs carry the path and the file version, so report the renamed files' versions.
  const renamedPath = (filePath) =>
    renamed.find(({ from }) => from === filePath)?.to ?? filePath;
  const nextFrontPath = renamedPath(frontPath);
  const nextBackPath = backPath && renamedPath(backPath);
  return {
    ok: true,
    ...describePair(nextFrontPath, nextBackPath, relativeDirectory),
    frontVersion: await getImageVersion(nextFrontPath),
    backVersion: nextBackPath ? await getImageVersion(nextBackPath) : null,
    renamed,
  };
};

/**
 * Queues a "Do not upload" rename so it never overlaps metadata writes, rotations, or previews.
 * @param {{frontPath: string, backPath: string|null, value: boolean}} request - The group and the flag value.
 * @param {{rename?: (from: string, to: string) => Promise<void>}} [options] - Overrides the rename function (for tests).
 * @returns {ReturnType<typeof setDoNotUpload>} The renamed group.
 */
const setDoNotUploadQueued = (request, options) =>
  runImageFileOperation([request?.frontPath, request?.backPath], () =>
    setDoNotUpload(request, options),
  );

/**
 * Sets the date on every image pair in a directory that does not already have
 * an XMP sidecar file. Pairs with an existing sidecar are skipped so their
 * previously saved metadata is preserved, and pairs flagged "Do not upload"
 * are skipped as well.
 * With recursive set, every nested folder is covered, within the same limits as the nested scan.
 * @param {string} directoryPath - The path to the directory.
 * @param {string} date - The ISO date string to apply (e.g. "1991-12-31").
 * @param {{recursive?: boolean, isAllowedPath?: (realPath: string) => boolean}} [options] - Whether to include
 *   nested folders, and the confinement check for them (see readDirectory).
 * @returns {Promise<{ok: boolean, updatedPairs: number, skippedPairs: number, excludedPairs: number, errors: string[]}>}
 */
const setFolderDate = async (
  directoryPath,
  date,
  { recursive = false, isAllowedPath } = {},
) => {
  const { files: pairs } = await readDirectory(directoryPath, defaultSortBy, {
    recursive,
    isAllowedPath,
  });

  const errors = [];
  let updatedPairs = 0;
  let skippedPairs = 0;
  let excludedPairs = 0;

  for (const pair of pairs) {
    if (pair.doNotUpload) {
      excludedPairs += 1;
      continue;
    }

    try {
      const existingSidecar = await resolveExistingSidecarPath(pair.frontPath);
      if (existingSidecar) {
        skippedPairs += 1;
        continue;
      }

      const result = await saveMetadata({
        frontPath: pair.frontPath,
        backPath: pair.backPath,
        date,
        description: "",
        tags: [],
      });
      if (!result.ok) {
        throw new Error(
          result.results
            .filter((imageResult) => !imageResult.ok)
            .map((imageResult) => imageResult.error)
            .join(" "),
        );
      }
      updatedPairs += 1;
    } catch (error) {
      errors.push(
        `${pair.imageLabel}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    updatedPairs,
    skippedPairs,
    excludedPairs,
    errors,
  };
};

/**
 * Sets the date on the chosen image groups, following the rules of saving one image: the A-file sidecar is
 * created or rewritten, a plain day keeps the group's time of day, and the date is embedded in each image.
 * A group's saved description and tags are kept. Unlike setFolderDate, groups that already have a sidecar are
 * updated too, because the user chose them.
 * @param {Array<{frontPath: string, backPath: string|null}>} pairs - The groups to date.
 * @param {string} date - The date to apply (e.g. "1991-12-31").
 * @returns {Promise<{ok: boolean, updatedPairs: number, failedFrontPaths: string[], errors: string[]}>}
 */
const setPairsDate = async (pairs, date) => {
  const errors = [];
  const failedFrontPaths = [];
  let updatedPairs = 0;

  for (const pair of pairs) {
    try {
      const { description, tags } = await readSidecarMetadata(pair.frontPath);
      const result = await saveMetadata({
        frontPath: pair.frontPath,
        backPath: pair.backPath,
        date,
        description,
        tags,
      });
      if (!result.ok) {
        throw new Error(
          result.results
            .filter((imageResult) => !imageResult.ok)
            .map((imageResult) => imageResult.error)
            .join(" "),
        );
      }
      updatedPairs += 1;
    } catch (error) {
      failedFrontPaths.push(pair.frontPath);
      errors.push(
        `${path.basename(pair.frontPath)}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  return { ok: errors.length === 0, updatedPairs, failedFrontPaths, errors };
};

/**
 * Adds tags to an existing tag list without removing or replacing any, skipping duplicates ignoring case.
 * @param {string[]} existingTags - The tags already saved.
 * @param {string[]} addedTags - The tags to add.
 * @returns {string[]} The existing tags in their original order and spelling, then the new ones.
 */
const mergeTags = (existingTags, addedTags) =>
  normalizeTags([...normalizeTags(existingTags), ...normalizeTags(addedTags)]);

/**
 * Adds tags to the chosen image groups. Each group's A-file sidecar is read, the tags are merged in (existing
 * tags are never removed), and the sidecar is rewritten through saveMetadata, so writes stay serialized by the
 * image file queue and the group's date and description are kept. One group failing does not stop the rest.
 * @param {Array<{frontPath: string, backPath: string|null}>} pairs - The groups to tag.
 * @param {string[]} tags - The tags to add.
 * @param {{readMetadata?: typeof readSidecarMetadata, save?: typeof saveMetadata}} [dependencies] - Replaceable
 *   read and save steps, for tests.
 * @returns {Promise<{ok: boolean, updatedPairs: number, failedFrontPaths: string[], errors: string[]}>}
 */
const addTagsToPairs = async (
  pairs,
  tags,
  { readMetadata = readSidecarMetadata, save = saveMetadata } = {},
) => {
  const tagsToAdd = normalizeTags(tags);
  if (!tagsToAdd.length) {
    throw new Error("Enter at least one tag.");
  }

  const errors = [];
  const failedFrontPaths = [];
  let updatedPairs = 0;

  for (const pair of pairs) {
    try {
      const {
        date,
        description,
        tags: existingTags,
      } = await readMetadata(pair.frontPath);
      const result = await save({
        frontPath: pair.frontPath,
        backPath: pair.backPath,
        date,
        description,
        tags: mergeTags(existingTags, tagsToAdd),
      });
      if (!result.ok) {
        throw new Error(
          result.results
            .filter((imageResult) => !imageResult.ok)
            .map((imageResult) => imageResult.error)
            .join(" "),
        );
      }
      updatedPairs += 1;
    } catch (error) {
      failedFrontPaths.push(pair.frontPath);
      errors.push(
        `${path.basename(pair.frontPath)}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  return { ok: errors.length === 0, updatedPairs, failedFrontPaths, errors };
};

/**
 * Counts how many of the chosen image groups already have a saved location, so replacing them can be confirmed.
 * Groups whose sidecar cannot be read count as having none.
 * @param {Array<{frontPath: string, backPath: string|null}>} pairs - The groups to check.
 * @param {{readMetadata?: typeof readSidecarMetadata}} [dependencies] - A replaceable read step, for tests.
 * @returns {Promise<number>} The number of groups with a location.
 */
const countPairsWithLocation = async (
  pairs,
  { readMetadata = readSidecarMetadata } = {},
) => {
  let count = 0;
  for (const pair of pairs) {
    try {
      if ((await readMetadata(pair.frontPath)).location) {
        count += 1;
      }
    } catch {
      // An unreadable sidecar has no location to replace.
    }
  }
  return count;
};

/**
 * Applies one place to the chosen image groups. Each group's A-file sidecar is read and rewritten through
 * saveMetadata, so writes stay serialized by the image file queue and the group's date, description and tags are
 * kept. One group failing does not stop the rest.
 * @param {Array<{frontPath: string, backPath: string|null}>} pairs - The groups to update.
 * @param {SidecarLocation} location - The place to save.
 * @param {{readMetadata?: typeof readSidecarMetadata, save?: typeof saveMetadata}} [dependencies] - Replaceable
 *   read and save steps, for tests.
 * @returns {Promise<{ok: boolean, updatedPairs: number, failedFrontPaths: string[], errors: string[]}>}
 * @throws {Error} If the location is missing or its coordinates are out of range.
 */
const setLocationForPairs = async (
  pairs,
  location,
  { readMetadata = readSidecarMetadata, save = saveMetadata } = {},
) => {
  const safeLocation = normalizeLocation(location);
  if (!safeLocation) {
    throw new Error("Choose a place first.");
  }

  const errors = [];
  const failedFrontPaths = [];
  let updatedPairs = 0;

  for (const pair of pairs) {
    try {
      const { date, description, tags } = await readMetadata(pair.frontPath);
      const result = await save({
        frontPath: pair.frontPath,
        backPath: pair.backPath,
        date,
        description,
        tags,
        location: safeLocation,
      });
      if (!result.ok) {
        throw new Error(
          result.results
            .filter((imageResult) => !imageResult.ok)
            .map((imageResult) => imageResult.error)
            .join(" "),
        );
      }
      updatedPairs += 1;
    } catch (error) {
      failedFrontPaths.push(pair.frontPath);
      errors.push(
        `${path.basename(pair.frontPath)}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  return { ok: errors.length === 0, updatedPairs, failedFrontPaths, errors };
};

/**
 * Resets the processing state of every image in a directory by deleting its XMP sidecar files.
 * Only sidecars belonging to the folder's images are deleted (both naming conventions, for the A and B
 * images), never other .xmp files. Images and the folder's own processed marker are left untouched.
 * With recursive set, every nested folder is covered, within the same limits as the nested scan.
 * @param {string} directoryPath - The path to the directory.
 * @param {{recursive?: boolean, isAllowedPath?: (realPath: string) => boolean}} [options] - Whether to include
 *   nested folders, and the confinement check for them (see readDirectory).
 * @returns {Promise<{ok: boolean, deletedFiles: number, resetPairs: number, errors: string[]}>}
 */
const resetFolderMetadata = async (
  directoryPath,
  { recursive = false, isAllowedPath } = {},
) => {
  const { files: pairs } = await readDirectory(directoryPath, defaultSortBy, {
    recursive,
    isAllowedPath,
  });

  const errors = [];
  let deletedFiles = 0;
  let resetPairs = 0;

  for (const pair of pairs) {
    const imagePaths = [pair.frontPath, pair.backPath].filter(Boolean);
    try {
      const deleted = await runImageFileOperation(imagePaths, async () => {
        let count = 0;
        for (const imagePath of imagePaths) {
          for (const sidecarPath of getSidecarCandidatePaths(imagePath)) {
            try {
              await fs.unlink(sidecarPath);
              count += 1;
            } catch (error) {
              if (error?.code !== "ENOENT") {
                throw error;
              }
            }
          }
        }
        return count;
      });
      deletedFiles += deleted;
      if (deleted > 0) {
        resetPairs += 1;
      }
    } catch (error) {
      errors.push(
        `${pair.imageLabel}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  return { ok: errors.length === 0, deletedFiles, resetPairs, errors };
};

/**
 * Resolves once every queued image file operation (saves, rotations, previews) has finished.
 * @returns {Promise<void>}
 */
const whenImageFileOperationsIdle = () => imageFileLock.whenIdle();

/**
 * Gracefully shuts down ExifTool to release file handles and system resources.
 * Should be called when the application is closing to ensure clean shutdown.
 */
const shutdownCore = () => exiftool.end();

export {
  allowedExtensions,
  applyImageRotationsQueued as applyImageRotations,
  buildImmichUploadArguments,
  clearThumbnailMemoryCache,
  configurePreviewCache,
  defaultSortBy,
  defaultThumbnailSize,
  folderStateFileName,
  getGroupKey,
  getImagePreview,
  getImageVersion,
  getImmichFailureHints,
  getImmichGoDiagnostics,
  getThumbnail,
  listDirectory,
  listDrives,
  loadImmichSettings,
  needsRenderedPreview,
  normalizeRotationValue,
  normalizeSortBy,
  normalizeThumbnailSize,
  readDirectory,
  readFolderEntry,
  readFolderState,
  readSidecarMetadataForFile as readSidecarMetadata,
  renderThumbnail,
  runImmichUpload,
  saveImmichSettings,
  saveMetadata,
  scanImageFiles,
  setDoNotUploadQueued as setDoNotUpload,
  addTagsToPairs,
  countPairsWithLocation,
  setLocationForPairs,
  formatXmpCoordinate,
  parseXmpCoordinate,
  buildSidecarDocument,
  writeSidecarFile,
  readLocationFromXmp,
  mergeTags,
  setFolderDate,
  resetFolderMetadata,
  setPairsDate,
  setFolderProcessed,
  shutdownCore,
  toExcludedName,
  toIncludedName,
  whenImageFileOperationsIdle,
};
