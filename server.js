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
  buildUserContext,
  createOidcClient,
  createSealedCodec,
  deriveKey,
  getCookieNames,
  parseCookies,
  serializeCookie,
} from "./auth.js";
import {
  allowedExtensions,
  applyImageRotations,
  configurePreviewCache,
  defaultSortBy,
  getImagePreview,
  getImageVersion,
  getImmichGoDiagnostics,
  getThumbnail,
  listDirectory,
  loadImmichSettings,
  normalizeRotationValue,
  normalizeSortBy,
  normalizeThumbnailSize,
  readDirectory,
  readFolderEntry,
  readSidecarMetadata,
  runImmichUpload,
  saveImmichSettings,
  saveMetadata,
  setDoNotUpload,
  setFolderDate,
  resetFolderMetadata,
  setPairsDate,
  setFolderProcessed,
  shutdownCore,
  whenImageFileOperationsIdle,
} from "./core.js";
import {
  applyManagedImmichSettings,
  getManagedImmichFields,
  listManagedFields,
  readManagedImmichConfig,
  toClientImmichSettings,
} from "./managedImmichSettings.js";
import {
  createAllowedRootsCache,
  isInsideDirectory,
  isPathAllowed,
} from "./pathAccess.js";
import {
  createLookupCache,
  fetchImmichAlbums,
  fetchImmichTags,
  ImmichLookupError,
} from "./immichLookup.js";
import { createServerLogger } from "./serverLogger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDirectory = path.join(__dirname, "dist");
const port = Number(process.env.PORT) || 8080;
const host = process.env.HOST || "0.0.0.0";
const configuredRoot = path.resolve(process.env.IMAGEPARSER_ROOT || "/data");
const configDirectory = path.resolve(
  process.env.IMAGEPARSER_CONFIG_DIR || "/config",
);
// Previews are cached under the config directory, never inside the photo root.
const previewCacheDirectory = path.join(configDirectory, "preview-cache");
const previewCacheMaxBytes =
  (Number(process.env.IMAGEPARSER_PREVIEW_CACHE_MB) || 1024) * 1024 * 1024;
const authUsername = process.env.IMAGEPARSER_USERNAME || "";
const authPassword = process.env.IMAGEPARSER_PASSWORD || "";
const debugEnabled = /^(1|true|yes|on)$/i.test(
  process.env.IMAGEPARSER_DEBUG ?? "",
);
const oidcIssuerUrl = process.env.OIDC_ISSUER_URL || "";
// Break-glass switch for an unavailable identity provider: skips OIDC sign-in and falls back to
// HTTP Basic auth when configured, otherwise to open access.
const oidcDisabled = /^(1|true|yes|on)$/i.test(process.env.OIDC_DISABLED ?? "");
const oidcEnabled = Boolean(oidcIssuerUrl) && !oidcDisabled;
const oidcClientId = process.env.OIDC_CLIENT_ID || "";
const oidcClientSecret = process.env.OIDC_CLIENT_SECRET || "";
const oidcRedirectUri = process.env.OIDC_REDIRECT_URI || "";
const oidcScopes =
  process.env.OIDC_SCOPES || "openid profile email imageparser";
const oidcAdminGroup = process.env.OIDC_ADMIN_GROUP || "imageparser-admin";
const oidcAdminClaim = process.env.OIDC_ADMIN_CLAIM || "imageparser_admin";
const oidcFoldersClaim =
  process.env.OIDC_FOLDERS_CLAIM || "imageparser_folders";
const oidcImmichApiKeyClaim =
  process.env.OIDC_IMMICH_API_KEY_CLAIM || "immich_api_key";
const oidcAllowInsecureRequests = /^(1|true|yes|on)$/i.test(
  process.env.OIDC_ALLOW_INSECURE_REQUESTS ?? "",
);
const sessionMaxAgeSeconds =
  Math.round((Number(process.env.OIDC_SESSION_HOURS) || 8) * 3600) || 3600;
const loginStateMaxAgeSeconds = 600;
const maxSessionCookieLength = 3800;
// The public URL decides cookie security: the container itself only speaks HTTP behind a TLS proxy.
const secureCookies = oidcRedirectUri.startsWith("https://");
const cookieNames = getCookieNames(secureCookies);
const logger = createServerLogger({ debug: debugEnabled });
logger.addSecret(authPassword);
logger.addSecret(oidcClientSecret);
const maxRequestBodyBytes = 1_000_000;
const secretKeyFileName = "secret.key";
const encryptedValuePrefix = "v1:";
const userKeyPattern = /^[0-9a-f]{64}$/;

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
 * The user for requests when OpenID Connect is disabled: full access to the shared root and the
 * global Immich settings, exactly as before per-user access existed.
 */
const localUser = Object.freeze({
  userKey: "",
  username: authUsername,
  isAdmin: true,
  folders: [],
});

/**
 * Resolves folder grants, caching the canonical folders for 30 seconds per set of grants.
 * Requested paths are still resolved on every request, so the cache cannot widen access.
 */
const resolveAllowedRootsCached = createAllowedRootsCache();

/**
 * Returns the canonical folders a user may access, including their children.
 * @param {{isAdmin: boolean, folders: string[]}} user - The request's user context.
 * @returns {Promise<string[]>} The canonical allowed folders.
 */
const getAllowedRoots = async (user) =>
  user.isAdmin
    ? [rootDirectory]
    : resolveAllowedRootsCached(rootDirectory, user.folders);

// Resolves symlinks so a link inside the share cannot be used to escape it.
/**
 * Resolves a requested path for a user, handling symlinks and per-user folder grants.
 * @param {{isAdmin: boolean, folders: string[]}} user - The request's user context.
 * @param {string} requestedPath - The requested path to resolve.
 * @returns {Promise<string>} The resolved absolute path within the user's allowed folders.
 * @throws {HttpError} 400 if no path provided, 404 if not found, 403 if outside the allowed folders.
 */
const resolvePathForUser = async (user, requestedPath) => {
  const rawPath = String(requestedPath ?? "").trim();
  if (!rawPath) {
    throw new HttpError(400, "A path is required.");
  }

  const allowedRoots = await getAllowedRoots(user);
  const absolutePath = path.resolve(rootDirectory, rawPath);
  const forbidden = new HttpError(
    403,
    user.isAdmin
      ? "The requested path is outside the shared directory."
      : "The requested path is outside your shared folders.",
  );
  let realPath;
  try {
    realPath = await fs.realpath(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      // Report missing paths as forbidden outside the user's folders, so their existence is not revealed.
      throw isPathAllowed(absolutePath, allowedRoots)
        ? new HttpError(404, "The requested path does not exist.")
        : forbidden;
    }
    throw error;
  }

  if (!isPathAllowed(realPath, allowedRoots)) {
    throw forbidden;
  }

  return realPath;
};

/**
 * Resolves an optional requested path for a user.
 * @param {{isAdmin: boolean, folders: string[]}} user - The request's user context.
 * @param {string} requestedPath - The requested path to resolve (optional).
 * @returns {Promise<string|null>} The resolved absolute path or null if not provided.
 */
const resolveOptionalPathForUser = async (user, requestedPath) =>
  requestedPath ? resolvePathForUser(user, requestedPath) : null;

/**
 * Builds the options for a directory scan, confining nested folders to the user's allowed folders by real path.
 * @param {{isAdmin: boolean, folders: string[]}} user - The request's user context.
 * @param {unknown} recursive - The request's recursive flag; only true includes nested folders.
 * @returns {Promise<{recursive: boolean, isAllowedPath: (realPath: string) => boolean}>} The scan options.
 */
const getScanOptionsForUser = async (user, recursive) => {
  const allowedRoots = await getAllowedRoots(user);
  return {
    recursive: recursive === true,
    isAllowedPath: (realPath) => isPathAllowed(realPath, allowedRoots),
  };
};

/**
 * Returns the directory holding a user's Immich settings.
 * OpenID Connect users each get a private directory keyed by a hash of their subject.
 * @param {{userKey: string}} user - The request's user context.
 * @param {{create?: boolean}} [options] - Set create to make the directory (mode 0700) if missing.
 * @returns {Promise<string>} The settings directory.
 */
const getUserSettingsDirectory = async (user, { create = false } = {}) => {
  if (!user.userKey) {
    return configDirectory;
  }
  if (!userKeyPattern.test(user.userKey)) {
    throw new HttpError(400, "The session user is invalid. Sign in again.");
  }

  const directory = path.join(configDirectory, "users", user.userKey);
  if (create) {
    await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }
  return directory;
};

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
 * Identifies the user making a request.
 * @param {IncomingMessage} request - The HTTP request object.
 * @param {{open: Function}|null} sessionCodec - Opens session cookies when OpenID Connect is enabled.
 * @returns {Object|null} The user context, or null when the request is not authenticated.
 */
const authenticateRequest = (request, sessionCodec) => {
  if (!oidcEnabled) {
    return isAuthorized(request) ? localUser : null;
  }

  const session = sessionCodec.open(
    parseCookies(request.headers.cookie).get(cookieNames.session),
  );
  // The session restores the user's Immich key after a restart, so it is registered for redaction here.
  logger.addSecret(session?.user?.immichApiKey);
  return session?.user ?? null;
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
 * Sends a redirect that is never cached.
 * @param {ServerResponse} response - The HTTP response object.
 * @param {string} location - The redirect target.
 * @param {string[]} [cookies] - Set-Cookie header values to send with the redirect.
 */
const sendRedirect = (response, location, cookies = []) => {
  response.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store",
    ...(cookies.length ? { "Set-Cookie": cookies } : {}),
  });
  response.end();
};

/**
 * Escapes text for inclusion in HTML.
 * @param {string} value - The text to escape.
 * @returns {string} The escaped text.
 */
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );

/**
 * Sends a small HTML page explaining a sign-in failure, with a link to try again.
 * @param {ServerResponse} response - The HTTP response object.
 * @param {number} statusCode - The HTTP status code.
 * @param {string} message - The user-visible explanation.
 * @param {string[]} [cookies] - Set-Cookie header values to send with the page.
 */
const sendAuthError = (response, statusCode, message, cookies = []) => {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign-in failed - Image Parser</title></head><body><main><h1>Sign-in failed</h1><p role="alert">${escapeHtml(message)}</p><p><a href="login">Try again</a></p></main></body></html>`;
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...(cookies.length ? { "Set-Cookie": cookies } : {}),
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
 * Progress stream clients grouped by user key, so upload output only reaches its owner.
 * @type {Map<string, Set<ServerResponse>>}
 */
const progressClients = new Map();

/**
 * Creates a reporter that sends progress messages to one user's connected clients.
 * @param {string} userKey - The user's key ("" when OpenID Connect is disabled).
 * @returns {(progress: Object) => void} The progress reporter.
 */
const createProgressReporter = (userKey) => (progress) => {
  const message = `data: ${JSON.stringify(progress)}\n\n`;
  for (const client of progressClients.get(userKey) ?? []) {
    client.write(message);
  }
};

/**
 * Handles an SSE progress stream connection.
 * @param {IncomingMessage} request - The HTTP request object.
 * @param {ServerResponse} response - The HTTP response object.
 */
const handleProgressStream = (request, response) => {
  const { userKey } = request.user;
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write(": connected\n\n");
  const clients = progressClients.get(userKey) ?? new Set();
  clients.add(response);
  progressClients.set(userKey, clients);
  const keepAlive = setInterval(() => response.write(": ping\n\n"), 25_000);
  request.on("close", () => {
    clearInterval(keepAlive);
    clients.delete(response);
    if (!clients.size && progressClients.get(userKey) === clients) {
      progressClients.delete(userKey);
    }
  });
};

const debugLogClients = new Set();

/**
 * Paths excluded from request logging: health checks and long-lived streams.
 */
const unloggedPaths = new Set([
  "/healthz",
  "/api/immich-progress",
  "/api/debug-log",
]);

/**
 * Streams server log entries to the browser when debug mode is enabled.
 * Logs include every user's paths, so only administrators may read them.
 * @param {IncomingMessage} request - The HTTP request object.
 * @param {ServerResponse} response - The HTTP response object.
 * @throws {HttpError} 404 when debug mode is disabled, 403 for non-administrators.
 */
const handleDebugLogStream = (request, response) => {
  if (!debugEnabled) {
    throw new HttpError(404, "Unknown API endpoint.");
  }
  if (!request.user.isAdmin) {
    throw new HttpError(403, "Only administrators can read the server log.");
  }

  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write(": connected\n\n");
  debugLogClients.add(response);
  const unsubscribe = logger.subscribe((entry) => {
    response.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
  });
  const keepAlive = setInterval(() => response.write(": ping\n\n"), 25_000);
  request.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
    debugLogClients.delete(response);
  });
};

/**
 * Registers Immich API keys with the logger so they are redacted from all log output.
 * @param {{userApiKey?: string, adminApiKey?: string}} [settings] - Settings that may contain API keys.
 * @returns {Object|undefined} The same settings, for chaining.
 */
const registerImmichSecrets = (settings) => {
  logger.addSecret(settings?.userApiKey);
  logger.addSecret(settings?.adminApiKey);
  return settings;
};

/**
 * Logs runtime details that commonly differ between the desktop app and a container.
 */
const logStartupDiagnostics = async () => {
  const canAccess = (filePath, mode) =>
    fs.access(filePath, mode).then(
      () => true,
      () => false,
    );
  const immichGo = await getImmichGoDiagnostics();
  logger.info("Startup diagnostics.", {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    user:
      typeof process.getuid === "function"
        ? `${process.getuid()}:${process.getgid()}`
        : "n/a",
    rootDirectory,
    rootWritable: await canAccess(rootDirectory, fsSync.constants.W_OK),
    configDirectory,
    configWritable: await canAccess(configDirectory, fsSync.constants.W_OK),
    caCertificates:
      process.platform === "linux"
        ? await canAccess(
            "/etc/ssl/certs/ca-certificates.crt",
            fsSync.constants.R_OK,
          )
        : "n/a",
    immichGo,
  });
  if (!immichGo.ok) {
    logger.warn("immich-go is not runnable; Immich uploads will fail.");
  }
};

/**
 * Converts a canonical folder inside the root to a forward-slash path relative to it.
 * @param {string} folderPath - The canonical folder path.
 * @returns {string} The relative display name.
 */
const toRootRelativeName = (folderPath) =>
  path.relative(rootDirectory, folderPath).split(path.sep).join("/") ||
  path.basename(folderPath);

/**
 * Handles a directory browse request and returns directory metadata.
 * Non-administrators with several shared folders start at a virtual root listing only those folders.
 * @param {{isAdmin: boolean, folders: string[]}} user - The request's user context.
 * @param {URL} url - The parsed URL object containing query parameters.
 * @returns {Promise<Object>} Object with path, rootPath, parent, selectable, directories, imageCount, and
 *   the folder's processed state; each directory also carries its processed state and filesystem date.
 *   A parent of "" means the virtual root; null means there is nothing above.
 * @throws {HttpError} 400 if the path is not a directory.
 */
const handleBrowse = async (user, url) => {
  const allowedRoots = await getAllowedRoots(user);
  let requestedPath = url.searchParams.get("path");
  if (!requestedPath && !user.isAdmin) {
    if (allowedRoots.length !== 1) {
      return {
        path: "",
        rootPath: rootDirectory,
        parent: null,
        selectable: false,
        directories: (
          await Promise.all(
            allowedRoots.map((allowedRoot) =>
              readFolderEntry(toRootRelativeName(allowedRoot), allowedRoot),
            ),
          )
        ).sort((left, right) =>
          left.name.localeCompare(right.name, undefined, { numeric: true }),
        ),
        imageCount: 0,
        processed: false,
        processedAt: null,
        processedBy: null,
      };
    }
    requestedPath = allowedRoots[0];
  }

  const directoryPath = await resolvePathForUser(
    user,
    requestedPath || rootDirectory,
  );
  const stats = await fs.stat(directoryPath);
  if (!stats.isDirectory()) {
    throw new HttpError(400, "The requested path is not a directory.");
  }

  const listing = await listDirectory(directoryPath);

  let parent = path.dirname(directoryPath);
  if (allowedRoots.includes(directoryPath)) {
    parent = user.isAdmin || allowedRoots.length === 1 ? null : "";
  }

  return {
    path: directoryPath,
    rootPath: rootDirectory,
    parent,
    selectable: true,
    ...listing,
  };
};

/**
 * Sends a WebP grid thumbnail for an already-confined image path.
 * Like previews, the ETag follows the file's version and a request whose `v` matches the file
 * on disk may be cached indefinitely. A request whose client disconnects before rendering
 * starts is dropped without rendering.
 * @param {ClientRequest} request - The HTTP request object.
 * @param {ServerResponse} response - The HTTP response object.
 * @param {string} filePath - The resolved image path inside the user's folders.
 * @param {URL} url - The parsed URL; `thumb` holds the long-edge size in pixels.
 * @returns {Promise<void>}
 */
const sendThumbnail = async (request, response, filePath, url) => {
  const size = normalizeThumbnailSize(url.searchParams.get("thumb"));
  const version = await getImageVersion(filePath);
  const cacheHeaders = {
    ETag: `"thumb-${size}-${version}"`,
    "Cache-Control":
      url.searchParams.get("v") === version
        ? "private, max-age=31536000, immutable"
        : "private, no-cache",
  };

  if (request.headers["if-none-match"] === cacheHeaders.ETag) {
    response.writeHead(304, cacheHeaders);
    response.end();
    return;
  }

  const controller = new AbortController();
  const abortIfUnanswered = () => {
    if (!response.writableEnded) {
      controller.abort();
    }
  };
  response.once("close", abortIfUnanswered);
  let thumbnail;
  try {
    thumbnail = await getThumbnail(filePath, {
      size,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      return;
    }
    throw error;
  } finally {
    response.off("close", abortIfUnanswered);
  }

  response.writeHead(200, {
    ...cacheHeaders,
    "Content-Type": "image/webp",
    "Content-Length": thumbnail.length,
  });
  response.end(thumbnail);
};

/**
 * Handles an image request, returning a resized WebP preview of the file, or a grid
 * thumbnail when `thumb` is given.
 * The browser builds the URL with the file's version (`v`); a request whose version matches the
 * file on disk may be cached indefinitely, because any rewrite of the file changes its version.
 * @param {ClientRequest} request - The HTTP request object.
 * @param {ServerResponse} response - The HTTP response object.
 * @param {URL} url - The parsed URL object containing query parameters.
 * @returns {Promise<void>}
 * @throws {HttpError} 400 if unsupported image type.
 */
const handleImage = async (request, response, url) => {
  const filePath = await resolvePathForUser(
    request.user,
    url.searchParams.get("path"),
  );
  const extension = path.extname(filePath).toLowerCase();
  if (!allowedExtensions.has(extension)) {
    throw new HttpError(400, "Unsupported image type.");
  }

  if (url.searchParams.has("thumb")) {
    await sendThumbnail(request, response, filePath, url);
    return;
  }

  const rotation = normalizeRotationValue(url.searchParams.get("rotation"));
  const buildCacheHeaders = (version) => ({
    ETag: `"${version}-${rotation}"`,
    "Cache-Control":
      url.searchParams.get("v") === version
        ? "private, max-age=31536000, immutable"
        : "private, no-cache",
  });

  const currentVersion = await getImageVersion(filePath);
  const currentHeaders = buildCacheHeaders(currentVersion);
  if (request.headers["if-none-match"] === currentHeaders.ETag) {
    response.writeHead(304, currentHeaders);
    response.end();
    return;
  }

  const preview = await getImagePreview(filePath, rotation);
  response.writeHead(200, {
    ...buildCacheHeaders(preview.version),
    "Content-Type": preview.contentType,
    "Content-Length": preview.buffer.length,
  });
  response.end(preview.buffer);
};

/**
 * Validates and resolves metadata paths within the user's allowed folders.
 * @param {{isAdmin: boolean, folders: string[]}} user - The request's user context.
 * @param {Object} payload - Object with frontPath and backPath properties.
 * @returns {Promise<Object>} The payload with resolved paths.
 */
const validateMetadataPaths = async (user, payload) => ({
  ...payload,
  frontPath: await resolvePathForUser(user, payload?.frontPath),
  backPath: await resolveOptionalPathForUser(user, payload?.backPath),
});

const albumCache = createLookupCache();
const tagCache = createLookupCache();

/**
 * Runs an Immich lookup with the signed-in user's stored settings and managed values. Lookup failures become
 * an explicit 502, so the browser can fall back to free-text entry.
 * @param {Object} user - The request's user context.
 * @param {Object} secretCodec - Object with encrypt and decrypt methods.
 * @param {Object} immichConfig - Immich settings managed by the environment.
 * @param {(settings: Object) => Promise<any>} lookup - The lookup to run.
 * @returns {Promise<any>} The lookup result.
 */
const runImmichLookup = async (user, secretCodec, immichConfig, lookup) => {
  const settings = registerImmichSecrets(
    applyManagedImmichSettings(
      await loadImmichSettings(
        await getUserSettingsDirectory(user),
        secretCodec,
      ),
      immichConfig,
      user,
    ),
  );
  try {
    return await lookup(settings);
  } catch (error) {
    if (error instanceof ImmichLookupError) {
      throw new HttpError(502, error.message);
    }
    throw error;
  }
};

/**
 * Creates an API routes object with handlers for all endpoints.
 * Every handler reads the authenticated user from `request.user`.
 * @param {Object} secretCodec - Object with encrypt and decrypt methods.
 * @param {{serverUrl: string, adminApiKey: string}} immichConfig - Immich settings managed by the environment.
 * @returns {Object} Object mapping route strings to async handler functions.
 */
const createApiRoutes = (secretCodec, immichConfig) => ({
  "GET /api/config": async (request) => ({
    rootPath: rootDirectory,
    debug: debugEnabled && request.user.isAdmin,
  }),
  "GET /api/me": async (request) => ({
    username: request.user.username,
    isAdmin: request.user.isAdmin,
    authMode: oidcEnabled ? "oidc" : authPassword ? "basic" : "none",
  }),
  "GET /api/browse": async (request, url) => handleBrowse(request.user, url),
  "GET /api/immich-albums": async (request, url) => {
    const cacheKey = request.user.userKey || "default";
    if (url.searchParams.get("refresh") === "1") {
      albumCache.delete(cacheKey);
    }
    const cached = albumCache.get(cacheKey);
    if (cached) {
      return { albums: cached };
    }
    const albums = await runImmichLookup(
      request.user,
      secretCodec,
      immichConfig,
      fetchImmichAlbums,
    );
    albumCache.set(cacheKey, albums);
    return { albums };
  },
  "GET /api/immich-tags": async (request, url) => {
    const cacheKey = request.user.userKey || "default";
    if (url.searchParams.get("refresh") === "1") {
      tagCache.delete(cacheKey);
    }
    const cached = tagCache.get(cacheKey);
    if (cached) {
      return { tags: cached };
    }
    const tags = await runImmichLookup(
      request.user,
      secretCodec,
      immichConfig,
      fetchImmichTags,
    );
    tagCache.set(cacheKey, tags);
    return { tags };
  },
  "POST /api/read-directory": async (request) => {
    const body = await readJsonBody(request);
    const directoryPath = await resolvePathForUser(
      request.user,
      body.directoryPath,
    );
    const { field, direction } = normalizeSortBy(body.sortBy ?? defaultSortBy);
    return readDirectory(
      directoryPath,
      `${field}-${direction}`,
      await getScanOptionsForUser(request.user, body.recursive),
    );
  },
  "POST /api/read-sidecar-metadata": async (request) => {
    const body = await readJsonBody(request);
    return readSidecarMetadata(
      await resolvePathForUser(request.user, body.filePath),
    );
  },
  "POST /api/save-metadata": async (request) =>
    saveMetadata(
      await validateMetadataPaths(request.user, await readJsonBody(request)),
    ),
  "POST /api/set-pairs-date": async (request) => {
    const body = await readJsonBody(request);
    if (!Array.isArray(body.pairs)) {
      throw new Error("No images selected.");
    }
    // Every path is confined to the user's folders before anything is written.
    const pairs = await Promise.all(
      body.pairs.map((pair) => validateMetadataPaths(request.user, pair)),
    );
    return setPairsDate(
      pairs.map(({ frontPath, backPath }) => ({ frontPath, backPath })),
      body.date,
    );
  },
  "POST /api/apply-image-rotations": async (request) =>
    applyImageRotations(
      await validateMetadataPaths(request.user, await readJsonBody(request)),
    ),
  // Managed values (environment and sign-in session) are never sent to the browser or saved.
  "GET /api/immich-settings": async (request) =>
    toClientImmichSettings(
      registerImmichSecrets(
        await loadImmichSettings(
          await getUserSettingsDirectory(request.user),
          secretCodec,
        ),
      ),
      immichConfig,
      request.user,
    ),
  "POST /api/immich-settings": async (request) => {
    const body = registerImmichSecrets(await readJsonBody(request));
    const savedSettings = await saveImmichSettings(
      await getUserSettingsDirectory(request.user, { create: true }),
      secretCodec,
      applyManagedImmichSettings(body, immichConfig, request.user),
      {
        managedFields: listManagedFields(
          getManagedImmichFields(immichConfig, request.user),
        ),
      },
    );
    return toClientImmichSettings(savedSettings, immichConfig, request.user);
  },
  "POST /api/do-not-upload": async (request) => {
    // Both images are confined to the user's folders; core renames only within their folder.
    const body = await validateMetadataPaths(
      request.user,
      await readJsonBody(request),
    );
    return setDoNotUpload({
      frontPath: body.frontPath,
      backPath: body.backPath,
      value: body.value,
      relativeDirectory: body.relativeDirectory,
    });
  },
  "POST /api/folder-processed": async (request) => {
    const body = await readJsonBody(request);
    // Subfolders are walked without following symbolic links, so they stay inside the confined folder.
    const directoryPath = await resolvePathForUser(request.user, body.path);
    return setFolderProcessed(directoryPath, body.value, {
      actor: request.user.username || null,
      includeSubfolders: body.includeSubfolders === true,
    });
  },
  "POST /api/set-folder-date": async (request) => {
    const body = await readJsonBody(request);
    const directoryPath = await resolvePathForUser(
      request.user,
      body.directoryPath,
    );
    return setFolderDate(
      directoryPath,
      body.date,
      await getScanOptionsForUser(request.user, body.recursive),
    );
  },
  "POST /api/reset-folder-metadata": async (request) => {
    const body = await readJsonBody(request);
    const directoryPath = await resolvePathForUser(
      request.user,
      body.directoryPath,
    );
    return resetFolderMetadata(
      directoryPath,
      await getScanOptionsForUser(request.user, body.recursive),
    );
  },
  "POST /api/upload-to-immich": async (request) => {
    const body = await readJsonBody(request);
    registerImmichSecrets(body.settings);
    const directoryPath = await resolvePathForUser(
      request.user,
      body.directoryPath,
    );
    // The settings come from the user's own form (loaded from their own settings file), with the
    // managed URL and keys applied here, so each upload runs with the signed-in user's Immich credentials.
    return runImmichUpload(
      applyManagedImmichSettings(body.settings, immichConfig, request.user),
      directoryPath,
      createProgressReporter(request.user.userKey),
      {
        debug: debugEnabled,
        recursive: body.recursive === true,
        log: logger,
        lockKey: request.user.userKey || "default",
      },
    );
  },
});

/**
 * Creates the OpenID Connect sign-in, callback, and sign-out handlers.
 * @param {{oidcClient: Object, sessionCodec: Object, loginCodec: Object}} auth - The client and cookie codecs.
 * @returns {Object} Object mapping /auth/* paths to handlers.
 */
const createAuthRoutes = ({ oidcClient, sessionCodec, loginCodec }) => {
  // The app's public base URL: the redirect URI with its trailing "auth/callback" removed.
  const appLocation = new URL("../", oidcRedirectUri).href;
  const clearLoginCookie = serializeCookie(cookieNames.login, "", {
    maxAgeSeconds: 0,
    secure: secureCookies,
  });

  return {
    "/auth/login": async (_request, response) => {
      const { url, checks } = await oidcClient.startLogin();
      sendRedirect(response, url.href, [
        serializeCookie(
          cookieNames.login,
          loginCodec.seal({
            ...checks,
            expiresAt: Date.now() + loginStateMaxAgeSeconds * 1000,
          }),
          { maxAgeSeconds: loginStateMaxAgeSeconds, secure: secureCookies },
        ),
      ]);
    },
    "/auth/callback": async (request, response, url) => {
      const checks = loginCodec.open(
        parseCookies(request.headers.cookie).get(cookieNames.login),
      );
      if (url.searchParams.has("error")) {
        sendAuthError(
          response,
          400,
          `The identity provider refused the sign-in: ${url.searchParams.get("error_description") || url.searchParams.get("error")}`,
          [clearLoginCookie],
        );
        return;
      }
      if (!checks) {
        sendAuthError(
          response,
          400,
          "The sign-in attempt expired or was started in another browser.",
          [clearLoginCookie],
        );
        return;
      }

      let user;
      let claims;
      try {
        claims = await oidcClient.finishLogin(url.searchParams, checks);
        user = buildUserContext(claims, {
          foldersClaim: oidcFoldersClaim,
          adminGroup: oidcAdminGroup,
          adminClaim: oidcAdminClaim,
          immichApiKeyClaim: oidcImmichApiKeyClaim,
        });
      } catch (error) {
        // openid-client wraps the specific reason (e.g. a bad signature or unexpected "alg") in `cause`.
        const reason = error?.cause?.message ?? error?.message;
        logger.warn(`OpenID Connect sign-in failed: ${reason}`, error);
        sendAuthError(
          response,
          400,
          "Sign-in could not be completed. Check the server log for details.",
          [clearLoginCookie],
        );
        return;
      }

      const session = sessionCodec.seal({
        user,
        expiresAt: Date.now() + sessionMaxAgeSeconds * 1000,
      });
      if (session.length > maxSessionCookieLength) {
        sendAuthError(
          response,
          400,
          "Your account has too many shared folders to fit in a session. Ask an administrator to grant fewer, broader folders.",
          [clearLoginCookie],
        );
        return;
      }

      logger.addSecret(user.immichApiKey);
      logger.info("User signed in.", {
        username: user.username,
        isAdmin: user.isAdmin,
        folders: user.folders.length,
        immichApiKey: Boolean(user.immichApiKey),
      });
      if (!user.immichApiKey) {
        // Names and types only, never values, so a missing or mistyped Immich key can be diagnosed.
        const immichApiKeyValue = claims[oidcImmichApiKeyClaim];
        logger.info(
          `No Immich API key in the "${oidcImmichApiKeyClaim}" claim for ${user.username}; they enter their own.`,
          {
            claim:
              immichApiKeyValue === undefined
                ? "missing"
                : typeof immichApiKeyValue === "string"
                  ? immichApiKeyValue.trim()
                    ? "too long"
                    : "empty"
                  : `not a string (${Array.isArray(immichApiKeyValue) ? "array" : typeof immichApiKeyValue})`,
            receivedClaims: Object.keys(claims).sort(),
          },
        );
      }
      sendRedirect(response, appLocation, [
        serializeCookie(cookieNames.session, session, {
          maxAgeSeconds: sessionMaxAgeSeconds,
          secure: secureCookies,
        }),
        clearLoginCookie,
      ]);
    },
    "/auth/logout": async (_request, response) => {
      let location = appLocation;
      try {
        location = (await oidcClient.buildLogoutUrl())?.href ?? appLocation;
      } catch (error) {
        logger.warn("Could not build the identity provider logout URL.", error);
      }
      sendRedirect(response, location, [
        serializeCookie(cookieNames.session, "", {
          maxAgeSeconds: 0,
          secure: secureCookies,
        }),
      ]);
    },
  };
};

/**
 * Serves static files from the dist directory.
 * @param {ServerResponse} response - The HTTP response object.
 * @param {string} pathname - The requested URL pathname.
 */
const serveStatic = async (response, pathname) => {
  const relativePath =
    decodeURIComponent(pathname).replace(/^\/+/, "") || "index.html";
  let filePath = path.resolve(distDirectory, relativePath);
  if (!isInsideDirectory(filePath, distDirectory)) {
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
 * Rejects an unauthenticated request: a Basic auth challenge, a 401 for API calls, or a sign-in redirect.
 * @param {IncomingMessage} request - The HTTP request object.
 * @param {ServerResponse} response - The HTTP response object.
 * @param {URL} url - The parsed request URL.
 */
const rejectUnauthenticated = (request, response, url) => {
  if (!oidcEnabled) {
    response.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="Image Parser", charset="UTF-8"',
    });
    response.end("Authentication required.");
    return;
  }

  if (
    url.pathname.startsWith("/api/") ||
    (request.method !== "GET" && request.method !== "HEAD")
  ) {
    sendJson(response, 401, { error: "Sign in to continue." });
    return;
  }

  sendRedirect(response, new URL("login", oidcRedirectUri).href);
};

/**
 * Creates an HTTP request handler with authentication, routing, and error handling.
 * @param {{secretCodec: Object, immichConfig: Object, sessionCodec: Object|null, loginCodec: Object|null, oidcClient: Object|null}} context - Settings codec, managed Immich settings, and the OpenID Connect client and cookie codecs when enabled.
 * @returns {Function} An async function that handles HTTP requests and responses.
 */
const createRequestHandler = ({
  secretCodec,
  immichConfig,
  sessionCodec,
  loginCodec,
  oidcClient,
}) => {
  const apiRoutes = createApiRoutes(secretCodec, immichConfig);
  const authRoutes = oidcEnabled
    ? createAuthRoutes({ oidcClient, sessionCodec, loginCodec })
    : {};

  return async (request, response) => {
    const startedAt = Date.now();
    response.on("finish", () => {
      const pathname = (request.url ?? "/").split("?")[0];
      if (!unloggedPaths.has(pathname)) {
        logger.debug(
          `${request.method} ${pathname} ${response.statusCode} ${Date.now() - startedAt}ms`,
        );
      }
    });

    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      // Health checks run without credentials (the container HEALTHCHECK has none).
      if (url.pathname === "/healthz") {
        sendJson(response, 200, { ok: true });
        return;
      }

      const authRoute = authRoutes[url.pathname];
      if (authRoute && request.method === "GET") {
        await authRoute(request, response, url);
        return;
      }

      const user = authenticateRequest(request, sessionCodec);
      if (!user) {
        rejectUnauthenticated(request, response, url);
        return;
      }
      request.user = user;

      if (request.method === "GET" && url.pathname === "/api/immich-progress") {
        handleProgressStream(request, response);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/debug-log") {
        handleDebugLogStream(request, response);
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
        logger.error(
          `Request failed: ${request.method} ${(request.url ?? "/").split("?")[0]}`,
          error,
        );
      } else {
        logger.debug(`Request rejected with ${statusCode}: ${error?.message}`);
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
 * Validates the OpenID Connect settings and creates the client and cookie codecs.
 * @param {Buffer} masterKey - The server's master key; session keys are derived from it.
 * @returns {{oidcClient: Object|null, sessionCodec: Object|null, loginCodec: Object|null}} The OIDC context, or nulls when disabled.
 * @throws {Error} If the configuration is incomplete.
 */
const createOidcContext = (masterKey) => {
  if (!oidcEnabled) {
    return { oidcClient: null, sessionCodec: null, loginCodec: null };
  }

  if (authPassword) {
    logger.info(
      "IMAGEPARSER_USERNAME/IMAGEPARSER_PASSWORD are not used while OpenID Connect sign-in is on; they apply only when OIDC_DISABLED is set.",
    );
  }
  for (const [name, value] of Object.entries({
    OIDC_CLIENT_ID: oidcClientId,
    OIDC_CLIENT_SECRET: oidcClientSecret,
    OIDC_REDIRECT_URI: oidcRedirectUri,
  })) {
    if (!value) {
      throw new Error(`${name} must be set when OIDC_ISSUER_URL is set.`);
    }
  }
  for (const [name, value] of Object.entries({
    OIDC_ISSUER_URL: oidcIssuerUrl,
    OIDC_REDIRECT_URI: oidcRedirectUri,
  })) {
    if (!URL.canParse(value)) {
      throw new Error(`${name} must be an absolute URL.`);
    }
  }

  return {
    oidcClient: createOidcClient({
      issuerUrl: oidcIssuerUrl,
      clientId: oidcClientId,
      clientSecret: oidcClientSecret,
      redirectUri: oidcRedirectUri,
      scopes: oidcScopes,
      allowInsecureRequests: oidcAllowInsecureRequests,
    }),
    sessionCodec: createSealedCodec(deriveKey(masterKey, "session")),
    loginCodec: createSealedCodec(deriveKey(masterKey, "login")),
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

  const immichConfig = await readManagedImmichConfig(process.env);
  // The admin key lives only in the environment (or secret file) and memory, never in /config.
  logger.addSecret(immichConfig.adminApiKey);

  rootDirectory = await fs.realpath(configuredRoot);
  const masterKey = await loadSecretKey();
  const realConfigDirectory = await fs
    .realpath(configDirectory)
    .catch(() => configDirectory);
  const realPreviewCacheDirectory = path.join(
    realConfigDirectory,
    path.basename(previewCacheDirectory),
  );
  if (isInsideDirectory(realPreviewCacheDirectory, rootDirectory)) {
    // Cached previews must never appear among (or be served as) the user's photos.
    logger.warn(
      "IMAGEPARSER_CONFIG_DIR is inside IMAGEPARSER_ROOT; the preview cache is disabled.",
    );
  } else {
    configurePreviewCache({
      directory: realPreviewCacheDirectory,
      maxBytes: previewCacheMaxBytes,
    });
  }
  const server = http.createServer(
    createRequestHandler({
      secretCodec: createAesGcmCodec(masterKey),
      immichConfig,
      ...createOidcContext(masterKey),
    }),
  );

  /**
   * Shuts down the server and cleans up progress clients.
   */
  const shutdown = () => {
    server.close();
    for (const client of [
      ...[...progressClients.values()].flatMap((clients) => [...clients]),
      ...debugLogClients,
    ]) {
      client.end();
    }
    // Let in-flight metadata writes finish so no image is left half-written.
    void whenImageFileOperationsIdle()
      .then(() => shutdownCore())
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Without this, a port that cannot be opened (in use, or reserved by the OS) ends the process silently.
  server.on("error", (error) => {
    logger.error(
      `Image Parser could not listen on ${host}:${port} (${error?.code ?? "unknown error"}). Choose another port with PORT.`,
      error,
    );
    void shutdownCore().finally(() => process.exit(1));
  });

  server.listen(port, host, () => {
    logger.info(
      `Image Parser listening on http://${host}:${port} (root: ${rootDirectory})`,
    );
    if (oidcEnabled) {
      logger.info(
        `OpenID Connect sign-in is enabled (issuer: ${oidcIssuerUrl}).`,
      );
      if (!secureCookies) {
        logger.warn(
          "OIDC_REDIRECT_URI does not use HTTPS; session cookies are sent without the Secure flag.",
        );
      }
    } else if (oidcDisabled) {
      logger.warn(
        authPassword
          ? "OIDC_DISABLED is set: identity provider sign-in is bypassed and HTTP Basic auth is used instead. Every signed-in user has full access and shares one set of Immich settings."
          : "OIDC_DISABLED is set and no IMAGEPARSER_PASSWORD is configured: AUTHENTICATION IS OFF and anyone who can reach this server has full access. Remove OIDC_DISABLED as soon as the identity provider is back.",
      );
    } else if (!authPassword) {
      logger.warn(
        "Authentication is disabled. Set OIDC_ISSUER_URL, or IMAGEPARSER_USERNAME and IMAGEPARSER_PASSWORD, to enable it.",
      );
    }
    if (immichConfig.serverUrl || immichConfig.adminApiKey) {
      logger.info("Immich settings are managed by the environment.", {
        serverUrl: immichConfig.serverUrl || null,
        adminApiKey: Boolean(immichConfig.adminApiKey),
      });
    }
    if (debugEnabled) {
      logger.warn(
        "Debug logging is enabled (IMAGEPARSER_DEBUG). Server logs are streamed to the browser console.",
      );
      void logStartupDiagnostics();
    }
  });
};

start().catch((error) => {
  logger.error("Image Parser failed to start.", error);
  process.exit(1);
});
