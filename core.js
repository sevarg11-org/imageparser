import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { exiftool } from "exiftool-vendored";
import sharp from "sharp";
import { createSerialQueue } from "./imageFileQueue.js";

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
 * A Map tracking revision numbers for modified image files.
 * Used to detect changes between the original and processed images.
 * @type {Map<string, number>}
 */
const imageRevisionByPath = new Map();

/**
 * Creates a serial queue to prevent concurrent image file operations.
 * Ensures metadata writes and preview reads do not conflict.
 * @type {AsyncQueue}
 */
const runImageFileOperation = createSerialQueue();

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
  pauseImmichJobs: true,
  concurrentTasks: 2,
});

/**
 * Flag indicating whether an Immich upload operation is currently running.
 * Prevents multiple simultaneous uploads to avoid conflicts.
 * @type {boolean}
 */
let isImmichUploadRunning = false;

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
    pauseImmichJobs: settings?.pauseImmichJobs !== false,
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
 * @returns {string[]} An array of command-line arguments for immich-go.
 */
const buildImmichUploadArguments = (settings, directoryPath) => {
  const tags = normalizeImmichTags(settings.tags);
  const uploadArguments = [
    "upload",
    "from-folder",
    `--concurrent-tasks=${String(settings.concurrentTasks)}`,
    "--no-ui",
    `--server=${settings.serverUrl}`,
    "--recursive=false",
    `--api-key=${settings.userApiKey}`,
    `--pause-immich-jobs=${settings.pauseImmichJobs}`,
    `--into-album=${settings.albumName}`,
    `--ban-file=**_b.**`,
  ];

  if (settings.adminApiKey) {
    uploadArguments.push(`--admin-api-key=${settings.adminApiKey}`);
  }

  for (const tag of tags) {
    uploadArguments.push(`--tag=${tag}`);
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
 * Runs immich-go to upload images from a folder to the Immich server.
 * Executes asynchronously and prevents concurrent uploads.
 * @param {{serverUrl: string, userApiKey: string, adminApiKey?: string, albumName: string, tags: string, pauseImmichJobs: boolean, concurrentTasks: number}} settings - The validated Immich settings.
 * @param {string} directoryPath - The path to the directory containing images to upload.
 * @param {(progress: {phase: string, output: string}) => void} [reportProgress] - Optional callback for progress updates.
 * @returns {{ok: boolean, exitCode: number, output: string}} The result of the upload operation with redacted output.
 * @throws {Error} If an upload is already running or the directory path is invalid.
 */
const runImmichUpload = async (
  settings,
  directoryPath,
  reportProgress = () => {},
) => {
  if (isImmichUploadRunning) {
    throw new Error("An Immich upload is already running.");
  }

  isImmichUploadRunning = true;

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
    );

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
        reportProgress({
          phase: "uploading",
          output: redactImmichSecrets(chunk.toString(), normalizedSettings),
        });
      });
      uploadProcess.stderr.on("data", (chunk) => {
        stderr = appendBoundedOutput(stderr, chunk);
        reportProgress({
          phase: "uploading",
          output: redactImmichSecrets(chunk.toString(), normalizedSettings),
        });
      });
      uploadProcess.on("error", (error) => {
        reject(
          error?.code === "ENOENT"
            ? new Error(
                "immich-go was not found. Confirm it is installed and available on PATH.",
              )
            : error,
        );
      });
      uploadProcess.on("close", (exitCode) => {
        const combinedOutput = [stdout.trim(), stderr.trim()]
          .filter(Boolean)
          .join("\n");
        resolve({
          ok: exitCode === 0,
          exitCode: exitCode ?? -1,
          output: redactImmichSecrets(combinedOutput, normalizedSettings),
        });
      });
    });
  } finally {
    isImmichUploadRunning = false;
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
  const normalizedStem = stem.replace(/[_-](?:a|b|front|back)$/i, "");
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

const sortPairs = (pairs, sortBy) => {
  const { field, direction } = normalizeSortBy(sortBy);
  const directionFactor = direction === "desc" ? -1 : 1;

  return pairs.sort((left, right) => {
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

const readSidecarRawDate = async (filePath) => {
  const sidecarPath = await resolveExistingSidecarPath(filePath);
  if (!sidecarPath) {
    return "";
  }

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
 * Reads and compares date taken timestamps from front/back image pairs.
 * Returns the most valid timestamp found across both files in the pair.
 * @param {string|null} frontPath - The path to the front image file.
 * @param {string|null} backPath - The path to the back image file.
 * @returns {Promise<number|null>} A timestamp if a valid date is found, null otherwise.
 */
const readDateTakenTimestamp = async (frontPath, backPath) => {
  for (const filePath of [frontPath, backPath]) {
    if (!filePath) {
      continue;
    }

    const normalizedDate = normalizeXmpDate(await readSidecarRawDate(filePath));
    const timestamp = normalizedDate ? Date.parse(normalizedDate) : Number.NaN;
    if (!Number.isNaN(timestamp)) {
      return timestamp;
    }
  }

  return null;
};

/**
 * Groups image files by their base name and creates front/back pairs.
 * Supports date-taken sorting when available, falling back to file creation time.
 * @param {string[]} filePaths - The array of image file paths in the directory.
 * @param {*} [sortBy=defaultSortBy] - The sort field and direction (default: createdAt-asc).
 * @returns {Promise<Array<{id: string, imageLabel: string, frontPath: string, backPath: string|null, createdAt: number, dateTaken: number|null}>>}
 */
const pairFiles = async (filePaths, sortBy = defaultSortBy) => {
  const shouldReadDateTaken = normalizeSortBy(sortBy).field === "dateTaken";
  const grouped = new Map();

  for (const filePath of filePaths) {
    const fileName = path.basename(filePath);
    const key = getGroupKey(fileName);
    const group = grouped.get(key) ?? [];
    group.push({
      filePath,
      fileName,
      side: getSideFromFileName(fileName),
    });
    grouped.set(key, group);
  }

  const pairs = await Promise.all(
    Array.from(grouped.values()).map(async (items) => {
      const frontCandidate =
        items.find((item) => item.side === "a") ?? items[0];
      const backCandidate = items.find((item) => item.side === "b") ?? null;
      const frontStats = await fs.stat(frontCandidate.filePath);

      return {
        id: `${getGroupKey(frontCandidate.fileName)}-${frontCandidate.fileName}`,
        imageLabel: frontCandidate.fileName,
        frontPath: frontCandidate.filePath,
        backPath: backCandidate ? backCandidate.filePath : null,
        createdAt:
          frontStats.birthtimeMs || frontStats.ctimeMs || frontStats.mtimeMs,
        dateTaken: shouldReadDateTaken
          ? await readDateTakenTimestamp(
              frontCandidate.filePath,
              backCandidate?.filePath,
            )
          : null,
      };
    }),
  );

  return sortPairs(pairs, sortBy);
};

/**
 * Builds an XMP metadata XML document with embedded date, description, and tags.
 * Creates properly formatted XMP blocks for each metadata type when provided.
 * @param {{dateValue: string, description: string, tags: string[]}} options - The metadata options.
 * @returns {string} A complete XMP metadata XML document ready to be written to a sidecar file.
 */
const buildSidecarDocument = ({ dateValue, description, tags }) => {
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
 * Reads image metadata (date, description, tags, rotation) from a sidecar file.
 * Falls back to EXIF tool if date is missing from XMP, returning empty metadata if not found.
 * @param {string} filePath - The path to the image file whose sidecar metadata is being read.
 * @returns {Promise<Object>} An object with date, description, tags, and rotation (default: 0).
 */
const readSidecarMetadata = async (filePath) => {
  const sidecarPath = await resolveExistingSidecarPath(filePath);
  if (!sidecarPath) {
    return {
      date: "",
      description: "",
      tags: [],
      rotation: 0,
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

    let date = getTagValue(...sidecarDatePatterns) || "";

    if (!date) {
      const tags = await exiftool.read(filePath);
      const dateTaken =
        tags["EXIF:DateTimeOriginal"] || tags["EXIF:CreateDate"];
      date = dateTaken || "";
    }

    const description = getTagValue(
      /<rdf:li[^>]*xml:lang="x-default"[^>]*>([\s\S]*?)<\/rdf:li>/i,
      /<dc:description[^>]*>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>[\s\S]*?<\/dc:description>/i,
    );

    return {
      date: date ? date.slice(0, 10) : "",
      description,
      tags: readTagsFromXmp(rawXml),
      rotation: 0,
    };
  } catch {
    return {
      date: "",
      description: "",
      tags: [],
      rotation: 0,
    };
  }
};

/**
 * Writes image metadata (date, description, tags) to a sidecar file and embeds the date in image files.
 * Creates or updates an XMP sidecar file and writes the normalized date to both images.
 * @param {string} filePath - The path to the image file whose sidecar is being written.
 * @param {string} dateValue - The date value to normalize and store.
 * @param {string} description - The description text to store (can be empty).
 * @param {string[]} [tags=[]] - An optional array of tag strings.
 */
const writeSidecarFile = async (filePath, dateValue, description, tags) => {
  const sidecarPath =
    (await resolveExistingSidecarPath(filePath)) ?? buildSidecarPath(filePath);
  const xml = buildSidecarDocument({
    dateValue,
    description,
    tags,
  });

  await fs.writeFile(sidecarPath, xml, "utf8");
};

/**
 * Reads tag suggestions from all .xmp sidecar files in the directory.
 * Collects tags from recently modified sidecars and returns deduplicated list.
 * @param {string} directoryPath - The path to the directory containing images and sidecars.
 * @returns {Promise<string[]>} An array of unique tag strings found in sidecar files.
 */
const readRecentTags = async (directoryPath) => {
  const directoryEntries = await fs.readdir(directoryPath, {
    withFileTypes: true,
  });
  const sidecarPaths = directoryEntries
    .filter(
      (entry) =>
        entry.isFile() && path.extname(entry.name).toLowerCase() === ".xmp",
    )
    .map((entry) => path.join(directoryPath, entry.name));
  const sidecarsByRecency = await Promise.all(
    sidecarPaths.map(async (sidecarPath) => ({
      sidecarPath,
      modifiedAt: (await fs.stat(sidecarPath)).mtimeMs,
    })),
  );
  sidecarsByRecency.sort((left, right) => right.modifiedAt - left.modifiedAt);

  const recentTags = [];
  for (const { sidecarPath } of sidecarsByRecency) {
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
 * Writes a normalized date value as embedded EXIF metadata into an image file.
 * Validates the file extension and ensures ExifTool successfully updates the created date field.
 * @param {string} filePath - The path to the image file whose metadata is being updated.
 * @param {string} dateValue - The date value to embed in EXIF fields.
 * @throws {Error} If the file type doesn't support embedded metadata or ExifTool fails to update the field.
 */
const writeEmbeddedImageDate = async (filePath, dateValue) => {
  const extension = path.extname(filePath).toLowerCase();
  if (!allowedExtensions.has(extension)) {
    throw new Error(
      `Embedded metadata is not supported for ${extension || "this file type"}.`,
    );
  }

  const exifDate = normalizeExifDate(dateValue);
  const result = await exiftool.write(
    filePath,
    {
      "EXIF:CreateDate": exifDate,
      "EXIF:DateTimeOriginal": exifDate,
      SubSecTimeOriginal: 0,
    },
    { writeArgs: ["-overwrite_original"] },
  );

  if (result.updated !== 1 && result.unchanged !== 1) {
    throw new Error(
      `ExifTool did not update the created date for ${path.basename(filePath)}.`,
    );
  }
};

/**
 * Rotates an image by updating its EXIF Orientation metadata.
 * Uses ExifTool to modify the Orientation field without changing image pixels.
 * @param {string} filePath - The path to the image file whose orientation is being updated.
 * @param {number} rotation - The rotation angle in degrees.
 * @throws {Error} If ExifTool fails to update the orientation field.
 */
const rotateImageMetadata = async (filePath, rotation) => {
  const tags = await exiftool.read(filePath);
  const orientation = composeExifOrientation(tags.Orientation, rotation);
  const result = await exiftool.write(
    filePath,
    { "Orientation#": orientation },
    { writeArgs: ["-overwrite_original"] },
  );

  if (result.updated !== 1 && result.unchanged !== 1) {
    throw new Error(
      `ExifTool did not update the orientation for ${path.basename(filePath)}.`,
    );
  }
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
 * Tracks the revision number for changed files and increments it after successful rotation.
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
    await rotateImageMetadata(filePath, normalizedRotation);
  } else if (pixelRotationExtensions.has(extension)) {
    await rotateImagePixels(filePath, normalizedRotation);
  } else {
    throw new Error(
      `Rotation is not supported for ${extension || "this file type"}.`,
    );
  }

  imageRevisionByPath.set(
    filePath,
    (imageRevisionByPath.get(filePath) ?? 0) + 1,
  );
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
        return { field, filePath, ok: true };
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
 * @returns {{date: string, description: string, tags: string[], rotation: number}} An object with empty date/description and empty tags array.
 */
const emptySidecarMetadata = () => ({
  date: "",
  description: "",
  tags: [],
  rotation: 0,
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
 */
const saveImmichSettings = async (settingsDirectory, secretCodec, settings) => {
  const normalizedSettings = normalizeImmichSettings(settings);
  const storedSettings = {
    ...normalizedSettings,
    userApiKey: normalizedSettings.userApiKey
      ? secretCodec.encrypt(normalizedSettings.userApiKey)
      : "",
    adminApiKey: normalizedSettings.adminApiKey
      ? secretCodec.encrypt(normalizedSettings.adminApiKey)
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
 * Reads all image files from a directory and groups them into pairs.
 * Returns file listings with pairing information, creation dates, and date-taken if sorting by date.
 * Also collects tag suggestions from existing sidecar metadata files.
 * @param {string} directoryPath - The path to the directory containing image files.
 * @param {*} [sortBy=defaultSortBy] - The sort field and direction for ordering results (default: createdAt-asc).
 * @returns {Promise<{directoryPath: string, files: Array, recentTags: string[]}>} An object with directory path, array of paired images, and tag suggestions.
 */
const readDirectory = async (directoryPath, sortBy = defaultSortBy) => {
  if (!directoryPath) {
    return { directoryPath, files: [], recentTags: [] };
  }

  const directoryEntries = await fs.readdir(directoryPath, {
    withFileTypes: true,
  });
  const imageFiles = directoryEntries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.join(directoryPath, entry.name))
    .filter((filePath) =>
      allowedExtensions.has(path.extname(filePath).toLowerCase()),
    );

  return {
    directoryPath,
    files: await pairFiles(imageFiles, sortBy),
    recentTags: await readRecentTags(directoryPath),
  };
};

/**
 * Updates image metadata with provided date, description, and tags.
 * Writes sidecar files for the front image (and back if provided) and embeds the date in EXIF.
 * Runs through the serial queue to prevent concurrent file operations.
 * @param {{frontPath: string, backPath: string|null, date: string, description: string, tags: string[]}} metadata - The metadata update request containing paths and values.
 * @returns {Promise<{ok: boolean, updatedFiles: number, sidecarFile: string}>} Success result with count of updated files and path to the sidecar file created.
 */
/**
 * Updates image metadata with provided date, description, and tags.
 * Writes sidecar files for the front image (and back if provided) and embeds the date in EXIF.
 * Runs through the serial queue to prevent concurrent file operations.
 * @param {{frontPath: string, backPath: string|null, date: string, description: string, tags: string[]}} metadata - The metadata update request containing paths and values.
 * @returns {Promise<{ok: boolean, updatedFiles: number, sidecarFile: string}>} Success result with count of updated files and path to the sidecar file created.
 */
const saveMetadata = (metadata) =>
  runImageFileOperation(async () => {
    if (!metadata?.frontPath) {
      throw new Error("No image selected for metadata update.");
    }

    const dateValue = normalizeDateValue(metadata.date);

    await writeSidecarFile(
      metadata.frontPath,
      dateValue,
      metadata.description,
      metadata.tags,
    );

    const imagePaths = [metadata.frontPath, metadata.backPath].filter(Boolean);
    await Promise.all(
      imagePaths.map((filePath) => writeEmbeddedImageDate(filePath, dateValue)),
    );

    return {
      ok: true,
      updatedFiles: imagePaths.length,
      sidecarFile:
        (await resolveExistingSidecarPath(metadata.frontPath)) ??
        buildSidecarPath(metadata.frontPath),
    };
  });

/**
 * Reads metadata from an image's sidecar file or returns empty defaults if not found.
 * @param {string} [filePath] - The path to the image file (optional).
 * @returns {Promise<Object>} An object containing date, description, tags array, and rotation value.
 */
/**
 * Reads metadata from an image's sidecar file or returns empty defaults if not found.
 * @param {string} [filePath] - The path to the image file (optional).
 * @returns {Promise<Object>} An object containing date, description, tags array, and rotation value.
 */
const readSidecarMetadataForFile = async (filePath) => {
  if (!filePath) {
    return emptySidecarMetadata();
  }

  return readSidecarMetadata(filePath);
};

/**
 * Retrieves the current revision number for an image file from the revision map.
 * The revision count tracks how many times an image has been modified or rotated.
 * @param {string} filePath - The path to the image file.
 * @returns {number} The revision number (0 if no prior modifications have been recorded).
 */
/**
 * Retrieves the current revision number for an image file from the revision map.
 * The revision count tracks how many times an image has been modified or rotated.
 * @param {string} filePath - The path to the image file.
 * @returns {number} The revision number (0 if no prior modifications have been recorded).
 */
const getImageRevision = (filePath) => imageRevisionByPath.get(filePath) ?? 0;

// Browsers cannot display TIFF and un-rotated previews can be served as-is.
/**
 * Checks whether an image needs to be rendered as a PNG preview in the browser.
 * TIFF images always need rendering since browsers cannot display them natively.
 * Images with non-zero rotation also need rendering for proper orientation.
 * @param {string} filePath - The path to the image file.
 * @param {number} [rotation=0] - The current rotation angle in degrees.
 * @returns {boolean} True if the image needs a rendered PNG preview, false otherwise.
 */
const needsRenderedPreview = (filePath, rotation = 0) => {
  const extension = path.extname(filePath).toLowerCase();
  return (
    normalizeRotationValue(rotation) !== 0 ||
    [".tif", ".tiff"].includes(extension)
  );
};

/**
 * Renders an image file as a PNG buffer with optional rotation applied.
 * First applies EXIF auto-orientation, then rotates if needed, and converts to PNG format.
 * @param {string} filePath - The path to the source image file.
 * @param {number} [rotation=0] - The rotation angle in degrees to apply after auto-orientation.
 * @returns {Promise<Buffer>} A Promise resolving to a PNG image buffer.
 */
const renderPreviewPng = async (filePath, rotation = 0) => {
  const normalizedRotation = normalizeRotationValue(rotation);
  let image = sharp(filePath).autoOrient();
  if (normalizedRotation) {
    image = image.rotate(normalizedRotation);
  }
  return image.webp({ preset: "photo", quality: 50 }).toBuffer();
};

/**
 * Queues an image rotation request to run through the serial file operation queue.
 * Ensures rotations are processed sequentially to avoid concurrent file conflicts.
 * @param {{frontPath: string|null, frontRotation: number|null, backPath: string|null, backRotation: number|null}} request - The rotation request with file paths and angles.
 * @returns {Promise<{ok: boolean, updatedFiles: number, results: Array}>>} The result of applying rotations to both images (if present).
 */
const applyImageRotationsQueued = (request) =>
  runImageFileOperation(() => applyImageRotations(request));

/**
 * Gracefully shuts down ExifTool to release file handles and system resources.
 * Should be called when the application is closing to ensure clean shutdown.
 */
const shutdownCore = () => exiftool.end();

export {
  allowedExtensions,
  applyImageRotationsQueued as applyImageRotations,
  defaultSortBy,
  getImageRevision,
  loadImmichSettings,
  needsRenderedPreview,
  normalizeRotationValue,
  normalizeSortBy,
  readDirectory,
  readSidecarMetadataForFile as readSidecarMetadata,
  renderPreviewPng,
  runImageFileOperation,
  runImmichUpload,
  saveImmichSettings,
  saveMetadata,
  shutdownCore,
};
