import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  applyImageRotations,
  defaultSortBy,
  getImageRevision,
  loadImmichSettings,
  needsRenderedPreview,
  readDirectory,
  readSidecarMetadata,
  renderPreviewPng,
  runImageFileOperation,
  runImmichUpload,
  saveImmichSettings,
  saveMetadata,
  shutdownCore,
} from './core.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appIconPath = path.join(__dirname, 'assets', process.platform === 'win32' ? 'imageparser.ico' : 'imageparser.png')

const assertSecureStorageAvailable = () => {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure credential storage is unavailable on this system.')
  }
}

const safeStorageCodec = Object.freeze({
  encrypt: (value) => {
    assertSecureStorageAvailable()
    return safeStorage.encryptString(value).toString('base64')
  },
  decrypt: (value) => {
    assertSecureStorageAvailable()
    try {
      return safeStorage.decryptString(Buffer.from(value, 'base64'))
    } catch {
      throw new Error('The saved Immich API keys could not be decrypted. Enter them again.')
    }
  },
})

const getSettingsDirectory = () => app.getPath('userData')

const getPreviewDataUrl = async (filePath, rotation = 0) => {
  if (!filePath) {
    return ''
  }

  if (!needsRenderedPreview(filePath, rotation)) {
    const fileUrl = pathToFileURL(filePath)
    fileUrl.searchParams.set('imageParserRevision', String(getImageRevision(filePath)))
    return fileUrl.href
  }

  try {
    const pngBuffer = await renderPreviewPng(filePath, rotation)
    return `data:image/png;base64,${pngBuffer.toString('base64')}`
  } catch {
    try {
      return pathToFileURL(filePath).href
    } catch {
      return ''
    }
  }
}

const loadFrontend = async (mainWindow) => {
  const distPath = path.join(__dirname, 'dist', 'index.html')
  const devUrl = 'http://localhost:5173'
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
  `)}`

  try {
    await fs.access(distPath)
    await mainWindow.loadFile(distPath)
    return
  } catch {
    // No built UI yet, try the Vite dev server next.
  }

  if (!app.isPackaged) {
    try {
      await mainWindow.loadURL(devUrl)
      return
    } catch {
      // Fall through to the startup message if no dev server is running.
    }
  }

  await mainWindow.loadURL(startupFallback)
}

const createMainWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    title: 'Image Parser',
    backgroundColor: '#0f172a',
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  loadFrontend(mainWindow).catch(() => {
    mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<html><body>Unable to start Image Parser.</body></html>')}`)
  })

  return mainWindow
}

app.whenReady().then(() => {
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  void shutdownCore()
})

ipcMain.handle('choose-directory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select the image directory',
  })

  if (result.canceled || !result.filePaths.length) {
    return null
  }

  return result.filePaths[0]
})

ipcMain.handle('read-directory', (_event, directoryPath, sortBy = defaultSortBy) =>
  readDirectory(directoryPath, sortBy))

ipcMain.handle('save-metadata', (_event, metadata) => saveMetadata(metadata))

ipcMain.handle('read-sidecar-metadata', (_event, filePath) => readSidecarMetadata(filePath))

ipcMain.handle('get-preview-data-url', (_event, filePath, rotation) =>
  runImageFileOperation(() => getPreviewDataUrl(filePath, rotation)))

ipcMain.handle('apply-image-rotations', (_event, request) => applyImageRotations(request))

ipcMain.handle('load-immich-settings', () => loadImmichSettings(getSettingsDirectory(), safeStorageCodec))

ipcMain.handle('save-immich-settings', (_event, settings) =>
  saveImmichSettings(getSettingsDirectory(), safeStorageCodec, settings))

ipcMain.handle('upload-to-immich', async (_event, settings, directoryPath) => {
  const reportProgress = (progress) => {
    if (!_event.sender.isDestroyed()) {
      _event.sender.send('immich-upload-progress', progress)
    }
  }

  return runImmichUpload(settings, directoryPath, reportProgress)
})