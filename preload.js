const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  browseDirectory: (directoryPath) =>
    ipcRenderer.invoke("browse-directory", directoryPath),
  readDirectory: (directoryPath, sortBy, recursive) =>
    ipcRenderer.invoke("read-directory", directoryPath, sortBy, recursive),
  readSidecarMetadata: (filePath) =>
    ipcRenderer.invoke("read-sidecar-metadata", filePath),
  saveMetadata: (metadata) => ipcRenderer.invoke("save-metadata", metadata),
  getPreviewDataUrl: (filePath, version) =>
    ipcRenderer.invoke("get-preview-data-url", filePath, version),
  // Served by the read-only "imageparser-thumb" protocol registered in main.js.
  getThumbnailUrl: (filePath, size, version) =>
    `imageparser-thumb://thumbnail/?${new URLSearchParams({
      path: filePath,
      size: String(size),
      v: version,
    }).toString()}`,
  // Served by the read-only "imageparser-video" protocol registered in main.js.
  getVideoUrl: (filePath, version) =>
    `imageparser-video://video/?${new URLSearchParams({
      path: filePath,
      v: version,
    }).toString()}`,
  getVideoSpriteUrl: (filePath, version) =>
    `imageparser-video://sprite/?${new URLSearchParams({
      path: filePath,
      v: version,
    }).toString()}`,
  applyImageRotations: (request) =>
    ipcRenderer.invoke("apply-image-rotations", request),
  setFolderDate: (directoryPath, date, recursive) =>
    ipcRenderer.invoke("set-folder-date", { directoryPath, date, recursive }),
  setPairsDate: (pairs, date) =>
    ipcRenderer.invoke("set-pairs-date", { pairs, date }),
  searchPlaces: (query) => ipcRenderer.invoke("geocode-search", query),
  getRecentPlaces: () => ipcRenderer.invoke("get-recent-places"),
  rememberPlace: (place) => ipcRenderer.invoke("remember-place", place),
  countPairsWithLocation: (pairs) =>
    ipcRenderer.invoke("count-pairs-location", { pairs }),
  setPairsLocation: (pairs, location) =>
    ipcRenderer.invoke("set-pairs-location", { pairs, location }),
  addTagsToPairs: (pairs, tags) =>
    ipcRenderer.invoke("add-tags-to-pairs", { pairs, tags }),
  resetFolderMetadata: (directoryPath, recursive) =>
    ipcRenderer.invoke("reset-folder-metadata", { directoryPath, recursive }),
  setDoNotUpload: (request) => ipcRenderer.invoke("set-do-not-upload", request),
  setFolderProcessed: (directoryPath, value, includeSubfolders) =>
    ipcRenderer.invoke("set-folder-processed", {
      directoryPath,
      value,
      includeSubfolders,
    }),
  loadImmichSettings: () => ipcRenderer.invoke("load-immich-settings"),
  saveImmichSettings: (settings) =>
    ipcRenderer.invoke("save-immich-settings", settings),
  uploadToImmich: (settings, directoryPath, recursive) =>
    ipcRenderer.invoke("upload-to-immich", settings, directoryPath, recursive),
  onImmichUploadProgress: (listener) => {
    const handleProgress = (_event, progress) => listener(progress);
    ipcRenderer.on("immich-upload-progress", handleProgress);
    return () =>
      ipcRenderer.removeListener("immich-upload-progress", handleProgress);
  },
});
