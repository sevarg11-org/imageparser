import { app, BrowserWindow, ipcMain, protocol, safeStorage } from "electron";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  allowedExtensions,
  applyImageRotations,
  configurePreviewCache,
  defaultSortBy,
  getImagePreview,
  getThumbnail,
  listDirectory,
  listDrives,
  loadImmichSettings,
  needsRenderedPreview,
  readDirectory,
  readSidecarMetadata,
  runImmichUpload,
  saveImmichSettings,
  saveMetadata,
  setDoNotUpload,
  setFolderDate,
  shutdownCore,
  whenImageFileOperationsIdle,
} from "./core.js";
import fs from "node:fs/promises";

/**
 * The absolute file path of the current module.
 * @type {string}
 */
const __filename = fileURLToPath(import.meta.url);

/**
 * The directory name of the current module.
 * @type {string}
 */
const __dirname = path.dirname(__filename);

/**
 * The path to the application icon file.
 * @type {string}
 */
const appIconPath = path.join(
  __dirname,
  "assets",
  process.platform === "win32" ? "imageparser.ico" : "imageparser.png",
);

/**
 * Asserts that secure storage is available for credential encryption.
 * Throws an error if secure storage is not supported on the current system.
 * @throws {Error} If secure storage is unavailable.
 */
const assertSecureStorageAvailable = () => {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure credential storage is unavailable on this system.");
  }
};

/**
 * Encodes and decodes values using the system's secure storage API.
 * @type {{encrypt: (value: string) => string, decrypt: (value: string) => string}}
 */
const safeStorageCodec = Object.freeze({
  /**
   * Encrypts a plain text value using secure storage.
   * @param {string} value - The value to encrypt.
   * @returns {string} The encrypted value as a base64 string.
   */
  encrypt: (value) => {
    assertSecureStorageAvailable();
    return safeStorage.encryptString(value).toString("base64");
  },

  /**
   * Decrypts a base64-encoded encrypted value using secure storage.
   * @param {string} value - The encrypted value to decrypt.
   * @returns {string} The decrypted plain text value.
   * @throws {Error} If decryption fails or the API keys are invalid.
   */
  decrypt: (value) => {
    assertSecureStorageAvailable();
    try {
      return safeStorage.decryptString(Buffer.from(value, "base64"));
    } catch {
      throw new Error(
        "The saved Immich API keys could not be decrypted. Enter them again.",
      );
    }
  },
});

/**
 * Returns the path to the user's application data directory.
 * @returns {string} The path to the settings directory.
 */
const getSettingsDirectory = () => app.getPath("userData");

/**
 * The read-only URL scheme that serves grid thumbnails, so `<img>` elements can load them
 * without holding base64 data URLs in renderer memory. The preload script builds its URLs.
 * @type {string}
 */
const thumbnailScheme = "imageparser-thumb";

// Custom schemes must be registered before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: thumbnailScheme, privileges: { standard: true, secure: true } },
]);

/**
 * Serves a cached WebP thumbnail for a supported image file. Only GET requests for
 * absolute paths to regular image files are answered; nothing can be written.
 * @param {Request} request - The protocol request; `path` and `size` are query parameters.
 * @returns {Promise<Response>} The thumbnail, or an empty error response.
 */
const handleThumbnailRequest = async (request) => {
  const url = new URL(request.url);
  const filePath = url.searchParams.get("path") ?? "";
  if (
    request.method !== "GET" ||
    !path.isAbsolute(filePath) ||
    !allowedExtensions.has(path.extname(filePath).toLowerCase())
  ) {
    return new Response(null, { status: 400 });
  }

  try {
    if (!(await fs.stat(filePath)).isFile()) {
      return new Response(null, { status: 404 });
    }
    const thumbnail = await getThumbnail(filePath, {
      size: url.searchParams.get("size"),
      signal: request.signal,
    });
    // The URL carries the file's version, so a changed file always gets a new URL.
    return new Response(thumbnail, {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    return new Response(null, {
      status: error?.code === "ENOENT" ? 404 : 500,
    });
  }
};

/**
 * Retrieves a preview URL for an image file.
 * Files the browser can display are loaded directly, with the file's version in the URL so a
 * rewritten file is reloaded. TIFF files are rendered (and cached) as WebP data URLs.
 * Rotation is shown by the renderer, so previews are never rendered just to rotate them.
 * @param {string} filePath - The path to the image file.
 * @param {string} [version=""] - The file's version, from the directory listing or the last save.
 * @returns {Promise<string>} A data URL for the preview, a file URL, or an empty string.
 */
const getPreviewDataUrl = async (filePath, version = "") => {
  if (!filePath) {
    return "";
  }

  if (!needsRenderedPreview(filePath)) {
    const fileUrl = pathToFileURL(filePath);
    fileUrl.searchParams.set("v", String(version ?? ""));
    return fileUrl.href;
  }

  try {
    const preview = await getImagePreview(filePath);
    return `data:${preview.contentType};base64,${preview.buffer.toString("base64")}`;
  } catch {
    try {
      return pathToFileURL(filePath).href;
    } catch {
      return "";
    }
  }
};

/**
 * Loads and displays the frontend HTML page in the main window.
 * Attempts to load from the dist directory, then the Vite dev server,
 * or falls back to an embedded HTML message if neither is available.
 * @param {BrowserWindow} mainWindow - The Electron BrowserWindow instance.
 */
const loadFrontend = async (mainWindow) => {
  const distPath = path.join(__dirname, "dist", "index.html");
  const devUrl = "http://localhost:5173";
  const startupFallback = `data:text/html;charset=utf-8,${encodeURIComponent(`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Image Parser</title>
        <style>
          body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            font-family: Arial, sans-serif;
            background: #0f172a;
            color: #e2e8f0;
          }
          .card {
            padding: 2rem 2.5rem;
            border-radius: 12px;
            background: rgba(15, 23, 42, 0.9);
            border: 1px solid rgba(148, 163, 184, 0.2);
            text-align: center;
            max-width: 520px;
          }
          h1 { margin: 0 0 0.75rem; }
          p { margin: 0.5rem 0; color: #cbd5e1; }
          code { background: rgba(30, 41, 59, 0.9); padding: 0.2rem 0.45rem; border-radius: 6px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Image Parser</h1>
          <p>Start the Vite dev server with <code>npm run dev</code> or build the app with <code>npm run build</code>.</p>
          <p>Direct <code>electron ./</code> will now fall back to the local built UI when available.</p>
        </div>
      </body>
    </html>
  `)}`;

  try {
    await fs.access(distPath);
    await mainWindow.loadFile(distPath);
    return;
  } catch {
    // No built UI yet, try the Vite dev server next.
  }

  if (!app.isPackaged) {
    try {
      await mainWindow.loadURL(devUrl);
      return;
    } catch {
      // Fall through to the startup message if no dev server is running.
    }
  }

  await mainWindow.loadURL(startupFallback);
};

/**
 * Creates and configures the main application window.
 * Sets up the window with appropriate dimensions, title, icon, and
 * web preferences including preload script for secure renderer bridge.
 * @returns {BrowserWindow} The newly created BrowserWindow instance.
 */
const createMainWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    title: "Image Parser",
    backgroundColor: "#0f172a",
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  loadFrontend(mainWindow).catch(() => {
    mainWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent("<html><body>Unable to start Image Parser.</body></html>")}`,
    );
  });

  return mainWindow;
};

/**
 * Main application lifecycle hook that creates the main window when
 * the app is ready, and recreates it if all windows are closed.
 */
app.whenReady().then(() => {
  protocol.handle(thumbnailScheme, handleThumbnailRequest);
  configurePreviewCache({
    directory: path.join(getSettingsDirectory(), "preview-cache"),
  });
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

/**
 * Main application lifecycle hook that quits the app on window close
 * for non-Darwin platforms. On macOS, windows remain open as expected.
 */
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

/**
 * Main application lifecycle hook that shuts down core operations
 * when the app is being quit.
 */
let isShutdownComplete = false;
app.on("will-quit", (event) => {
  if (isShutdownComplete) {
    return;
  }

  // Saves started just before closing run in the background; let them finish before stopping ExifTool.
  event.preventDefault();
  void whenImageFileOperationsIdle()
    .then(() => shutdownCore())
    .finally(() => {
      isShutdownComplete = true;
      app.quit();
    });
});

/**
 * IPC handler that lists a folder for the in-app folder browser.
 * Browsing starts in the home folder and can climb to the filesystem root; on Windows the level
 * above a drive root is a virtual list of the available drives.
 * @param {*} _event - The IPC event object.
 * @param {string|null} directoryPath - The folder to list, null for the home folder, or "" for the drive list.
 * @returns {Promise<Object>} Object with path, rootPath, parent, selectable, directories, and imageCount.
 *   A parent of "" means the drive list; null means there is nothing above.
 */
ipcMain.handle("browse-directory", async (_event, directoryPath) => {
  const isWindows = process.platform === "win32";
  if (directoryPath === "" && isWindows) {
    return {
      path: "",
      rootPath: null,
      parent: null,
      selectable: false,
      directories: await listDrives(),
      imageCount: 0,
    };
  }

  if (directoryPath != null && typeof directoryPath !== "string") {
    throw new Error("The folder path must be a string.");
  }

  const resolvedPath = path.resolve(directoryPath || os.homedir());
  const { directories, imageCount } = await listDirectory(resolvedPath);
  const parentPath = path.dirname(resolvedPath);
  let parent = parentPath;
  if (parentPath === resolvedPath) {
    parent = isWindows ? "" : null;
  }

  return {
    path: resolvedPath,
    rootPath: null,
    parent,
    selectable: true,
    directories,
    imageCount,
  };
});

/**
 * IPC handler for reading directory contents.
 * Returns a list of files in the specified directory, optionally sorted.
 * @param {*} _event - The IPC event object.
 * @param {string} directoryPath - The path to the directory to read.
 * @param {string} [sortBy=defaultSortBy] - The field to sort by.
 * @returns {Promise<string[]>} An array of file paths in the directory.
 */
ipcMain.handle(
  "read-directory",
  (_event, directoryPath, sortBy = defaultSortBy) =>
    readDirectory(directoryPath, sortBy),
);

/**
 * IPC handler for saving metadata to sidecar files.
 * Writes the provided metadata object to JSON files alongside images.
 * @param {*} _event - The IPC event object.
 * @param {Object} metadata - The metadata object to save.
 * @returns {Promise<void>} Resolves when all metadata has been saved.
 */
ipcMain.handle("save-metadata", (_event, metadata) => saveMetadata(metadata));

/**
 * IPC handler for reading sidecar metadata from an image file.
 * Loads and returns the metadata stored in a JSON sidecar file.
 * @param {*} _event - The IPC event object.
 * @param {string} filePath - The path to the image file.
 * @returns {Promise<Object|null>} The parsed metadata, or null if not found.
 */
ipcMain.handle("read-sidecar-metadata", (_event, filePath) =>
  readSidecarMetadata(filePath),
);

/**
 * IPC handler for getting a preview URL of an image.
 * Returns a data URL that can be displayed in the UI for the specified file
 * and rotation angle.
 * @param {*} _event - The IPC event object.
 * @param {string} filePath - The path to the image file.
 * @param {string} version - The file's version, so a rewritten file is reloaded.
 * @returns {Promise<string>} A data URL or file URL for the preview.
 */
ipcMain.handle("get-preview-data-url", (_event, filePath, version) =>
  getPreviewDataUrl(filePath, version),
);

/**
 * IPC handler for applying image rotations in a batch operation.
 * Processes multiple images with their specified rotation angles.
 * @param {*} _event - The IPC event object.
 * @param {Object} request - An object containing the array of images to rotate.
 * @returns {Promise<Object>} A report of the rotation operations.
 */
ipcMain.handle("apply-image-rotations", (_event, request) =>
  applyImageRotations(request),
);

/**
 * IPC handler for loading Immich settings from secure storage.
 * Decrypts and returns the stored Immich API credentials and server URL.
 * @returns {Promise<Object>} The loaded Immich settings including API keys.
 */
ipcMain.handle("load-immich-settings", () =>
  loadImmichSettings(getSettingsDirectory(), safeStorageCodec),
);

/**
 * IPC handler for saving Immich settings to secure storage.
 * Encrypts and stores the provided Immich configuration for later use.
 * @param {*} _event - The IPC event object.
 * @param {Object} settings - The Immich settings to save (including API keys).
 * @returns {Promise<void>} Resolves when settings have been saved.
 */
ipcMain.handle("save-immich-settings", (_event, settings) =>
  saveImmichSettings(getSettingsDirectory(), safeStorageCodec, settings),
);

/**
 * IPC handler for uploading images to Immich server.
 * Processes all images in the specified directory and uploads them to Immich.
 * Sends progress updates via IPC to the renderer process.
 * @param {*} _event - The IPC event object with sender reference for progress events.
 * @param {Object} settings - The Immich settings including API credentials.
 * @param {string} directoryPath - The path to the directory containing images to upload.
 * @returns {Promise<Object>} A report of the upload operation results.
 */
/**
 * IPC handler for setting the date on all images in a directory that do not
 * already have an XMP sidecar file.
 * @param {*} _event - The IPC event object.
 * @param {{directoryPath: string, date: string}} payload
 * @returns {Promise<{ok: boolean, updatedPairs: number, skippedPairs: number, errors: string[]}>}
 */
ipcMain.handle("set-folder-date", (_event, { directoryPath, date }) =>
  setFolderDate(directoryPath, date),
);

/**
 * IPC handler for flagging an image group "Do not upload" or clearing the flag.
 * Renames the group's images and sidecars to add or remove the exclude marker.
 * @param {*} _event - The IPC event object.
 * @param {{frontPath: string, backPath: string|null, value: boolean}} request - The group and the flag value.
 * @returns {Promise<Object>} The group with its new paths.
 */
ipcMain.handle("set-do-not-upload", (_event, request) =>
  setDoNotUpload({
    frontPath: request?.frontPath,
    backPath: request?.backPath,
    value: request?.value,
  }),
);

ipcMain.handle("upload-to-immich", async (_event, settings, directoryPath) => {
  const reportProgress = (progress) => {
    if (!_event.sender.isDestroyed()) {
      _event.sender.send("immich-upload-progress", progress);
    }
  };

  return runImmichUpload(settings, directoryPath, reportProgress);
});
