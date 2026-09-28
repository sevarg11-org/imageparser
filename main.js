import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { exiftool } from 'exiftool-vendored'
import sharp from 'sharp'
import { createSerialQueue } from './imageFileQueue.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appIconPath = path.join(__dirname, 'assets', process.platform === 'win32' ? 'imageparser.ico' : 'imageparser.png')
const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff'])
const defaultSortBy = 'createdAt'
const immichSettingsFileName = 'immich-settings.json'
const maxImmichOutputLength = 32_000
const metadataRotationExtensions = new Set(['.jpg', '.jpeg', '.tif', '.tiff'])
const pixelRotationExtensions = new Set(['.png', '.webp'])
const imageRevisionByPath = new Map()
const runImageFileOperation = createSerialQueue()
const defaultImmichSettings = Object.freeze({
  serverUrl: '',
  userApiKey: '',
  adminApiKey: '',
  albumName: '',
  tags: '',
  pauseImmichJobs: true,
  concurrentTasks: 2,
})
let isImmichUploadRunning = false

const getImmichSettingsPath = () => path.join(app.getPath('userData'), immichSettingsFileName)

const normalizeImmichTags = (value) => {
  const tags = Array.isArray(value) ? value : String(value ?? '').split(',')
  return Array.from(new Set(tags.map((tag) => String(tag).trim()).filter(Boolean)))
}

const normalizeImmichSettings = (settings) => {
  const normalizedSettings = {
    serverUrl: String(settings?.serverUrl ?? '').trim().replace(/\/+$/, ''),
    userApiKey: String(settings?.userApiKey ?? '').trim(),
    adminApiKey: String(settings?.adminApiKey ?? '').trim(),
    albumName: String(settings?.albumName ?? '').trim(),
    tags: normalizeImmichTags(settings?.tags).join(', '),
    pauseImmichJobs: settings?.pauseImmichJobs !== false,
    concurrentTasks: Number(settings?.concurrentTasks),
  }

  let serverUrl
  try {
    serverUrl = new URL(normalizedSettings.serverUrl)
  } catch {
    throw new Error('Enter a valid Immich server URL.')
  }

  if (!['http:', 'https:'].includes(serverUrl.protocol)) {
    throw new Error('The Immich server URL must use HTTP or HTTPS.')
  }

  if (!normalizedSettings.userApiKey) {
    throw new Error('Enter the user API key.')
  }

  if (normalizedSettings.pauseImmichJobs && !normalizedSettings.adminApiKey) {
    throw new Error('Enter an admin API key or turn off pausing Immich jobs.')
  }

  if (!normalizedSettings.albumName) {
    throw new Error('Enter the target album name.')
  }

  if (
    !Number.isInteger(normalizedSettings.concurrentTasks) ||
    normalizedSettings.concurrentTasks < 1 ||
    normalizedSettings.concurrentTasks > 20
  ) {
    throw new Error('Concurrent tasks must be a whole number from 1 through 20.')
  }

  return normalizedSettings
}

const encryptImmichSecret = (value) => {
  if (!value) {
    return ''
  }

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure credential storage is unavailable on this system.')
  }

  return safeStorage.encryptString(value).toString('base64')
}

const decryptImmichSecret = (value) => {
  if (!value) {
    return ''
  }

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure credential storage is unavailable on this system.')
  }

  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  } catch {
    throw new Error('The saved Immich API keys could not be decrypted. Enter them again.')
  }
}

const loadImmichSettings = async () => {
  try {
    const storedSettings = JSON.parse(await fs.readFile(getImmichSettingsPath(), 'utf8'))
    return {
      ...defaultImmichSettings,
      serverUrl: String(storedSettings.serverUrl ?? ''),
      userApiKey: decryptImmichSecret(storedSettings.userApiKey),
      adminApiKey: decryptImmichSecret(storedSettings.adminApiKey),
      albumName: String(storedSettings.albumName ?? ''),
      tags: String(storedSettings.tags ?? ''),
      pauseImmichJobs: storedSettings.pauseImmichJobs !== false,
      concurrentTasks: Number(storedSettings.concurrentTasks) || defaultImmichSettings.concurrentTasks,
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ...defaultImmichSettings }
    }

    throw error
  }
}

const saveImmichSettings = async (settings) => {
  const normalizedSettings = normalizeImmichSettings(settings)
  const storedSettings = {
    ...normalizedSettings,
    userApiKey: encryptImmichSecret(normalizedSettings.userApiKey),
    adminApiKey: encryptImmichSecret(normalizedSettings.adminApiKey),
  }

  await fs.mkdir(path.dirname(getImmichSettingsPath()), { recursive: true })
  await fs.writeFile(getImmichSettingsPath(), JSON.stringify(storedSettings, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  })

  return normalizedSettings
}

const buildImmichUploadArguments = (settings, directoryPath) => {
  const tags = normalizeImmichTags(settings.tags)
  const uploadArguments = [
      'upload',
    'from-folder',
    `--concurrent-tasks=${String(settings.concurrentTasks)}`,
    '--no-ui',
    `--server=${settings.serverUrl}`,
    '--recursive=false',
    `--api-key=${settings.userApiKey}`,
    `--pause-immich-jobs=${settings.pauseImmichJobs}`,
    `--into-album=${settings.albumName}`,
      '--ban-file=**_b.**'
  ]

  if (settings.adminApiKey) {
    uploadArguments.push(`--admin-api-key=${settings.adminApiKey}`)
  }

  for (const tag of tags) {
    uploadArguments.push(`--tag=${tag}`)
  }

  uploadArguments.push(directoryPath)
  return uploadArguments
}

const appendBoundedOutput = (currentOutput, chunk) => {
  const nextOutput = currentOutput + chunk.toString()
  return nextOutput.length > maxImmichOutputLength
    ? nextOutput.slice(nextOutput.length - maxImmichOutputLength)
    : nextOutput
}

const redactImmichSecrets = (output, settings) => {
  return [settings.userApiKey, settings.adminApiKey]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .reduce((redactedOutput, secret) => redactedOutput.split(secret).join('[REDACTED]'), output)
}

const runImmichUpload = async (settings, directoryPath, reportProgress = () => {}) => {
  if (isImmichUploadRunning) {
    throw new Error('An Immich upload is already running.')
  }

  isImmichUploadRunning = true

  try {
    const normalizedDirectoryPath = String(directoryPath ?? '').trim()
    if (!normalizedDirectoryPath) {
      throw new Error('Load an image directory before uploading.')
    }

    const directoryStats = await fs.stat(normalizedDirectoryPath)
    if (!directoryStats.isDirectory()) {
      throw new Error('The selected upload path is not a directory.')
    }

    const normalizedSettings = normalizeImmichSettings(settings)
    const uploadArguments = buildImmichUploadArguments(normalizedSettings, normalizedDirectoryPath)

    return await new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      const uploadProcess = spawn('immich-go', uploadArguments, {
        cwd: normalizedDirectoryPath,
        shell: false,
        windowsHide: true,
      })

      reportProgress({ phase: 'uploading', output: '' })

      uploadProcess.stdout.on('data', (chunk) => {
        stdout = appendBoundedOutput(stdout, chunk)
        reportProgress({
          phase: 'uploading',
          output: redactImmichSecrets(chunk.toString(), normalizedSettings),
        })
      })
      uploadProcess.stderr.on('data', (chunk) => {
        stderr = appendBoundedOutput(stderr, chunk)
        reportProgress({
          phase: 'uploading',
          output: redactImmichSecrets(chunk.toString(), normalizedSettings),
        })
      })
      uploadProcess.on('error', (error) => {
        reject(
          error?.code === 'ENOENT'
            ? new Error('immich-go was not found. Confirm it is installed and available on PATH.')
            : error,
        )
      })
      uploadProcess.on('close', (exitCode) => {
        const combinedOutput = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
        resolve({
          ok: exitCode === 0,
          exitCode: exitCode ?? -1,
          output: redactImmichSecrets(combinedOutput, normalizedSettings),
        })
      })
    })
  } finally {
    isImmichUploadRunning = false
  }
}

const normalizeDateValue = (value) => {
  if (!value) {
    return new Date().toISOString().slice(0, 19).replace('T', ' ')
  }

  const date = new Date(value)
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString().slice(0, 19).replace('T', ' ')
  }

  return value
}

const normalizeXmpDate = (value) => {
  const rawValue = String(value ?? '').trim()
  if (!rawValue) {
    return ''
  }

  const isoLike = rawValue.includes('T') ? rawValue : rawValue.replace(' ', 'T')
  const matched = isoLike.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/)
  if (matched) {
    return `${matched[1]}-${matched[2]}-${matched[3]}T${matched[4]}:${matched[5]}:${matched[6]}`
  }

  const date = new Date(rawValue)
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString().slice(0, 19)
  }

  return rawValue
}

const normalizeExifDate = (value) => {
  const normalizedDate = normalizeXmpDate(value)
  const matched = normalizedDate.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/,
  )

  if (!matched) {
    throw new Error('Enter a valid date before saving image metadata.')
  }

  return `${matched[1]}:${matched[2]}:${matched[3]} ${matched[4]}:${matched[5]}:${matched[6]}`
}

const escapeXml = (value = '') =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

const unescapeXml = (value = '') =>
  String(value)
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')

const normalizeTags = (values) => {
  const tags = Array.isArray(values) ? values : []
  const uniqueTagsByName = new Map()

  for (const value of tags) {
    const tag = String(value ?? '').trim()
    const normalizedName = tag.toLocaleLowerCase()
    if (tag && !uniqueTagsByName.has(normalizedName)) {
      uniqueTagsByName.set(normalizedName, tag)
    }
  }

  return Array.from(uniqueTagsByName.values())
}

const readTagsFromXmp = (rawXml) => {
  const tagsListMatch = String(rawXml).match(
    /<digiKam:TagsList[^>]*>([\s\S]*?)<\/digiKam:TagsList>/i,
  )
  if (!tagsListMatch) {
    return []
  }

  return normalizeTags(
    Array.from(tagsListMatch[1].matchAll(/<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/gi))
      .map((match) => unescapeXml(match[1].trim())),
  )
}

const normalizeRotationValue = (value) => {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) {
    return 0
  }

  const roundedQuarterTurns = Math.round(numericValue / 90)
  const normalizedRotation = ((roundedQuarterTurns % 4) + 4) % 4
  return normalizedRotation * 90
}

const clockwiseOrientationByOrientation = Object.freeze({
  1: 6,
  2: 7,
  3: 8,
  4: 5,
  5: 2,
  6: 3,
  7: 4,
  8: 1,
})

const composeExifOrientation = (orientation, rotation) => {
  let composedOrientation = Number.isInteger(Number(orientation)) ? Number(orientation) : 1
  if (composedOrientation < 1 || composedOrientation > 8) {
    composedOrientation = 1
  }

  const quarterTurns = normalizeRotationValue(rotation) / 90
  for (let turn = 0; turn < quarterTurns; turn += 1) {
    composedOrientation = clockwiseOrientationByOrientation[composedOrientation]
  }

  return composedOrientation
}

const buildSidecarPath = (filePath) => {
  return `${filePath}.xmp`
}

const buildLegacySidecarPath = (filePath) => {
  const extension = path.extname(filePath)
  return filePath.slice(0, filePath.length - extension.length) + '.xmp'
}

const getSidecarCandidatePaths = (filePath) => {
  return [buildSidecarPath(filePath), buildLegacySidecarPath(filePath)].filter(
    (candidatePath, index, candidates) => candidates.indexOf(candidatePath) === index,
  )
}

const resolveExistingSidecarPath = async (filePath) => {
  for (const sidecarPath of getSidecarCandidatePaths(filePath)) {
    try {
      await fs.access(sidecarPath)
      return sidecarPath
    } catch {
      // Try the next supported sidecar naming convention.
    }
  }

  return null
}

const getStem = (fileName) => fileName.replace(/\.[^.]+$/, '')

const getGroupKey = (fileName) => {
  const stem = getStem(fileName)
  const normalizedStem = stem.replace(/[_-](?:a|b|front|back)$/i, '')
  return normalizedStem.toLowerCase()
}

const getSideFromFileName = (fileName) => {
  const stem = getStem(fileName)
  const match = stem.match(/[_-]((?:a|front))$/i) || stem.match(/[_-]((?:b|back))$/i)
  if (!match) {
    return 'front'
  }

  const side = match[1].toLowerCase()
  return side === 'front' || side === 'a' ? 'a' : 'b'
}

const sortPairs = (pairs, sortBy) => {
  if (sortBy === 'fileName') {
    return pairs.sort((left, right) => left.imageLabel.localeCompare(right.imageLabel))
  }

  return pairs.sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt - right.createdAt
    }

    return left.imageLabel.localeCompare(right.imageLabel)
  })
}

const pairFiles = async (filePaths, sortBy = defaultSortBy) => {
  const grouped = new Map()

  for (const filePath of filePaths) {
    const fileName = path.basename(filePath)
    const key = getGroupKey(fileName)
    const group = grouped.get(key) ?? []
    group.push({
      filePath,
      fileName,
      side: getSideFromFileName(fileName),
    })
    grouped.set(key, group)
  }

  const pairs = await Promise.all(
    Array.from(grouped.values()).map(async (items) => {
      const frontCandidate = items.find((item) => item.side === 'a') ?? items[0]
      const backCandidate = items.find((item) => item.side === 'b') ?? null
      const frontStats = await fs.stat(frontCandidate.filePath)

      return {
        id: `${getGroupKey(frontCandidate.fileName)}-${frontCandidate.fileName}`,
        imageLabel: frontCandidate.fileName,
        frontPath: frontCandidate.filePath,
        backPath: backCandidate ? backCandidate.filePath : null,
        createdAt: frontStats.birthtimeMs || frontStats.ctimeMs || frontStats.mtimeMs,
      }
    }),
  )

  return sortPairs(pairs, sortBy)
}

const buildSidecarDocument = ({ dateValue, description, tags }) => {
  const xmpDate = normalizeXmpDate(dateValue) || new Date().toISOString().slice(0, 19)
  const safeDescription = String(description ?? '').trim()
  const safeTags = normalizeTags(tags)

  const descriptionBlock = safeDescription
    ? ` <rdf:Description rdf:about=''
  xmlns:dc='http://purl.org/dc/elements/1.1/'>
  <dc:description>
   <rdf:Alt>
    <rdf:li xml:lang='x-default'>${escapeXml(safeDescription)}</rdf:li>
   </rdf:Alt>
  </dc:description>
 </rdf:Description>`
    : ''

  const tagsBlock = safeTags.length
    ? ` <rdf:Description rdf:about=''
  xmlns:digiKam='http://www.digikam.org/ns/1.0/'>
  <digiKam:TagsList>
   <rdf:Seq>
${safeTags.map((tag) => `    <rdf:li>${escapeXml(tag)}</rdf:li>`).join('\n')}
   </rdf:Seq>
  </digiKam:TagsList>
 </rdf:Description>`
    : ''

  const exifBlock = ` <rdf:Description rdf:about=''
  xmlns:exif='http://ns.adobe.com/exif/1.0/'>
  <exif:DateTimeOriginal>${escapeXml(xmpDate)}</exif:DateTimeOriginal>
 </rdf:Description>`

  const photoshopBlock = ` <rdf:Description rdf:about=''
  xmlns:photoshop='http://ns.adobe.com/photoshop/1.0/'>
  <photoshop:DateCreated>${escapeXml(xmpDate)}</photoshop:DateCreated>
 </rdf:Description>`

  const xmpBlock = ` <rdf:Description rdf:about=''
  xmlns:xmp='http://ns.adobe.com/xap/1.0/'>
  <xmp:SubSecCreateDate>${escapeXml(xmpDate)}</xmp:SubSecCreateDate>
  <xmp:CreateDate>${escapeXml(xmpDate)}</xmp:CreateDate>
  <xmp:ModifyDate>${escapeXml(xmpDate)}</xmp:ModifyDate>
 </rdf:Description>`

  const blocks = [
    descriptionBlock,
    tagsBlock,
    exifBlock,
    photoshopBlock,
    xmpBlock,
  ].filter(Boolean).join('\n\n')

  return `<?xpacket begin='\uFEFF' id='W5M0MpCehiHzreSzNTczkc9d'?>
<x:xmpmeta xmlns:x='adobe:ns:meta/' x:xmptk='Image::ExifTool 13.59'>
<rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>

${blocks}
</rdf:RDF>
</x:xmpmeta>
<?xpacket end='w'?>`
}

const readSidecarMetadata = async (filePath) => {
  const sidecarPath = await resolveExistingSidecarPath(filePath)
  if (!sidecarPath) {
    return {
      date: '',
      description: '',
      tags: [],
      rotation: 0,
    }
  }

  try {
    const xml = await fs.readFile(sidecarPath, 'utf8')
    const rawXml = String(xml)

    const getTagValue = (...patterns) => {
      for (const pattern of patterns) {
        const match = rawXml.match(pattern)
        if (match?.[1]) {
          return match[1].trim()
        }
      }
      return ''
    }

    const date = getTagValue(
      /<xmp:SubSecCreateDate[^>]*>([\s\S]*?)<\/xmp:SubSecCreateDate>/i,
      /<xmp:CreateDate[^>]*>([\s\S]*?)<\/xmp:CreateDate>/i,
      /<exif:DateTimeOriginal[^>]*>([\s\S]*?)<\/exif:DateTimeOriginal>/i,
      /<photoshop:DateCreated[^>]*>([\s\S]*?)<\/photoshop:DateCreated>/i,
    )

    const description = getTagValue(
      /<rdf:li[^>]*xml:lang="x-default"[^>]*>([\s\S]*?)<\/rdf:li>/i,
      /<dc:description[^>]*>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>[\s\S]*?<\/dc:description>/i,
    )

    return {
      date: date ? date.slice(0, 10) : '',
      description,
      tags: readTagsFromXmp(rawXml),
      rotation: 0,
    }
  } catch {
    return {
      date: '',
      description: '',
      tags: [],
      rotation: 0,
    }
  }
}

const writeSidecarFile = async (filePath, dateValue, description, tags) => {
  const sidecarPath = (await resolveExistingSidecarPath(filePath)) ?? buildSidecarPath(filePath)
  const xml = buildSidecarDocument({
    dateValue,
    description,
    tags,
  })

  await fs.writeFile(sidecarPath, xml, 'utf8')
}

const readRecentTags = async (directoryPath) => {
  const directoryEntries = await fs.readdir(directoryPath, { withFileTypes: true })
  const sidecarPaths = directoryEntries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.xmp')
    .map((entry) => path.join(directoryPath, entry.name))
  const sidecarsByRecency = await Promise.all(
    sidecarPaths.map(async (sidecarPath) => ({
      sidecarPath,
      modifiedAt: (await fs.stat(sidecarPath)).mtimeMs,
    })),
  )
  sidecarsByRecency.sort((left, right) => right.modifiedAt - left.modifiedAt)

  const recentTags = []
  for (const { sidecarPath } of sidecarsByRecency) {
    try {
      recentTags.push(...readTagsFromXmp(await fs.readFile(sidecarPath, 'utf8')))
    } catch {
      // Ignore unreadable sidecars while collecting optional tag suggestions.
    }
  }

  return normalizeTags(recentTags)
}

const writeEmbeddedImageDate = async (filePath, dateValue) => {
  const extension = path.extname(filePath).toLowerCase()
  if (!allowedExtensions.has(extension)) {
    throw new Error(`Embedded metadata is not supported for ${extension || 'this file type'}.`)
  }

  const exifDate = normalizeExifDate(dateValue)
  const result = await exiftool.write(
    filePath,
    {
      'EXIF:CreateDate': exifDate,
      'EXIF:DateTimeOriginal': exifDate,
      SubSecTimeOriginal: 0,
    },
    { writeArgs: ['-overwrite_original'] },
  )

  if (result.updated !== 1 && result.unchanged !== 1) {
    throw new Error(`ExifTool did not update the created date for ${path.basename(filePath)}.`)
  }
}

const rotateImageMetadata = async (filePath, rotation) => {
  const tags = await exiftool.read(filePath)
  const orientation = composeExifOrientation(tags.Orientation, rotation)
  const result = await exiftool.write(
    filePath,
    { 'Orientation#': orientation },
    { writeArgs: ['-overwrite_original'] },
  )

  if (result.updated !== 1 && result.unchanged !== 1) {
    throw new Error(`ExifTool did not update the orientation for ${path.basename(filePath)}.`)
  }
}

const rotateImagePixels = async (filePath, rotation) => {
  const extension = path.extname(filePath).toLowerCase()
  const fileStats = await fs.stat(filePath)
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath, extension)}.imageparser-${randomUUID()}${extension}`,
  )

  try {
    const sourceBuffer = await fs.readFile(filePath)
    await sharp(sourceBuffer)
      .autoOrient()
      .rotate(rotation)
      .withMetadata({ orientation: 1 })
      .toFile(temporaryPath)
    await fs.chmod(temporaryPath, fileStats.mode)
    await fs.rename(temporaryPath, filePath)
    await fs.utimes(filePath, fileStats.atime, fileStats.mtime)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
}

const applyImageRotation = async (filePath, rotation) => {
  const normalizedRotation = normalizeRotationValue(rotation)
  if (!normalizedRotation) {
    return false
  }

  const extension = path.extname(filePath).toLowerCase()
  if (!allowedExtensions.has(extension)) {
    throw new Error(`Unsupported image format: ${extension || 'unknown'}.`)
  }

  if (metadataRotationExtensions.has(extension)) {
    await rotateImageMetadata(filePath, normalizedRotation)
  } else if (pixelRotationExtensions.has(extension)) {
    await rotateImagePixels(filePath, normalizedRotation)
  } else {
    throw new Error(`Rotation is not supported for ${extension || 'this file type'}.`)
  }

  imageRevisionByPath.set(filePath, (imageRevisionByPath.get(filePath) ?? 0) + 1)
  return true
}

const applyImageRotations = async (request) => {
  const rotations = [
    { field: 'front', filePath: String(request?.frontPath ?? ''), rotation: request?.frontRotation },
    { field: 'back', filePath: String(request?.backPath ?? ''), rotation: request?.backRotation },
  ].filter(({ filePath, rotation }) => filePath && normalizeRotationValue(rotation) !== 0)

  const results = await Promise.all(
    rotations.map(async ({ field, filePath, rotation }) => {
      try {
        await applyImageRotation(filePath, rotation)
        return { field, filePath, ok: true }
      } catch (error) {
        return {
          field,
          filePath,
          ok: false,
          error: error instanceof Error ? error.message : 'Unable to apply image rotation.',
        }
      }
    }),
  )

  return {
    ok: results.every((result) => result.ok),
    updatedFiles: results.filter((result) => result.ok).length,
    results,
  }
}

const getPreviewDataUrl = async (filePath, rotation = 0) => {
  if (!filePath) {
    return ''
  }

  const extension = path.extname(filePath).toLowerCase()
  const normalizedRotation = normalizeRotationValue(rotation)

  if (normalizedRotation === 0 && !['.tif', '.tiff'].includes(extension)) {
    const fileUrl = pathToFileURL(filePath)
    fileUrl.searchParams.set('imageParserRevision', String(imageRevisionByPath.get(filePath) ?? 0))
    return fileUrl.href
  }

  try {
    let image = sharp(filePath).autoOrient()
    if (normalizedRotation) {
      image = image.rotate(normalizedRotation)
    }
    const pngBuffer = await image.png().toBuffer()
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
  void exiftool.end()
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

ipcMain.handle('read-directory', async (_event, directoryPath, sortBy = defaultSortBy) => {
  if (!directoryPath) {
    return { directoryPath, files: [], recentTags: [] }
  }

  const directoryEntries = await fs.readdir(directoryPath, { withFileTypes: true })
  const imageFiles = directoryEntries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.join(directoryPath, entry.name))
    .filter((filePath) => allowedExtensions.has(path.extname(filePath).toLowerCase()))

  return {
    directoryPath,
    files: await pairFiles(imageFiles, sortBy),
    recentTags: await readRecentTags(directoryPath),
  }
})

ipcMain.handle('save-metadata', (_event, metadata) => runImageFileOperation(async () => {
  if (!metadata?.frontPath) {
    throw new Error('No image selected for metadata update.')
  }

  const dateValue = normalizeDateValue(metadata.date)

  await writeSidecarFile(
    metadata.frontPath,
    dateValue,
    metadata.description,
    metadata.tags,
  )

  const imagePaths = [metadata.frontPath, metadata.backPath].filter(Boolean)
  await Promise.all(imagePaths.map((filePath) => writeEmbeddedImageDate(filePath, dateValue)))

  return {
    ok: true,
    updatedFiles: imagePaths.length,
    sidecarFile: (await resolveExistingSidecarPath(metadata.frontPath)) ?? buildSidecarPath(metadata.frontPath),
  }
}))

ipcMain.handle('read-sidecar-metadata', async (_event, filePath) => {
  if (!filePath) {
    return {
      date: '',
      description: '',
      tags: [],
      rotation: 0,
    }
  }

  return readSidecarMetadata(filePath)
})

ipcMain.handle('get-preview-data-url', (_event, filePath, rotation) =>
  runImageFileOperation(() => getPreviewDataUrl(filePath, rotation)))

ipcMain.handle('apply-image-rotations', (_event, request) =>
  runImageFileOperation(() => applyImageRotations(request)))

ipcMain.handle('load-immich-settings', async () => {
  return loadImmichSettings()
})

ipcMain.handle('save-immich-settings', async (_event, settings) => {
  return saveImmichSettings(settings)
})

ipcMain.handle('upload-to-immich', async (_event, settings, directoryPath) => {
  const reportProgress = (progress) => {
    if (!_event.sender.isDestroyed()) {
      _event.sender.send('immich-upload-progress', progress)
    }
  }

  return runImmichUpload(settings, directoryPath, reportProgress)
})
