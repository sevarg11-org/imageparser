import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { DirectoryBrowserDialog, type DirectoryListing } from './DirectoryBrowser'

type ImageParserApi = NonNullable<Window['electronAPI']>

const LAST_DIRECTORY_STORAGE_KEY = 'imageparser:last-directory'

const openDirectoryBrowser = (
  initialPath: string | null,
  loadListing: (directoryPath: string | null) => Promise<DirectoryListing>,
) =>
  new Promise<string | null>((resolve) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const onClose = (selectedPath: string | null) => {
      root.unmount()
      container.remove()
      resolve(selectedPath)
    }

    root.render(createElement(DirectoryBrowserDialog, { initialPath, loadListing, onClose }))
  })

const requestJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init)
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(payload?.error ?? `Request failed with status ${response.status}.`)
  }
  return payload as T
}

const postJson = <T>(url: string, body: unknown) =>
  requestJson<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

const loadDirectoryListing = (directoryPath: string | null) => {
  const query = directoryPath ? `?${new URLSearchParams({ path: directoryPath }).toString()}` : ''
  return requestJson<DirectoryListing>(`api/browse${query}`)
}

// Mirrors the Electron preload bridge so App.tsx works unchanged when served over HTTP.
const createWebApi = (): ImageParserApi => ({
  chooseDirectory: async () => {
    const selectedPath = await openDirectoryBrowser(
      window.localStorage.getItem(LAST_DIRECTORY_STORAGE_KEY),
      loadDirectoryListing,
    )
    if (selectedPath) {
      window.localStorage.setItem(LAST_DIRECTORY_STORAGE_KEY, selectedPath)
    }
    return selectedPath
  },
  readDirectory: (directoryPath, sortBy) => postJson('api/read-directory', { directoryPath, sortBy }),
  readSidecarMetadata: (filePath) => postJson('api/read-sidecar-metadata', { filePath }),
  saveMetadata: (metadata) => postJson('api/save-metadata', metadata),
  getPreviewDataUrl: async (filePath, rotation) =>
    (await postJson<{ url: string }>('api/preview-url', { filePath, rotation })).url,
  applyImageRotations: (request) => postJson('api/apply-image-rotations', request),
  loadImmichSettings: () => requestJson('api/immich-settings'),
  saveImmichSettings: (settings) => postJson('api/immich-settings', settings),
  uploadToImmich: (settings, directoryPath) => postJson('api/upload-to-immich', { settings, directoryPath }),
  onImmichUploadProgress: (listener) => {
    const eventSource = new EventSource('api/immich-progress')
    eventSource.onmessage = (event) => {
      try {
        listener(JSON.parse(event.data))
      } catch {
        // Ignore malformed progress messages; the final upload result still arrives via the POST response.
      }
    }
    return () => eventSource.close()
  },
})

export const installWebApi = () => {
  if (!window.electronAPI) {
    window.electronAPI = createWebApi()
  }
}
