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
  applyImageRotations: (request) =>
    ipcRenderer.invoke("apply-image-rotations", request),
  setFolderDate: (directoryPath, date, recursive) =>
    ipcRenderer.invoke("set-folder-date", { directoryPath, date, recursive }),
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
