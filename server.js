import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  allowedExtensions,
  applyImageRotations,
  defaultSortBy,
  getImageRevision,
  loadImmichSettings,
  needsRenderedPreview,
  normalizeSortBy,
  readDirectory,
  readSidecarMetadata,
  renderPreviewPng,
  runImageFileOperation,
  runImmichUpload,
  saveImmichSettings,
  saveMetadata,
  shutdownCore,
} from "./core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDirectory = path.join(__dirname, "dist");
const port = Number(process.env.PORT) || 8080;
const host = process.env.HOST || "0.0.0.0";
const configuredRoot = path.resolve(process.env.IMAGEPARSER_ROOT || "/data");
const configDirectory = path.resolve(
  process.env.IMAGEPARSER_CONFIG_DIR || "/config",
);
const authUsername = process.env.IMAGEPARSER_USERNAME || "";
const authPassword = process.env.IMAGEPARSER_PASSWORD || "";
const maxRequestBodyBytes = 1_000_000;
const secretKeyFileName = "secret.key";
const encryptedValuePrefix = "v1:";

const contentTypeByExtension = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".woff2": "font/woff2",
});

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

let rootDirectory = configuredRoot;

/**
 * Checks if a path is within the root directory.
 * @param {string} candidatePath - The path to check.
 * @returns {boolean} True if the path is inside the root directory.
 */
const isInsideRoot = (candidatePath) =>
  candidatePath === rootDirectory ||
  candidatePath.startsWith(rootDirectory + path.sep);

// Resolves symlinks so a link inside the share cannot be used to escape it.
/**
 * Resolves a requested path within the root directory, handling symlinks.
 * @param {string} requestedPath - The requested path to resolve.
 * @returns {Promise<string>} The resolved absolute path within root.
 * @throws {HttpError} 400 if no path provided, 404 if not found, 403 if outside root.
 */
const resolvePathInRoot = async (requestedPath) => {
  const rawPath = String(requestedPath ?? "").trim();
  if (!rawPath) {
    throw new HttpError(400, "A path is required.");
  }

  const absolutePath = path.resolve(rootDirectory, rawPath);
  let realPath;
  try {
    realPath = await fs.realpath(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new HttpError(404, "The requested path does not exist.");
    }
    throw error;
  }

  if (!isInsideRoot(realPath)) {
    throw new HttpError(
      403,
      "The requested path is outside the shared directory.",
    );
  }

  return realPath;
};

/**
 * Resolves an optional requested path within the root directory.
 * @param {string} requestedPath - The requested path to resolve (optional).
 * @returns {Promise<string|null>} The resolved absolute path or null if not provided.
 */
const resolveOptionalPathInRoot = async (requestedPath) =>
  requestedPath ? resolvePathInRoot(requestedPath) : null;

/**
 * Loads the secret key for AES-GCM encryption, from environment or generating a new one.
 * @returns {Promise<Buffer>} The 32-byte secret key as a Buffer.
 */
const loadSecretKey = async () => {
  if (process.env.IMAGEPARSER_SECRET_KEY) {
    const key = Buffer.from(process.env.IMAGEPARSER_SECRET_KEY, "base64");
    if (key.length !== 32) {
      throw new Error(
        "IMAGEPARSER_SECRET_KEY must be 32 bytes encoded as base64.",
      );
    }
    return key;
  }

  const keyPath = path.join(configDirectory, secretKeyFileName);
  try {
    return Buffer.from((await fs.readFile(keyPath, "utf8")).trim(), "base64");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const key = randomBytes(32);
  await fs.mkdir(configDirectory, { recursive: true });
  await fs.writeFile(keyPath, key.toString("base64"), {
    encoding: "utf8",
    mode: 0o600,
  });
  return key;
};

/**
 * Creates an AES-GCM codec for encrypting and decrypting sensitive data.
 * @param {Buffer} key - The 32-byte secret key.
 * @returns {Object} Object with encrypt and decrypt methods.
 */
const createAesGcmCodec = (key) =>
  Object.freeze({
    /**
     * Encrypts a value using AES-256-GCM.
     * @param {string} value - The plaintext value to encrypt.
     * @returns {string} The encrypted value as a base64 string with prefix.
     */
    encrypt: (value) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ]);
      return (
        encryptedValuePrefix +
        Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64")
      );
    },
    decrypt: (value) => {
      try {
        if (!value.startsWith(encryptedValuePrefix)) {
          throw new Error("Unsupported format.");
        }
        const payload = Buffer.from(
          value.slice(encryptedValuePrefix.length),
          "base64",
        );
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          payload.subarray(0, 12),
        );
        decipher.setAuthTag(payload.subarray(12, 28));
        return Buffer.concat([
          decipher.update(payload.subarray(28)),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new Error(
          "The saved Immich API keys could not be decrypted. Enter them again.",
        );
      }
    },
  });

/**
 * Compares two strings using timing-safe comparison to prevent timing attacks.
 * @param {string} left - The first string to compare.
 * @param {string} right - The second string to compare.
 * @returns {boolean} True if the strings are equal.
 */
const safeEqual = (left, right) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
};

/**
 * Checks if an HTTP request is authorized using basic authentication.
 * @param {IncomingMessage} request - The HTTP request object.
 * @returns {boolean} True if authenticated or auth is disabled.
 */
const isAuthorized = (request) => {
  if (!authPassword) {
    return true;
  }

  const header = request.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) {
    return false;
  }

  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex < 0) {
    return false;
  }

  const username = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);
  return safeEqual(username, authUsername) && safeEqual(password, authPassword);
};

/**
 * Sends a JSON response with the given status code and payload.
 * @param {ServerResponse} response - The HTTP response object.
 * @param {number} statusCode - The HTTP status code.
 * @param {Object} payload - The JSON payload to send.
 */
const sendJson = (response, statusCode, payload) => {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
};

/**
 * Reads and parses the JSON body from an HTTP request.
 * @param {IncomingMessage} request - The HTTP request object.
 * @returns {Promise<Object>} The parsed JSON object.
 * @throws {HttpError} 415 if not JSON, 413 if too large, 400 if invalid JSON.
 */
const readJsonBody = async (request) => {
  if (
    !String(request.headers["content-type"] ?? "").startsWith(
      "application/json",
    )
  ) {
    throw new HttpError(415, "Requests must use application/json.");
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maxRequestBodyBytes) {
      throw new HttpError(413, "The request body is too large.");
    }
    chunks.push(chunk);
  }

  try {
    return chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
      : {};
  } catch {
    throw new HttpError(400, "The request body is not valid JSON.");
  }
};

/**
 * Builds an image URL with rotation and revision parameters.
 * @param {string} filePath - The path to the image file.
 * @param {number} rotation - The rotation value (0-360).
 * @returns {string} The constructed image URL.
 */
const buildImageUrl = (filePath, rotation) => {
  const params = new URLSearchParams({
    path: filePath,
    rotation: String(Number(rotation) || 0),
    rev: String(getImageRevision(filePath)),
  });
  return `api/image?${params.toString()}`;
};

const progressClients = new Set();

/**
 * Broadcasts a progress message to all connected clients.
 * @param {Object} progress - The progress data to broadcast.
 */
const broadcastProgress = (progress) => {
  const message = `data: ${JSON.stringify(progress)}\n\n`;
  for (const client of progressClients) {
    client.write(message);
  }
};

/**
 * Handles an SSE progress stream connection.
 * @param {IncomingMessage} request - The HTTP request object.
 * @param {ServerResponse} response - The HTTP response object.
 */
const handleProgressStream = (request, response) => {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write(": connected\n\n");
  progressClients.add(response);
  const keepAlive = setInterval(() => response.write(": ping\n\n"), 25_000);
  request.on("close", () => {
    clearInterval(keepAlive);
    progressClients.delete(response);
  });
};

/**
 * Handles a directory browse request and returns directory metadata.
 * @param {URL} url - The parsed URL object containing query parameters.
 * @returns {Promise<Object>} Object with path, rootPath, parent, directories, and imageCount.
 * @throws {HttpError} 400 if the path is not a directory.
 */
const handleBrowse = async (url) => {
  const directoryPath = await resolvePathInRoot(
    url.searchParams.get("path") || rootDirectory,
  );
  const stats = await fs.stat(directoryPath);
  if (!stats.isDirectory()) {
    throw new HttpError(400, "The requested path is not a directory.");
  }

  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({
      name: entry.name,
      path: path.join(directoryPath, entry.name),
    }))
    .sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { numeric: true }),
    );
  const imageCount = entries.filter(
    (entry) =>
      entry.isFile() &&
      allowedExtensions.has(path.extname(entry.name).toLowerCase()),
  ).length;

  return {
    path: directoryPath,
    rootPath: rootDirectory,
    parent:
      directoryPath === rootDirectory ? null : path.dirname(directoryPath),
    directories,
    imageCount,
  };
};

/**
 * Handles an image request, returning the raw file or a rendered preview.
 * @param {ClientRequest} request - The HTTP request object.
 * @param {ServerResponse} response - The HTTP response object.
 * @param {URL} url - The parsed URL object containing query parameters.
 * @returns {Promise<void>}
 * @throws {HttpError} 400 if unsupported image type.
 */
const handleImage = async (request, response, url) => {
  const filePath = await resolvePathInRoot(url.searchParams.get("path"));
  const extension = path.extname(filePath).toLowerCase();
  if (!allowedExtensions.has(extension)) {
    throw new HttpError(400, "Unsupported image type.");
  }

  const rotation = Number(url.searchParams.get("rotation")) || 0;
  const stats = await fs.stat(filePath);
  const etag = `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}-${rotation}"`;
  const cacheHeaders = { ETag: etag, "Cache-Control": "private, no-cache" };

  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, cacheHeaders);
    response.end();
    return;
  }

  if (needsRenderedPreview(filePath, rotation)) {
    const pngBuffer = await runImageFileOperation(() =>
      renderPreviewPng(filePath, rotation),
    );
    response.writeHead(200, {
      ...cacheHeaders,
      "Content-Type": "image/webp",
      "Content-Length": pngBuffer.length,
    });
    response.end(pngBuffer);
    return;
  }

  response.writeHead(200, {
    ...cacheHeaders,
    "Content-Type":
      contentTypeByExtension[extension] ?? "application/octet-stream",
    "Content-Length": stats.size,
  });
  fsSync.createReadStream(filePath).pipe(response);
};

/**
 * Validates and resolves metadata paths within the root directory.
 * @param {Object} payload - Object with frontPath and backPath properties.
 * @returns {Promise<Object>} The payload with resolved paths.
 */
const validateMetadataPaths = async (payload) => ({
  ...payload,
  frontPath: await resolvePathInRoot(payload?.frontPath),
  backPath: await resolveOptionalPathInRoot(payload?.backPath),
});

/**
 * Creates an API routes object with handlers for all endpoints.
 * @param {Object} secretCodec - Object with encrypt and decrypt methods.
 * @returns {Object} Object mapping route strings to async handler functions.
 */
const createApiRoutes = (secretCodec) => ({
  "GET /api/config": async () => ({ rootPath: rootDirectory }),
  "GET /api/browse": async (_request, url) => handleBrowse(url),
  "POST /api/read-directory": async (request) => {
    const body = await readJsonBody(request);
    const directoryPath = await resolvePathInRoot(body.directoryPath);
    const { field, direction } = normalizeSortBy(body.sortBy ?? defaultSortBy);
    return readDirectory(directoryPath, `${field}-${direction}`);
  },
  "POST /api/read-sidecar-metadata": async (request) => {
    const body = await readJsonBody(request);
    return readSidecarMetadata(await resolvePathInRoot(body.filePath));
  },
  "POST /api/save-metadata": async (request) =>
    saveMetadata(await validateMetadataPaths(await readJsonBody(request))),
  "POST /api/preview-url": async (request) => {
    const body = await readJsonBody(request);
    return {
      url: buildImageUrl(await resolvePathInRoot(body.filePath), body.rotation),
    };
  },
  "POST /api/apply-image-rotations": async (request) =>
    applyImageRotations(
      await validateMetadataPaths(await readJsonBody(request)),
    ),
  "GET /api/immich-settings": async () =>
    loadImmichSettings(configDirectory, secretCodec),
  "POST /api/immich-settings": async (request) =>
    saveImmichSettings(
      configDirectory,
      secretCodec,
      await readJsonBody(request),
    ),
  "POST /api/upload-to-immich": async (request) => {
    const body = await readJsonBody(request);
    const directoryPath = await resolvePathInRoot(body.directoryPath);
    return runImmichUpload(body.settings, directoryPath, broadcastProgress);
  },
});

/**
 * Serves static files from the dist directory.
 * @param {ServerResponse} response - The HTTP response object.
 * @param {string} pathname - The requested URL pathname.
 */
const serveStatic = async (response, pathname) => {
  const relativePath =
    decodeURIComponent(pathname).replace(/^\/+/, "") || "index.html";
  let filePath = path.resolve(distDirectory, relativePath);
  if (
    filePath !== distDirectory &&
    !filePath.startsWith(distDirectory + path.sep)
  ) {
    throw new HttpError(403, "Forbidden.");
  }

  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      filePath = path.join(distDirectory, "index.html");
    }
  } catch {
    filePath = path.join(distDirectory, "index.html");
  }

  const content = await fs.readFile(filePath);
  const isHashedAsset = filePath.includes(`${path.sep}assets${path.sep}`);
  response.writeHead(200, {
    "Content-Type":
      contentTypeByExtension[path.extname(filePath).toLowerCase()] ??
      "application/octet-stream",
    "Content-Length": content.length,
    "Cache-Control": isHashedAsset
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(content);
};

/**
 * Creates an HTTP request handler with authentication, routing, and error handling.
 * @param {Object} secretCodec - Object with encrypt and decrypt methods.
 * @returns {Function} An async function that handles HTTP requests and responses.
 */
const createRequestHandler = (secretCodec) => {
  const apiRoutes = createApiRoutes(secretCodec);

  return async (request, response) => {
    try {
      if (!isAuthorized(request)) {
        response.writeHead(401, {
          "WWW-Authenticate": 'Basic realm="Image Parser", charset="UTF-8"',
        });
        response.end("Authentication required.");
        return;
      }

      const url = new URL(request.url ?? "/", "http://localhost");

      if (url.pathname === "/healthz") {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/immich-progress") {
        handleProgressStream(request, response);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/image") {
        await handleImage(request, response, url);
        return;
      }

      const route = apiRoutes[`${request.method} ${url.pathname}`];
      if (route) {
        sendJson(response, 200, await route(request, url));
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        throw new HttpError(404, "Unknown API endpoint.");
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        throw new HttpError(405, "Method not allowed.");
      }

      await serveStatic(response, url.pathname);
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      if (statusCode === 500) {
        console.error(error);
      }
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, statusCode, {
        error:
          error instanceof Error ? error.message : "Unexpected server error.",
      });
    }
  };
};

/**
 * Starts the Image Parser server on the configured port and host.
 */
const start = async () => {
  if (authPassword && !authUsername) {
    throw new Error(
      "IMAGEPARSER_USERNAME must be set when IMAGEPARSER_PASSWORD is set.",
    );
  }

  rootDirectory = await fs.realpath(configuredRoot);
  const secretCodec = createAesGcmCodec(await loadSecretKey());
  const server = http.createServer(createRequestHandler(secretCodec));

  /**
   * Shuts down the server and cleans up progress clients.
   */
  const shutdown = () => {
    server.close();
    for (const client of progressClients) {
      client.end();
    }
    void shutdownCore().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  server.listen(port, host, () => {
    console.log(
      `Image Parser listening on http://${host}:${port} (root: ${rootDirectory})`,
    );
    if (!authPassword) {
      console.log(
        "Authentication is disabled. Set IMAGEPARSER_USERNAME and IMAGEPARSER_PASSWORD to enable it.",
      );
    }
  });
};

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
