import { createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  DirectoryBrowserDialog,
  type DirectoryListing,
} from "./DirectoryBrowser";

type ImageParserApi = NonNullable<Window["electronAPI"]>;

const LAST_DIRECTORY_STORAGE_KEY = "imageparser:last-directory";

const openDirectoryBrowser = (
  initialPath: string | null,
  loadListing: (directoryPath: string | null) => Promise<DirectoryListing>,
) =>
  new Promise<string | null>((resolve) => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    const onClose = (selectedPath: string | null) => {
      root.unmount();
      container.remove();
      resolve(selectedPath);
    };

    root.render(
      createElement(DirectoryBrowserDialog, {
        initialPath,
        loadListing,
        onClose,
      }),
    );
  });

export type CurrentUser = {
  username: string;
  isAdmin: boolean;
  authMode: "oidc" | "basic" | "none";
};

let isWebApiInstalled = false;

const requestJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  // An expired OpenID Connect session answers 401 without a Basic challenge; sign in again.
  if (response.status === 401 && !response.headers.has("WWW-Authenticate")) {
    window.location.assign("auth/login");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      payload?.error ?? `Request failed with status ${response.status}.`,
    );
  }
  return payload as T;
};

const postJson = <T>(url: string, body: unknown) =>
  requestJson<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const loadDirectoryListing = (directoryPath: string | null) => {
  const query = directoryPath
    ? `?${new URLSearchParams({ path: directoryPath }).toString()}`
    : "";
  return requestJson<DirectoryListing>(`api/browse${query}`);
};

// Mirrors the Electron preload bridge so App.tsx works unchanged when served over HTTP.
const createWebApi = (): ImageParserApi => ({
  chooseDirectory: async () => {
    const selectedPath = await openDirectoryBrowser(
      window.localStorage.getItem(LAST_DIRECTORY_STORAGE_KEY),
      loadDirectoryListing,
    );
    if (selectedPath) {
      window.localStorage.setItem(LAST_DIRECTORY_STORAGE_KEY, selectedPath);
    }
    return selectedPath;
  },
  readDirectory: (directoryPath, sortBy) =>
    postJson("api/read-directory", { directoryPath, sortBy }),
  readSidecarMetadata: (filePath) =>
    postJson("api/read-sidecar-metadata", { filePath }),
  saveMetadata: (metadata) => postJson("api/save-metadata", metadata),
  getPreviewDataUrl: async (filePath, rotation) =>
    (await postJson<{ url: string }>("api/preview-url", { filePath, rotation }))
      .url,
  getThumbnailUrl: (filePath, size, version) =>
    `api/image?${new URLSearchParams({
      path: filePath,
      thumb: String(size),
      v: version,
    }).toString()}`,
  applyImageRotations: (request) =>
    postJson("api/apply-image-rotations", request),
  setFolderDate: (directoryPath, date) =>
    postJson("api/set-folder-date", { directoryPath, date }),
  setDoNotUpload: (request) => postJson("api/do-not-upload", request),
  loadImmichSettings: () => requestJson("api/immich-settings"),
  saveImmichSettings: (settings) => postJson("api/immich-settings", settings),
  uploadToImmich: (settings, directoryPath) =>
    postJson("api/upload-to-immich", { settings, directoryPath }),
  onImmichUploadProgress: (listener) => {
    const eventSource = new EventSource("api/immich-progress");
    eventSource.onmessage = (event) => {
      try {
        listener(JSON.parse(event.data));
      } catch {
        // Ignore malformed progress messages; the final upload result still arrives via the POST response.
      }
    };
    return () => eventSource.close();
  },
});

type ServerLogLevel = "debug" | "info" | "warn" | "error";

type ServerLogEntry = {
  time: string;
  level: ServerLogLevel;
  message: string;
  details?: unknown;
};

const serverLogLevels: ReadonlySet<string> = new Set<ServerLogLevel>([
  "debug",
  "info",
  "warn",
  "error",
]);

const isServerLogEntry = (value: unknown): value is ServerLogEntry =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as ServerLogEntry).message === "string" &&
  serverLogLevels.has((value as ServerLogEntry).level);

// Mirrors server-side logs into the browser console when the server runs with IMAGEPARSER_DEBUG enabled.
const connectServerDebugLog = async () => {
  try {
    const config = await requestJson<{ rootPath: string; debug?: boolean }>(
      "api/config",
    );
    if (!config.debug) {
      return;
    }

    console.info(
      "[server] Debug logging is enabled; server log entries will appear here.",
    );
    const eventSource = new EventSource("api/debug-log");
    eventSource.addEventListener("log", (event) => {
      try {
        const entry: unknown = JSON.parse((event as MessageEvent<string>).data);
        if (!isServerLogEntry(entry)) {
          return;
        }
        const prefix = `[server] ${entry.time}`;
        if (entry.details === undefined) {
          console[entry.level](prefix, entry.message);
        } else {
          console[entry.level](prefix, entry.message, entry.details);
        }
      } catch {
        // Ignore malformed log messages; they are diagnostic only.
      }
    });
  } catch {
    // Debug logging is optional; the app works without it.
  }
};

/**
 * Returns the signed-in web user, or null in the desktop app or when the server cannot say.
 */
export const fetchCurrentUser = async (): Promise<CurrentUser | null> => {
  if (!isWebApiInstalled) {
    return null;
  }
  try {
    return await requestJson<CurrentUser>("api/me");
  } catch {
    return null;
  }
};

export const installWebApi = () => {
  if (!window.electronAPI) {
    window.electronAPI = createWebApi();
    isWebApiInstalled = true;
    void connectServerDebugLog();
  }
};
