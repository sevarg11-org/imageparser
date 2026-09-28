import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import './App.css'
import {
  completeDateSegment,
  parseDateSegments,
  toIsoDate,
  type DateSegments,
} from './dateEntry'

type ImagePair = {
  id: string
  imageLabel: string
  frontPath: string
  backPath: string | null
  createdAt: number
}

type SortOption = 'createdAt' | 'fileName'

type MetadataForm = {
  date: string
  description: string
  tags: string[]
}

type RotationField = 'front' | 'back'

type PairRotationState = {
  front: number
  back: number
}

type ImmichSettings = {
  serverUrl: string
  userApiKey: string
  adminApiKey: string
  albumName: string
  tags: string
  pauseImmichJobs: boolean
  concurrentTasks: number
}

type ImmichUploadResult = {
  ok: boolean
  exitCode: number
  output: string
}

type ImmichUploadProgress = {
  phase: 'uploading'
  output: string
}

type ImageRotationResult = {
  field: RotationField
  filePath: string
  ok: boolean
  error?: string
}

type ApplyImageRotationsResult = {
  ok: boolean
  updatedFiles: number
  results: ImageRotationResult[]
}

declare global {
  interface Window {
    electronAPI?: {
      chooseDirectory: () => Promise<string | null>
      readDirectory: (
        directoryPath: string,
        sortBy: SortOption,
      ) => Promise<{ directoryPath: string; files: ImagePair[]; recentTags: string[] }>
      readSidecarMetadata: (filePath: string) => Promise<{
        date: string
        description: string
        tags: string[]
        rotation: number
      }>
      saveMetadata: (metadata: {
        frontPath: string
        backPath: string | null
        date: string
        description: string
        tags: string[]
        frontRotation: number
        backRotation: number
      }) => Promise<{ ok: boolean; updatedFiles: number; sidecarFile: string }>
      getPreviewDataUrl: (filePath: string, rotation: number) => Promise<string>
      applyImageRotations: (request: {
        frontPath: string
        backPath: string | null
        frontRotation: number
        backRotation: number
      }) => Promise<ApplyImageRotationsResult>
      loadImmichSettings: () => Promise<ImmichSettings>
      saveImmichSettings: (settings: ImmichSettings) => Promise<ImmichSettings>
      uploadToImmich: (
        settings: ImmichSettings,
        directoryPath: string,
      ) => Promise<ImmichUploadResult>
      onImmichUploadProgress: (
        listener: (progress: ImmichUploadProgress) => void,
      ) => () => void
    }
  }
}

const normalizeRotation = (value: number) => ((Math.round(value / 90) % 4) + 4) % 4 * 90

const formatElapsedTime = (elapsedSeconds: number) => {
  const minutes = Math.floor(elapsedSeconds / 60)
  const seconds = elapsedSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, '0')}s` : `${seconds}s`
}

const useResolvedPreviewSrc = (filePath: string, rotation: number) => {
  const [src, setSrc] = useState('')

  useEffect(() => {
    let isActive = true

    const resolvePreviewUrl = async () => {
      if (!filePath) {
        setSrc('')
        return
      }

      if (!window.electronAPI) {
        setSrc(toFileUrl(filePath))
        return
      }

      try {
        const previewUrl = await window.electronAPI.getPreviewDataUrl(filePath, rotation)
        if (isActive) {
          setSrc(previewUrl || toFileUrl(filePath))
        }
      } catch {
        if (isActive) {
          setSrc(toFileUrl(filePath))
        }
      }
    }

    void resolvePreviewUrl()

    return () => {
      isActive = false
    }
  }, [filePath, rotation])

  return src
}

const MAGNIFIER_LENS_SIZE = 160
const MAGNIFIER_ZOOM = 2.5
const MAGNIFIER_EDGE_BUFFER = 32

const MagnifiedImage = ({
  filePath,
  altText,
  rotation,
}: {
  filePath: string
  altText: string
  rotation: number
}) => {
  const src = useResolvedPreviewSrc(filePath, rotation)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [lensStyle, setLensStyle] = useState<{
    left: number
    top: number
    backgroundSize: string
    backgroundPosition: string
  } | null>(null)

  const handleMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    const container = containerRef.current
    const image = imageRef.current
    if (!container || !image || !src) {
      return
    }

    const containerRect = container.getBoundingClientRect()
    const imageRect = image.getBoundingClientRect()
    if (imageRect.width === 0 || imageRect.height === 0) {
      return
    }

    const imageX = event.clientX - imageRect.left
    const imageY = event.clientY - imageRect.top
    const isOutsideImage =
      imageX < -MAGNIFIER_EDGE_BUFFER ||
      imageX > imageRect.width + MAGNIFIER_EDGE_BUFFER ||
      imageY < -MAGNIFIER_EDGE_BUFFER ||
      imageY > imageRect.height + MAGNIFIER_EDGE_BUFFER
    if (isOutsideImage) {
      setLensStyle(null)
      return
    }

    const halfLens = MAGNIFIER_LENS_SIZE / 2
    const pointerX = event.clientX - containerRect.left
    const pointerY = event.clientY - containerRect.top
    const imageLeft = imageRect.left - containerRect.left
    const imageTop = imageRect.top - containerRect.top
    const hoverLeft = imageLeft - MAGNIFIER_EDGE_BUFFER
    const hoverTop = imageTop - MAGNIFIER_EDGE_BUFFER
    const hoverWidth = imageRect.width + MAGNIFIER_EDGE_BUFFER * 2
    const hoverHeight = imageRect.height + MAGNIFIER_EDGE_BUFFER * 2
    const sampledImageX = Math.min(Math.max(imageX, 0), imageRect.width)
    const sampledImageY = Math.min(Math.max(imageY, 0), imageRect.height)
    const lensLeft =
      hoverWidth >= MAGNIFIER_LENS_SIZE
        ? Math.min(
            Math.max(pointerX - halfLens, hoverLeft),
            hoverLeft + hoverWidth - MAGNIFIER_LENS_SIZE,
          )
        : hoverLeft + (hoverWidth - MAGNIFIER_LENS_SIZE) / 2
    const lensTop =
      hoverHeight >= MAGNIFIER_LENS_SIZE
        ? Math.min(
            Math.max(pointerY - halfLens, hoverTop),
            hoverTop + hoverHeight - MAGNIFIER_LENS_SIZE,
          )
        : hoverTop + (hoverHeight - MAGNIFIER_LENS_SIZE) / 2

    setLensStyle({
      left: lensLeft,
      top: lensTop,
      backgroundSize: `${imageRect.width * MAGNIFIER_ZOOM}px ${imageRect.height * MAGNIFIER_ZOOM}px`,
      backgroundPosition: `${pointerX - lensLeft - sampledImageX * MAGNIFIER_ZOOM}px ${
        pointerY - lensTop - sampledImageY * MAGNIFIER_ZOOM
      }px`,
    })
  }

  return (
    <div
      className="magnifier-container"
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setLensStyle(null)}
    >
      <img ref={imageRef} src={src} alt={altText} />
      {lensStyle && src ? (
        <div
          className="magnifier-lens"
          style={{
            left: lensStyle.left,
            top: lensStyle.top,
            width: MAGNIFIER_LENS_SIZE,
            height: MAGNIFIER_LENS_SIZE,
            backgroundImage: `url(${src})`,
            backgroundRepeat: 'no-repeat',
            backgroundSize: lensStyle.backgroundSize,
            backgroundPosition: lensStyle.backgroundPosition,
          }}
        />
      ) : null}
    </div>
  )
}

const toFileUrl = (filePath: string) => {
  if (!filePath) {
    return ''
  }

  const normalizedPath = filePath.replace(/\\/g, '/')
  const encodedPath = encodeURI(normalizedPath)

  if (/^([a-zA-Z]:)/.test(normalizedPath)) {
    return `file:///${encodedPath}`
  }

  return `file://${normalizedPath.startsWith('/') ? '' : '/'}${encodedPath}`
}

const defaultDate = new Date().toISOString().slice(0, 10)
const METADATA_ENTRY_SESSION_KEY = 'imageparser.metadata-entry-expanded'
const defaultImmichSettings: ImmichSettings = {
  serverUrl: '',
  userApiKey: '',
  adminApiKey: '',
  albumName: '',
  tags: '',
  pauseImmichJobs: true,
  concurrentTasks: 2,
}

function App() {
  const [directoryPath, setDirectoryPath] = useState('')
  const [pairs, setPairs] = useState<ImagePair[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [imageNumberInput, setImageNumberInput] = useState('1')
  const [sortBy, setSortBy] = useState<SortOption>('createdAt')
  const [metadata, setMetadata] = useState<MetadataForm>({
    date: defaultDate,
    description: '',
    tags: [],
  })
  const [dateSegments, setDateSegments] = useState(() => parseDateSegments(defaultDate))
  const [isMetadataEntryExpanded, setIsMetadataEntryExpanded] = useState(() => {
    if (typeof window === 'undefined') {
      return false
    }
    return window.sessionStorage.getItem(METADATA_ENTRY_SESSION_KEY) === 'true'
  })
  const [tagInput, setTagInput] = useState('')
  const [recentTags, setRecentTags] = useState<string[]>([])
  const [status, setStatus] = useState('Choose a directory to begin reviewing images.')
  const [isBusy, setIsBusy] = useState(false)
  const [isHydrated, setIsHydrated] = useState(false)
  const [rotations, setRotations] = useState<PairRotationState>({ front: 0, back: 0 })
  const [isPersistingRotation, setIsPersistingRotation] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const [immichSettings, setImmichSettings] = useState<ImmichSettings>(defaultImmichSettings)
  const [immichStatus, setImmichStatus] = useState('Immich settings are saved when an upload starts.')
  const [immichOutput, setImmichOutput] = useState('')
  const [isUploading, setIsUploading] = useState(false)
  const [uploadElapsedSeconds, setUploadElapsedSeconds] = useState(0)
  const hasUserChangedRef = useRef(false)
  const dateInputRef = useRef<HTMLInputElement | null>(null)
  const dayInputRef = useRef<HTMLInputElement | null>(null)
  const yearInputRef = useRef<HTMLInputElement | null>(null)
  const dateSegmentsRef = useRef(dateSegments)
  const descriptionInputRef = useRef<HTMLInputElement | null>(null)
  const tagInputRef = useRef<HTMLInputElement | null>(null)
  const immichOutputRef = useRef<HTMLPreElement | null>(null)
  const isImmichOutputFollowingRef = useRef(true)
  const saveTimeoutRef = useRef<number | null>(null)
  const pendingPersistenceRef = useRef<Promise<boolean> | null>(null)

  const selectedPair = useMemo(
    () => (pairs[selectedIndex] ? pairs[selectedIndex] : null),
    [pairs, selectedIndex],
  )

  useEffect(() => {
    const electronApi = window.electronAPI
    if (!electronApi) {
      return
    }

    let isMounted = true

    const hydrateImmichSettings = async () => {
      try {
        const savedSettings = await electronApi.loadImmichSettings()
        if (isMounted) {
          setImmichSettings(savedSettings)
        }
      } catch (error) {
        if (isMounted) {
          setImmichStatus(
            error instanceof Error ? error.message : 'Unable to load the saved Immich settings.',
          )
        }
      }
    }

    void hydrateImmichSettings()
    return () => {
      isMounted = false
    }
  }, [])

  useEffect(() => {
    window.sessionStorage.setItem(
      METADATA_ENTRY_SESSION_KEY,
      String(isMetadataEntryExpanded),
    )
  }, [isMetadataEntryExpanded])

  useEffect(() => {
    const electronApi = window.electronAPI
    if (!electronApi) {
      return
    }

    return electronApi.onImmichUploadProgress((progress) => {
      setImmichOutput(progress.output)
      setImmichStatus('Immich is processing the selected directory...')
    })
  }, [])

  useEffect(() => {
    if (!isUploading) {
      return
    }

    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      setUploadElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)

    return () => window.clearInterval(timer)
  }, [isUploading])

  useEffect(() => {
    const outputElement = immichOutputRef.current
    if (outputElement && isImmichOutputFollowingRef.current) {
      outputElement.scrollTop = outputElement.scrollHeight
    }
  }, [immichOutput])

  const toggleExpanded = useCallback(() => {
    setIsExpanded((current) => !current)
  }, [])

  const clearPendingSave = useCallback(() => {
    if (saveTimeoutRef.current !== null) {
      window.clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }
  }, [])

  const savePairMetadata = useCallback(async (pair: ImagePair, formValues: MetadataForm) => {
    const electronApi = window.electronAPI
    if (!electronApi) {
      throw new Error('This application must run inside Electron.')
    }

    const result = await electronApi.saveMetadata({
      frontPath: pair.frontPath,
      backPath: pair.backPath,
      date: formValues.date,
      description: formValues.description,
      tags: formValues.tags,
      frontRotation: rotations.front,
      backRotation: rotations.back,
    })

    setStatus(
      `Saved embedded date metadata to ${result.updatedFiles} image${
        result.updatedFiles === 1 ? '' : 's'
      } and sidecar: ${result.sidecarFile}`,
    )
    hasUserChangedRef.current = false
  }, [rotations])

  const persistCurrentPair = useCallback((formValues: MetadataForm = metadata) => {
    if (pendingPersistenceRef.current) {
      return pendingPersistenceRef.current
    }

    const operation = (async () => {
      if (!selectedPair) {
        return true
      }

      if (!toIsoDate(dateSegmentsRef.current)) {
        setStatus('Enter a valid month, day, and year before saving.')
        return false
      }

      const electronApi = window.electronAPI
      if (!electronApi) {
        setStatus('This application must run inside Electron.')
        return false
      }

      const rotationSnapshot = { ...rotations }
      setIsPersistingRotation(true)
      clearPendingSave()

      try {
        await savePairMetadata(selectedPair, formValues)

        if (rotationSnapshot.front === 0 && rotationSnapshot.back === 0) {
          return true
        }

        setStatus(`Applying rotation to ${selectedPair.imageLabel}...`)
        const result = await electronApi.applyImageRotations({
          frontPath: selectedPair.frontPath,
          backPath: selectedPair.backPath,
          frontRotation: rotationSnapshot.front,
          backRotation: rotationSnapshot.back,
        })
        const remainingRotations = { ...rotationSnapshot }

        for (const imageResult of result.results) {
          if (imageResult.ok) {
            remainingRotations[imageResult.field] = 0
          }
        }

        setRotations(remainingRotations)
        const failures = result.results.filter((imageResult) => !imageResult.ok)
        hasUserChangedRef.current =
          remainingRotations.front !== 0 || remainingRotations.back !== 0

        if (failures.length) {
          setStatus(failures.map((failure) => failure.error).filter(Boolean).join(' '))
          return false
        }

        setStatus(
          `Applied rotation to ${result.updatedFiles} image${
            result.updatedFiles === 1 ? '' : 's'
          } in ${selectedPair.imageLabel}.`,
        )
        return result.ok
      } catch (error) {
        hasUserChangedRef.current =
          rotationSnapshot.front !== 0 || rotationSnapshot.back !== 0
        setStatus(error instanceof Error ? error.message : 'Unable to persist image rotation.')
        return false
      } finally {
        setIsPersistingRotation(false)
      }
    })()

    pendingPersistenceRef.current = operation
    void operation.finally(() => {
      if (pendingPersistenceRef.current === operation) {
        pendingPersistenceRef.current = null
      }
    })
    return operation
  }, [clearPendingSave, metadata, rotations, savePairMetadata, selectedPair])

  const navigateToIndex = useCallback(async (nextIndex: number, formValues?: MetadataForm) => {
    const boundedIndex = Math.min(Math.max(nextIndex, 0), pairs.length - 1)
    if (boundedIndex === selectedIndex || isUploading || !isHydrated) {
      return
    }

    if (!(await persistCurrentPair(formValues))) {
      return
    }

    setIsHydrated(false)
    setImageNumberInput(String(boundedIndex + 1))
    setSelectedIndex(boundedIndex)
  }, [isHydrated, isUploading, pairs.length, persistCurrentPair, selectedIndex])

  useEffect(() => {
    const electronApi = window.electronAPI
    if (!selectedPair || !electronApi) {
      return
    }

    let isMounted = true

    const loadMetadataFromSidecar = async () => {
      try {
        const [frontXmpValues, backXmpValues] = await Promise.all([
          electronApi.readSidecarMetadata(selectedPair.frontPath),
          selectedPair.backPath
            ? electronApi.readSidecarMetadata(selectedPair.backPath)
            : Promise.resolve(null),
        ])

        if (!isMounted) {
          return
        }

        hasUserChangedRef.current = false
        const loadedDate = frontXmpValues.date ? frontXmpValues.date.slice(0, 10) : defaultDate
        setMetadata({
          date: loadedDate,
          description: frontXmpValues.description ?? '',
          tags: frontXmpValues.tags ?? [],
        })
        const loadedSegments = parseDateSegments(loadedDate)
        dateSegmentsRef.current = loadedSegments
        setDateSegments(loadedSegments)
        setRecentTags((current) => [
          ...(frontXmpValues.tags ?? []),
          ...current.filter(
            (tag) =>
              (frontXmpValues.tags ?? []).some(
                (loadedTag) => loadedTag.toLocaleLowerCase() === tag.toLocaleLowerCase(),
              ) === false,
          ),
        ])
        setTagInput('')
        setRotations({
          front: normalizeRotation(frontXmpValues.rotation ?? 0),
          back: normalizeRotation(backXmpValues?.rotation ?? 0),
        })
        setIsHydrated(true)
        setStatus(`Loaded metadata from the sidecar for ${selectedPair.imageLabel}.`)
      } catch {
        if (!isMounted) {
          return
        }

        hasUserChangedRef.current = false
        setMetadata({
          date: defaultDate,
          description: '',
          tags: [],
        })
        const defaultSegments = parseDateSegments(defaultDate)
        dateSegmentsRef.current = defaultSegments
        setDateSegments(defaultSegments)
        setTagInput('')
        setRotations({ front: 0, back: 0 })
        setIsHydrated(true)
        setStatus(`No sidecar metadata found for ${selectedPair.imageLabel}.`)
      }
    }

    void loadMetadataFromSidecar()

    return () => {
      isMounted = false
    }
  }, [selectedPair])

  useEffect(() => {
    const electronApi = window.electronAPI
    if (!selectedPair || !electronApi || !isHydrated) {
      clearPendingSave()
      hasUserChangedRef.current = false
      return
    }

    if (!hasUserChangedRef.current) {
      return
    }

    clearPendingSave()
    if (!toIsoDate(dateSegmentsRef.current)) {
      return
    }
    saveTimeoutRef.current = window.setTimeout(async () => {
      try {
        await savePairMetadata(selectedPair, metadata)
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Unable to save the metadata.')
      } finally {
        saveTimeoutRef.current = null
      }
    }, 350)

    return () => {
      clearPendingSave()
    }
  }, [clearPendingSave, selectedPair, metadata, isHydrated, savePairMetadata])

  useEffect(() => {
    if (!selectedPair || !isHydrated) {
      return
    }

    const frameId = window.requestAnimationFrame(() => {
      dateInputRef.current?.focus()
      dateInputRef.current?.select()
    })

    return () => {
      window.cancelAnimationFrame(frameId)
    }
  }, [isHydrated, selectedPair])

  const rotateImage = useCallback((field: RotationField, delta: number) => {
    if (isPersistingRotation || isUploading || !isHydrated) {
      return
    }

    hasUserChangedRef.current = true
    setRotations((current) => ({
      ...current,
      [field]: normalizeRotation(current[field] + delta),
    }))
  }, [isHydrated, isPersistingRotation, isUploading])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tagName = target?.tagName ?? ''
      const key = event.key.toLowerCase()
      const isRotationHotkeyBlocked =
        target === descriptionInputRef.current ||
        target === tagInputRef.current ||
        Boolean(target?.closest('.immich-content input'))

      if (isPersistingRotation || isUploading || !isHydrated) {
        return
      }

      if (!isRotationHotkeyBlocked) {
        if (key === 'q') {
          event.preventDefault()
          rotateImage('front', -90)
          return
        }

        if (key === 'w') {
          event.preventDefault()
          rotateImage('front', 90)
          return
        }

        if (selectedPair?.backPath) {
          if (key === 'e') {
            event.preventDefault()
            rotateImage('back', -90)
            return
          }

          if (key === 'r') {
            event.preventDefault()
            rotateImage('back', 90)
            return
          }
        }
      }

      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName)) {
        return
      }

      if (key === 'arrowleft') {
        event.preventDefault()
        void navigateToIndex(selectedIndex - 1)
      }

      if (key === 'arrowright') {
        event.preventDefault()
        void navigateToIndex(selectedIndex + 1)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    isPersistingRotation,
    isHydrated,
    isUploading,
    navigateToIndex,
    rotateImage,
    selectedIndex,
    selectedPair?.backPath,
  ])

  const updateFormField = (field: 'date' | 'description', value: string) => {
    hasUserChangedRef.current = true
    setMetadata((current) => ({ ...current, [field]: value }))
  }

  const updateTags = (tags: string[]) => {
    hasUserChangedRef.current = true
    setMetadata((current) => ({ ...current, tags }))
  }

  const addTag = () => {
    const tag = tagInput.trim()
    if (!tag) {
      return
    }

    const isAlreadySelected = metadata.tags.some(
      (selectedTag) => selectedTag.toLocaleLowerCase() === tag.toLocaleLowerCase(),
    )
    if (!isAlreadySelected) {
      updateTags([...metadata.tags, tag])
    }

    setRecentTags((current) => [
      tag,
      ...current.filter((recentTag) => recentTag.toLocaleLowerCase() !== tag.toLocaleLowerCase()),
    ])
    setTagInput('')
  }

  const toggleTag = (tag: string) => {
    const selectedTagIndex = metadata.tags.findIndex(
      (selectedTag) => selectedTag.toLocaleLowerCase() === tag.toLocaleLowerCase(),
    )
    updateTags(
      selectedTagIndex === -1
        ? [...metadata.tags, tag]
        : metadata.tags.filter((_, index) => index !== selectedTagIndex),
    )
  }

  const updateDateSegments = (next: DateSegments) => {
    dateSegmentsRef.current = next
    setDateSegments(next)
    const nextDate = toIsoDate(next)
    if (nextDate && nextDate !== metadata.date) {
      updateFormField('date', nextDate)
    }
  }

  const handleDateSegmentChange = (field: keyof DateSegments, value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, field === 'year' ? 4 : 2)
    const next = { ...dateSegmentsRef.current, [field]: digits }
    clearPendingSave()
    updateDateSegments(next)

    if (digits.length === 2 && Number(digits) >= 1) {
      if (field === 'month' && Number(digits) <= 12) {
        dayInputRef.current?.focus()
        dayInputRef.current?.select()
      } else if (field === 'day' && Number(digits) <= 31) {
        yearInputRef.current?.focus()
        yearInputRef.current?.select()
      }
    }
  }

  const handleImageNumberKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') {
      return
    }

    event.preventDefault()
    const imageNumber = Number(imageNumberInput)
    if (!Number.isInteger(imageNumber) || imageNumber < 1 || imageNumber > pairs.length) {
      setStatus(`Enter an image number from 1 to ${pairs.length}.`)
      return
    }

    void navigateToIndex(imageNumber - 1)
  }

  const handleDateSegmentBlur = (field: keyof DateSegments) => {
    const current = dateSegmentsRef.current
    const next = { ...current, [field]: completeDateSegment(current[field], field) }
    updateDateSegments(next)
    if (!toIsoDate(next)) {
      setStatus('Enter a valid month, day, and year before saving.')
    }
  }

  const handleDescriptionKeyDown = async (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') {
      return
    }

    event.preventDefault()
    if (selectedIndex + 1 >= pairs.length) {
      if (selectedPair && hasUserChangedRef.current) {
        try {
          await persistCurrentPair()
        } catch (error) {
          setStatus(error instanceof Error ? error.message : 'Unable to save the metadata.')
        }
      }
      return
    }

    await navigateToIndex(selectedIndex + 1)
  }

  const handleDateKeyDown = async (
    event: ReactKeyboardEvent<HTMLInputElement>,
    field: keyof DateSegments,
  ) => {
    if (event.key !== 'Enter') {
      return
    }

    event.preventDefault()
    const current = dateSegmentsRef.current
    const next = { ...current, [field]: completeDateSegment(current[field], field) }
    const nextDate = toIsoDate(next)
    if (!nextDate) {
      setStatus('Enter a valid month, day, and year before saving.')
      return
    }

    clearPendingSave()
    updateDateSegments(next)
    const formValues = nextDate === metadata.date ? metadata : { ...metadata, date: nextDate }

    if (selectedIndex + 1 >= pairs.length) {
      if (selectedPair && hasUserChangedRef.current) {
        try {
          await savePairMetadata(selectedPair, formValues)
        } catch (error) {
          setStatus(error instanceof Error ? error.message : 'Unable to save the metadata.')
        }
      }
      return
    }

    await navigateToIndex(selectedIndex + 1, formValues)
  }

  const handleChooseDirectory = async () => {
    if (!window.electronAPI) {
      setStatus('This application must run inside Electron.')
      return
    }

    setIsBusy(true)
    setStatus('Scanning directory for photos...')

    try {
      const selectedDirectory = await window.electronAPI.chooseDirectory()
      if (!selectedDirectory) {
        setStatus('No directory selected.')
        return
      }

      if (!(await persistCurrentPair())) {
        return
      }

      setStatus('Scanning directory for photos...')
      const result = await window.electronAPI.readDirectory(selectedDirectory, sortBy)
      setDirectoryPath(result.directoryPath)
      setIsHydrated(false)
      setPairs(result.files)
      setRecentTags(result.recentTags)
      setImageNumberInput('1')
      setSelectedIndex(0)

      if (!result.files.length) {
        setStatus('No supported images were found in that directory.')
        return
      }

      setStatus(`Loaded ${result.files.length} photo group${result.files.length === 1 ? '' : 's'}.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to read the selected directory.')
    } finally {
      setIsBusy(false)
    }
  }

  const reloadDirectory = useCallback(async (nextSortBy: SortOption) => {
    if (!window.electronAPI || !directoryPath) {
      return
    }

    if (!(await persistCurrentPair())) {
      return
    }

    setIsBusy(true)
    setStatus('Sorting photos...')

    try {
      const result = await window.electronAPI.readDirectory(directoryPath, nextSortBy)
      setSortBy(nextSortBy)
      setIsHydrated(false)
      setPairs(result.files)
      setRecentTags(result.recentTags)
      setImageNumberInput('1')
      setSelectedIndex(0)
      setStatus(`Loaded ${result.files.length} photo group${result.files.length === 1 ? '' : 's'}.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to sort the selected directory.')
    } finally {
      setIsBusy(false)
    }
  }, [directoryPath, persistCurrentPair])

  const updateImmichSetting = <Field extends keyof ImmichSettings>(
    field: Field,
    value: ImmichSettings[Field],
  ) => {
    setImmichSettings((current) => ({ ...current, [field]: value }))
  }

  const handleImmichUpload = async () => {
    const electronApi = window.electronAPI
    if (!electronApi) {
      setImmichStatus('This application must run inside Electron.')
      return
    }

    if (!directoryPath) {
      setImmichStatus('Load an image directory before uploading.')
      return
    }

    try {
      setImmichStatus('Applying pending image rotation before upload...')
      if (!(await persistCurrentPair())) {
        setImmichStatus('Upload stopped because an image rotation could not be persisted.')
        return
      }

      setIsUploading(true)
      setUploadElapsedSeconds(0)
      setImmichOutput('')
      isImmichOutputFollowingRef.current = true
      setImmichStatus('Uploading the selected directory to Immich...')
      const savedSettings = await electronApi.saveImmichSettings(immichSettings)
      setImmichSettings(savedSettings)
      const result = await electronApi.uploadToImmich(savedSettings, directoryPath)
      setImmichOutput(result.output)
      setImmichStatus(
        result.ok
          ? 'Immich upload completed successfully.'
          : `Immich upload failed with exit code ${result.exitCode}.`,
      )
    } catch (error) {
      setImmichStatus(error instanceof Error ? error.message : 'Unable to upload to Immich.')
    } finally {
      setIsUploading(false)
    }
  }

  const canUploadToImmich =
    Boolean(directoryPath) &&
    Boolean(immichSettings.serverUrl.trim()) &&
    Boolean(immichSettings.userApiKey.trim())
  const isTransitionLocked = isBusy || isPersistingRotation || isUploading
  const isImageControlLocked = isTransitionLocked || !isHydrated

  return (
    <div className="app-shell">
      <header className="toolbar">
        <div>
          <p className="eyebrow">Local workflow</p>
          <h1>Image Parser</h1>
        </div>
        <button
          type="button"
          className="primary-button"
          onClick={handleChooseDirectory}
          disabled={isTransitionLocked}
        >
          {directoryPath ? 'Choose different folder' : 'Load directory'}
        </button>
      </header>

      <div className="status-bar">
        <span>{status}</span>
        {directoryPath ? <strong>{directoryPath}</strong> : null}
      </div>

      {!selectedPair ? (
        <section className="empty-state">
          <p>Select a local directory to review your images.</p>
        </section>
      ) : (
        <main className="workspace">
          <aside className="metadata-panel">
            <h2>Metadata</h2>
            <div className="metadata-grid">
              <fieldset className="metadata-date">
                <legend>Date</legend>
                <div className="date-segments">
                  <input
                    ref={dateInputRef}
                    type="text"
                    inputMode="numeric"
                    maxLength={2}
                    aria-label="Month"
                    value={dateSegments.month}
                    onFocus={(event) => event.currentTarget.select()}
                    onChange={(event) => handleDateSegmentChange('month', event.target.value)}
                    onBlur={() => handleDateSegmentBlur('month')}
                    onKeyDown={(event) => void handleDateKeyDown(event, 'month')}
                    disabled={isPersistingRotation || isUploading}
                  />
                  <span aria-hidden="true">/</span>
                  <input
                    ref={dayInputRef}
                    type="text"
                    inputMode="numeric"
                    maxLength={2}
                    aria-label="Day"
                    value={dateSegments.day}
                    onFocus={(event) => event.currentTarget.select()}
                    onChange={(event) => handleDateSegmentChange('day', event.target.value)}
                    onBlur={() => handleDateSegmentBlur('day')}
                    onKeyDown={(event) => void handleDateKeyDown(event, 'day')}
                    disabled={isPersistingRotation || isUploading}
                  />
                  <span aria-hidden="true">/</span>
                  <input
                    ref={yearInputRef}
                    type="text"
                    inputMode="numeric"
                    maxLength={4}
                    aria-label="Year"
                    value={dateSegments.year}
                    onFocus={(event) => event.currentTarget.select()}
                    onChange={(event) => handleDateSegmentChange('year', event.target.value)}
                    onBlur={() => handleDateSegmentBlur('year')}
                    onKeyDown={(event) => void handleDateKeyDown(event, 'year')}
                    disabled={isPersistingRotation || isUploading}
                  />
                </div>
              </fieldset>

              <label className="metadata-description">
                Description
                <input
                  ref={descriptionInputRef}
                  type="text"
                  value={metadata.description}
                  onChange={(event) => updateFormField('description', event.target.value)}
                  placeholder="Image description"
                  onKeyDown={(event) => void handleDescriptionKeyDown(event)}
                  disabled={isPersistingRotation || isUploading}
                />
              </label>

              <details
                className="metadata-details"
                open={isMetadataEntryExpanded}
                onToggle={(event) => setIsMetadataEntryExpanded(event.currentTarget.open)}
              >
                <summary className="metadata-details-summary">
                  <span>Tags</span>
                  <span className="metadata-details-action">
                    {isMetadataEntryExpanded ? 'Collapse' : 'Expand'}
                  </span>
                </summary>
                <div className="metadata-details-content">
                  <div className="metadata-tags">
                    <label htmlFor="new-tag">Tags</label>
                    <div className="tag-entry">
                      <input
                        id="new-tag"
                        ref={tagInputRef}
                        type="text"
                        value={tagInput}
                        onChange={(event) => setTagInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ',') {
                            event.preventDefault()
                            addTag()
                          }
                        }}
                        placeholder="Type a new tag"
                        disabled={isPersistingRotation || isUploading}
                      />
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={addTag}
                        disabled={!tagInput.trim() || isPersistingRotation || isUploading}
                      >
                        Add
                      </button>
                    </div>
                  </div>

                  {metadata.tags.length ? (
                    <div className="selected-tags" aria-label="Selected tags">
                      {metadata.tags.map((tag) => (
                        <button
                          key={tag.toLocaleLowerCase()}
                          type="button"
                          onClick={() => toggleTag(tag)}
                          disabled={isPersistingRotation || isUploading}
                          aria-label={`Remove ${tag}`}
                        >
                          {tag} <span aria-hidden="true">&times;</span>
                        </button>
                      ))}
                    </div>
                  ) : null}

                  <fieldset className="recent-tags">
                    <legend>Recent tags</legend>
                    {recentTags.length ? (
                      <div className="recent-tag-options">
                        {recentTags.map((tag) => (
                          <label key={tag.toLocaleLowerCase()}>
                            <input
                              type="checkbox"
                              checked={metadata.tags.some(
                                (selectedTag) =>
                                  selectedTag.toLocaleLowerCase() === tag.toLocaleLowerCase(),
                              )}
                              onChange={() => toggleTag(tag)}
                              disabled={isPersistingRotation || isUploading}
                            />
                            <span>{tag}</span>
                          </label>
                        ))}
                      </div>
                    ) : (
                      <span className="field-help">
                        Tags from recently modified XMP files appear here.
                      </span>
                    )}
                  </fieldset>
                </div>
              </details>
            </div>
          </aside>

          <section className="viewer-panel">
            <div className="viewer-toolbar">
              <label className="sort-control">
                <span>Sort by</span>
                <select
                  value={sortBy}
                  onChange={(event) => {
                    const nextSortBy = event.target.value as SortOption
                    void reloadDirectory(nextSortBy)
                  }}
                  disabled={isImageControlLocked}
                >
                  <option value="createdAt">File created date</option>
                  <option value="fileName">File name (A-Z)</option>
                </select>
              </label>
              <button
                type="button"
                onClick={() => void navigateToIndex(selectedIndex - 1)}
                disabled={selectedIndex === 0 || isImageControlLocked}
              >
                Previous
              </button>
              <label className="image-counter">
                <span className="visually-hidden">Go to image</span>
                <input
                  type="number"
                  min={1}
                  max={pairs.length}
                  value={imageNumberInput}
                  onChange={(event) => setImageNumberInput(event.target.value)}
                  onKeyDown={handleImageNumberKeyDown}
                  disabled={isImageControlLocked}
                  aria-label={`Go to image number, current image ${selectedIndex + 1} of ${pairs.length}`}
                />
                <span aria-hidden="true">/ {pairs.length}</span>
              </label>
              <button
                type="button"
                onClick={() => void navigateToIndex(selectedIndex + 1)}
                disabled={selectedIndex === pairs.length - 1 || isImageControlLocked}
              >
                Next
              </button>
            </div>

            <div
              className={`image-stack${
                !selectedPair.backPath || isExpanded ? ' image-stack--single' : ''
              }${isExpanded ? ' image-stack--expanded' : ''}`}
            >
              <div className="image-card">
                <div className="image-card-header">
                  <div className="image-label">Front image</div>
                  <div className="image-actions">
                    <button
                      type="button"
                      onClick={() => rotateImage('front', -90)}
                      disabled={isImageControlLocked}
                    >
                      Rotate left
                    </button>
                    <button
                      type="button"
                      onClick={() => rotateImage('front', 90)}
                      disabled={isImageControlLocked}
                    >
                      Rotate right
                    </button>
                    <button type="button" onClick={toggleExpanded} disabled={isImageControlLocked}>
                      {isExpanded ? 'Collapse' : 'Expand'}
                    </button>
                  </div>
                </div>
                <MagnifiedImage
                  filePath={selectedPair.frontPath}
                  altText={selectedPair.imageLabel}
                  rotation={rotations.front}
                />
              </div>

              {selectedPair.backPath ? (
                <div className="image-card">
                  <div className="image-card-header">
                    <div className="image-label">Back image</div>
                    <div className="image-actions">
                      <button
                        type="button"
                        onClick={() => rotateImage('back', -90)}
                        disabled={isImageControlLocked}
                      >
                        Rotate left
                      </button>
                      <button
                        type="button"
                        onClick={() => rotateImage('back', 90)}
                        disabled={isImageControlLocked}
                      >
                        Rotate right
                      </button>
                      <button type="button" onClick={toggleExpanded} disabled={isImageControlLocked}>
                        {isExpanded ? 'Collapse' : 'Expand'}
                      </button>
                    </div>
                  </div>
                  <MagnifiedImage
                    filePath={selectedPair.backPath}
                    altText={`${selectedPair.imageLabel} backside`}
                    rotation={rotations.back}
                  />
                </div>
              ) : null}
            </div>
          </section>

          <details className="immich-panel">
            <summary className="immich-panel-summary">
              <span>
                <span className="eyebrow">Final step</span>
                <span className="immich-panel-title">Upload to Immich</span>
              </span>
              <span className="immich-summary-action">Configure and upload</span>
            </summary>

            <div className="immich-content">
              <span className="immich-directory">Uploads: {directoryPath}</span>

              <div className="immich-grid">
                <label>
                  Server URL
                  <input
                    type="url"
                    value={immichSettings.serverUrl}
                    onChange={(event) => updateImmichSetting('serverUrl', event.target.value)}
                    placeholder="https://photos.example.com"
                    required
                    disabled={isUploading}
                  />
                </label>

                <label>
                  User API key
                  <input
                    type="password"
                    value={immichSettings.userApiKey}
                    onChange={(event) => updateImmichSetting('userApiKey', event.target.value)}
                    autoComplete="new-password"
                    required
                    disabled={isUploading}
                  />
                </label>

                <label>
                  Admin API key
                  <input
                    type="password"
                    value={immichSettings.adminApiKey}
                    onChange={(event) => updateImmichSetting('adminApiKey', event.target.value)}
                    autoComplete="new-password"
                    required={immichSettings.pauseImmichJobs}
                    disabled={isUploading}
                    aria-describedby="admin-api-key-help"
                  />
                  <span id="admin-api-key-help" className="field-help">
                    Required when pausing Immich jobs.
                  </span>
                </label>

                <label>
                  Target album
                  <input
                    type="text"
                    value={immichSettings.albumName}
                    onChange={(event) => updateImmichSetting('albumName', event.target.value)}
                    required
                    disabled={isUploading}
                  />
                </label>

                <label className="immich-tags">
                  Tags
                  <input
                    type="text"
                    value={immichSettings.tags}
                    onChange={(event) => updateImmichSetting('tags', event.target.value)}
                    placeholder="family, archive, scanned"
                    disabled={isUploading}
                    aria-describedby="immich-tags-help"
                  />
                  <span id="immich-tags-help" className="field-help">
                    Separate multiple tags with commas.
                  </span>
                </label>

                <label>
                  Concurrent tasks
                  <input
                    type="number"
                    min="1"
                    max="20"
                    step="1"
                    value={immichSettings.concurrentTasks}
                    onChange={(event) =>
                      updateImmichSetting('concurrentTasks', Number(event.target.value))
                    }
                    required
                    disabled={isUploading}
                  />
                </label>
              </div>

              <div className="immich-actions">
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={immichSettings.pauseImmichJobs}
                    onChange={(event) =>
                      updateImmichSetting('pauseImmichJobs', event.target.checked)
                    }
                    disabled={isUploading}
                  />
                  Pause Immich background jobs during upload
                </label>
                <button
                  type="button"
                  className="primary-button"
                  onClick={handleImmichUpload}
                  disabled={isImageControlLocked || !canUploadToImmich}
                >
                  {isUploading ? 'Uploading...' : 'Upload to Immich'}
                </button>
              </div>

              <div className="immich-result" role="status" aria-live="polite">
                <strong>{immichStatus}</strong>
                {isUploading ? (
                  <div className="immich-progress">
                    <progress
                      className="immich-progress-bar"
                      aria-label="Immich upload is processing"
                    />
                    <span>
                      Processing for {formatElapsedTime(uploadElapsedSeconds)}. Activity below updates
                      while immich-go is running.
                    </span>
                  </div>
                ) : null}
                {immichOutput ? (
                  <pre
                    ref={immichOutputRef}
                    onScroll={(event) => {
                      const outputElement = event.currentTarget
                      const distanceFromBottom =
                        outputElement.scrollHeight -
                        outputElement.scrollTop -
                        outputElement.clientHeight
                      isImmichOutputFollowingRef.current = distanceFromBottom < 24
                    }}
                  >
                    {immichOutput}
                  </pre>
                ) : null}
              </div>
            </div>
          </details>
          </main>
      )}
    </div>
  )
}

export default App
