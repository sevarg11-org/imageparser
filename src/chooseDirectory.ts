import { createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  DirectoryBrowserDialog,
  type DirectoryListing,
} from "./DirectoryBrowser";

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

const readLastDirectory = () => {
  try {
    return window.localStorage.getItem(LAST_DIRECTORY_STORAGE_KEY);
  } catch {
    return null;
  }
};

const rememberLastDirectory = (directoryPath: string) => {
  try {
    window.localStorage.setItem(LAST_DIRECTORY_STORAGE_KEY, directoryPath);
  } catch {
    // Remembering the folder is a convenience; browsing still works without storage.
  }
};

/**
 * Opens the in-app folder browser at the last opened folder, in both the desktop and web apps.
 * @param loadListing - Lists a folder; the platform decides what null and "" (virtual root) mean.
 * @returns The selected folder, or null when the browser was cancelled.
 */
export const chooseDirectory = async (
  loadListing: (directoryPath: string | null) => Promise<DirectoryListing>,
) => {
  const selectedPath = await openDirectoryBrowser(
    readLastDirectory(),
    loadListing,
  );
  if (selectedPath) {
    rememberLastDirectory(selectedPath);
  }
  return selectedPath;
};
