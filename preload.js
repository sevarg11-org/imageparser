const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  chooseDirectory: () => ipcRenderer.invoke('choose-directory'),
  readDirectory: (directoryPath, sortBy) => ipcRenderer.invoke('read-directory', directoryPath, sortBy),
  readSidecarMetadata: (filePath) => ipcRenderer.invoke('read-sidecar-metadata', filePath),
  saveMetadata: (metadata) => ipcRenderer.invoke('save-metadata', metadata),
  getPreviewDataUrl: (filePath, rotation) => ipcRenderer.invoke('get-preview-data-url', filePath, rotation),
  applyImageRotations: (request) => ipcRenderer.invoke('apply-image-rotations', request),
  loadImmichSettings: () => ipcRenderer.invoke('load-immich-settings'),
  saveImmichSettings: (settings) => ipcRenderer.invoke('save-immich-settings', settings),
  uploadToImmich: (settings, directoryPath) =>
    ipcRenderer.invoke('upload-to-immich', settings, directoryPath),
  onImmichUploadProgress: (listener) => {
    const handleProgress = (_event, progress) => listener(progress)
    ipcRenderer.on('immich-upload-progress', handleProgress)
    return () => ipcRenderer.removeListener('immich-upload-progress', handleProgress)
  },
})
