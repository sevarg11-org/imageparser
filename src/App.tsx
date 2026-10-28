import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import "./App.css";
import {
  completeDateSegment,
  parseDateSegments,
  toIsoDate,
  type DateSegments,
} from "./dateEntry";
import {
  countImageFilterMatches,
  filterImagePairs,
  getEmptyFilterMessage,
  imageFilterOptions,
  isImageFilter,
  type ImageFilter,
} from "./imageFilters";
import { SetFolderDateModal } from "./SetFolderDateModal";
import { fetchCurrentUser, type CurrentUser } from "./webApi";

type ImagePair = {
  id: string;
  imageLabel: string;
  frontPath: string;
  backPath: string | null;
  createdAt: number;
  doNotUpload: boolean;
  excludeMismatch: boolean;
  hasSidecar: boolean;
};

type SetDoNotUploadResult = Pick<
  ImagePair,
  | "id"
  | "imageLabel"
  | "frontPath"
  | "backPath"
  | "doNotUpload"
  | "excludeMismatch"
> & {
  ok: boolean;
  renamed: Array<{ from: string; to: string }>;
};

type SortField = "createdAt" | "dateTaken" | "fileName";
type SortDirection = "asc" | "desc";
type SortOption = `${SortField}-${SortDirection}`;

type MetadataForm = {
  date: string;
  description: string;
  tags: string[];
};

type RotationField = "front" | "back";

type PairRotationState = {
  front: number;
  back: number;
};

type ImmichSettings = {
  serverUrl: string;
  userApiKey: string;
  adminApiKey: string;
  albumName: string;
  tags: string;
  pauseImmichJobs: boolean;
  concurrentTasks: number;
};

type SetFolderDateResult = {
  ok: boolean;
  updatedPairs: number;
  skippedPairs: number;
  excludedPairs: number;
  errors: string[];
};

type ImmichUploadResult = {
  ok: boolean;
  exitCode: number;
  output: string;
};

type ImmichUploadProgress = {
  phase: "uploading";
  output: string;
};

type ImageRotationResult = {
  field: RotationField;
  filePath: string;
  ok: boolean;
  error?: string;
};

type ApplyImageRotationsResult = {
  ok: boolean;
  updatedFiles: number;
  results: ImageRotationResult[];
};

declare global {
  interface Window {
    electronAPI?: {
      chooseDirectory: () => Promise<string | null>;
      readDirectory: (
        directoryPath: string,
        sortBy: SortOption,
      ) => Promise<{
        directoryPath: string;
        files: ImagePair[];
        recentTags: string[];
      }>;
      readSidecarMetadata: (filePath: string) => Promise<{
        date: string;
        description: string;
        tags: string[];
        rotation: number;
      }>;
      saveMetadata: (metadata: {
        frontPath: string;
        backPath: string | null;
        date: string;
        description: string;
        tags: string[];
        frontRotation: number;
        backRotation: number;
      }) => Promise<{ ok: boolean; updatedFiles: number; sidecarFile: string }>;
      getPreviewDataUrl: (
        filePath: string,
        rotation: number,
      ) => Promise<string>;
      applyImageRotations: (request: {
        frontPath: string;
        backPath: string | null;
        frontRotation: number;
        backRotation: number;
      }) => Promise<ApplyImageRotationsResult>;
      setFolderDate: (
        directoryPath: string,
        date: string,
      ) => Promise<SetFolderDateResult>;
      setDoNotUpload: (request: {
        frontPath: string;
        backPath: string | null;
        value: boolean;
      }) => Promise<SetDoNotUploadResult>;
      loadImmichSettings: () => Promise<ImmichSettings>;
      saveImmichSettings: (settings: ImmichSettings) => Promise<ImmichSettings>;
      uploadToImmich: (
        settings: ImmichSettings,
        directoryPath: string,
      ) => Promise<ImmichUploadResult>;
      onImmichUploadProgress: (
        listener: (progress: ImmichUploadProgress) => void,
      ) => () => void;
    };
  }
}

/**
 * Normalizes a rotation value to a multiple of 90 degrees within the range [0, 360).
 * @param value - The rotation value in degrees.
 * @returns The normalized rotation value in degrees.
 */
const normalizeRotation = (value: number) =>
  (((Math.round(value / 90) % 4) + 4) % 4) * 90;

/**
 * Formats elapsed time in seconds into a human-readable string (e.g., "1m 30s").
 * @param elapsedSeconds - The elapsed time in seconds.
 * @returns A formatted time string.
 */
const formatElapsedTime = (elapsedSeconds: number) => {
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return minutes > 0
    ? `${minutes}m ${seconds.toString().padStart(2, "0")}s`
    : `${seconds}s`;
};

/**
 * Formats an image status message for display in the UI.
 * @param index - The current image index (0-based).
 * @param total - The total number of images.
 * @param label - The image label.
 * @returns A formatted status string.
 */
const formatImageStatus = (index: number, total: number, label: string) =>
  `Image ${index + 1} of ${total}: ${label}.`;

/**
 * Formats a metadata save confirmation message for display in the UI.
 * @param label - The image label whose metadata was saved.
 * @returns A formatted status string.
 */
const formatSavedStatus = (label: string) => `Saved changes to ${label}.`;

/**
 * Input props that select the whole value when the field gains focus, so typing replaces it.
 * A mouse click would normally collapse the selection on mouseup, so that default is suppressed
 * only for the click that focused the field; later clicks still position the caret normally.
 */
const selectAllOnFocusProps = {
  onFocus: (event: ReactFocusEvent<HTMLInputElement>) => {
    event.currentTarget.select();
  },
  onMouseDown: (event: ReactMouseEvent<HTMLInputElement>) => {
    if (document.activeElement !== event.currentTarget) {
      event.currentTarget.dataset.selectOnMouseUp = "true";
    }
  },
  onMouseUp: (event: ReactMouseEvent<HTMLInputElement>) => {
    if (event.currentTarget.dataset.selectOnMouseUp) {
      delete event.currentTarget.dataset.selectOnMouseUp;
      event.preventDefault();
    }
  },
};

/**
 * Loads and decodes an image so it can be shown without a blank frame.
 * Load failures are ignored; the displayed image element reports them instead.
 * @param src - The image source URL to preload.
 */
const preloadImage = async (src: string) => {
  const image = new Image();
  image.src = src;
  try {
    await image.decode();
  } catch {
    // The <img> element surfaces broken images itself.
  }
};

/**
 * Resolves the preview source URL for an image, accounting for rotation.
 * When running in Electron, attempts to use a preview data URL; otherwise falls back to a file URL.
 * @param filePath - The path to the image file.
 * @param rotation - The rotation value in degrees.
 * @returns A resolved source URL for displaying the image preview.
 */
const useResolvedPreviewSrc = (filePath: string, rotation: number) => {
  const [src, setSrc] = useState("");

  useEffect(() => {
    let isActive = true;

    const resolvePreviewUrl = async () => {
      if (!filePath) {
        setSrc("");
        return;
      }

      if (!window.electronAPI) {
        setSrc(toFileUrl(filePath));
        return;
      }

      let nextSrc: string;
      try {
        const previewUrl = await window.electronAPI.getPreviewDataUrl(
          filePath,
          rotation,
        );
        nextSrc = previewUrl || toFileUrl(filePath);
      } catch {
        nextSrc = toFileUrl(filePath);
      }

      // Keep the current image on screen until the new one is decoded, so a path change
      // such as the "Do not upload" rename does not blank the preview while it loads.
      await preloadImage(nextSrc);
      if (isActive) {
        setSrc(nextSrc);
      }
    };

    void resolvePreviewUrl();

    return () => {
      isActive = false;
    };
  }, [filePath, rotation]);

  return src;
};

const MAGNIFIER_LENS_SIZE = 160;
const MAGNIFIER_ZOOM = 2.5;
const MAGNIFIER_EDGE_BUFFER = 32;

const MagnifiedImage = ({
  filePath,
  altText,
  rotation,
}: {
  filePath: string;
  altText: string;
  rotation: number;
}) => {
  const src = useResolvedPreviewSrc(filePath, rotation);
  const [isLoading, setIsLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [lensStyle, setLensStyle] = useState<{
    left: number;
    top: number;
    backgroundSize: string;
    backgroundPosition: string;
  } | null>(null);

  /**
   * Handles mouse movement events to update the magnifier lens position and style.
   * @param event - The React mouse event object containing mouse position information.
   */
  const handleMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    const image = imageRef.current;
    if (!container || !image || !src) {
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const imageRect = image.getBoundingClientRect();
    if (imageRect.width === 0 || imageRect.height === 0) {
      return;
    }

    const imageX = event.clientX - imageRect.left;
    const imageY = event.clientY - imageRect.top;
    const isOutsideImage =
      imageX < -MAGNIFIER_EDGE_BUFFER ||
      imageX > imageRect.width + MAGNIFIER_EDGE_BUFFER ||
      imageY < -MAGNIFIER_EDGE_BUFFER ||
      imageY > imageRect.height + MAGNIFIER_EDGE_BUFFER;
    if (isOutsideImage) {
      setLensStyle(null);
      return;
    }

    const halfLens = MAGNIFIER_LENS_SIZE / 2;
    const pointerX = event.clientX - containerRect.left;
    const pointerY = event.clientY - containerRect.top;
    const imageLeft = imageRect.left - containerRect.left;
    const imageTop = imageRect.top - containerRect.top;
    const hoverLeft = imageLeft - MAGNIFIER_EDGE_BUFFER;
    const hoverTop = imageTop - MAGNIFIER_EDGE_BUFFER;
    const hoverWidth = imageRect.width + MAGNIFIER_EDGE_BUFFER * 2;
    const hoverHeight = imageRect.height + MAGNIFIER_EDGE_BUFFER * 2;
    const sampledImageX = Math.min(Math.max(imageX, 0), imageRect.width);
    const sampledImageY = Math.min(Math.max(imageY, 0), imageRect.height);
    const lensLeft =
      hoverWidth >= MAGNIFIER_LENS_SIZE
        ? Math.min(
            Math.max(pointerX - halfLens, hoverLeft),
            hoverLeft + hoverWidth - MAGNIFIER_LENS_SIZE,
          )
        : hoverLeft + (hoverWidth - MAGNIFIER_LENS_SIZE) / 2;
    const lensTop =
      hoverHeight >= MAGNIFIER_LENS_SIZE
        ? Math.min(
            Math.max(pointerY - halfLens, hoverTop),
            hoverTop + hoverHeight - MAGNIFIER_LENS_SIZE,
          )
        : hoverTop + (hoverHeight - MAGNIFIER_LENS_SIZE) / 2;

    setLensStyle({
      left: lensLeft,
      top: lensTop,
      backgroundSize: `${imageRect.width * MAGNIFIER_ZOOM}px ${imageRect.height * MAGNIFIER_ZOOM}px`,
      backgroundPosition: `${pointerX - lensLeft - sampledImageX * MAGNIFIER_ZOOM}px ${
        pointerY - lensTop - sampledImageY * MAGNIFIER_ZOOM
      }px`,
    });
  };

  return (
    <div
      className="magnifier-container"
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setLensStyle(null)}
    >
      <img
        ref={imageRef}
        src={src}
        alt={altText}
        onLoad={() => setIsLoading(false)}
      />
      {!isLoading && lensStyle && src ? (
        <div
          className="magnifier-lens"
          style={{
            left: lensStyle.left,
            top: lensStyle.top,
            width: MAGNIFIER_LENS_SIZE,
            height: MAGNIFIER_LENS_SIZE,
            backgroundImage: `url(${src})`,
            backgroundRepeat: "no-repeat",
            backgroundSize: lensStyle.backgroundSize,
            backgroundPosition: lensStyle.backgroundPosition,
          }}
        />
      ) : null}
    </div>
  );
};

/**
 * Converts a file system path to a file:// URL for preview display.
 * Handles Windows paths, absolute/relative URLs, and properly encodes special characters.
 * @param filePath - The file system path to convert.
 * @returns A file:// URL string or an empty string if the path is empty.
 */
const toFileUrl = (filePath: string) => {
  if (!filePath) {
    return "";
  }

  const normalizedPath = filePath.replace(/\\/g, "/");
  const encodedPath = encodeURI(normalizedPath);

  if (/^([a-zA-Z]:)/.test(normalizedPath)) {
    return `file:///${encodedPath}`;
  }

  return `file://${normalizedPath.startsWith("/") ? "" : "/"}${encodedPath}`;
};

const defaultDate = new Date().toISOString().slice(0, 10);
const METADATA_ENTRY_SESSION_KEY = "imageparser.metadata-entry-expanded";
const COLLAPSED_IMAGE_HEIGHT_STORAGE_KEY = "imageparser.collapsed-image-height";
const MIN_COLLAPSED_IMAGE_HEIGHT = 200;
const MAX_COLLAPSED_IMAGE_HEIGHT = 1000;
const COLLAPSED_IMAGE_HEIGHT_STEP = 20;
const DEFAULT_COLLAPSED_IMAGE_HEIGHT = 600;

type ImageStackStyle = CSSProperties & { "--collapsed-image-height": string };

/**
 * Clamps a collapsed image height to the slider range and step.
 * @param value - The requested height in pixels.
 * @returns A valid height in pixels, or the default when the value is not a finite number.
 */
const clampCollapsedImageHeight = (value: number) => {
  if (!Number.isFinite(value)) {
    return DEFAULT_COLLAPSED_IMAGE_HEIGHT;
  }
  const stepped =
    Math.round(value / COLLAPSED_IMAGE_HEIGHT_STEP) *
    COLLAPSED_IMAGE_HEIGHT_STEP;
  return Math.min(
    Math.max(stepped, MIN_COLLAPSED_IMAGE_HEIGHT),
    MAX_COLLAPSED_IMAGE_HEIGHT,
  );
};
const defaultImmichSettings: ImmichSettings = {
  serverUrl: "",
  userApiKey: "",
  adminApiKey: "",
  albumName: "",
  tags: "",
  pauseImmichJobs: true,
  concurrentTasks: 2,
};

function App() {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [directoryPath, setDirectoryPath] = useState("");
  const [pairs, setPairs] = useState<ImagePair[]>([]);
  const [selectedPairId, setSelectedPairId] = useState<string | null>(null);
  const [savedPairIds, setSavedPairIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Saved IDs as they were when the filter was chosen or the folder loaded.
  const [filterSnapshotPairIds, setFilterSnapshotPairIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [imageNumberInput, setImageNumberInput] = useState("1");
  const [sortBy, setSortBy] = useState<SortOption>("createdAt-asc");
  const [metadata, setMetadata] = useState<MetadataForm>({
    date: defaultDate,
    description: "",
    tags: [],
  });
  const [dateSegments, setDateSegments] = useState(() =>
    parseDateSegments(defaultDate),
  );
  const [isMetadataEntryExpanded, setIsMetadataEntryExpanded] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.sessionStorage.getItem(METADATA_ENTRY_SESSION_KEY) === "true";
  });
  const [tagInput, setTagInput] = useState("");
  const [recentTags, setRecentTags] = useState<string[]>([]);
  const [imageFilter, setImageFilter] = useState<ImageFilter>("all");
  const [status, setStatus] = useState(
    "Choose a directory to begin reviewing images.",
  );
  const [isBusy, setIsBusy] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [rotations, setRotations] = useState<PairRotationState>({
    front: 0,
    back: 0,
  });
  const [isPersistingRotation, setIsPersistingRotation] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [collapsedImageHeight, setCollapsedImageHeight] = useState(() => {
    try {
      const savedHeight = window.localStorage.getItem(
        COLLAPSED_IMAGE_HEIGHT_STORAGE_KEY,
      );
      return savedHeight === null
        ? DEFAULT_COLLAPSED_IMAGE_HEIGHT
        : clampCollapsedImageHeight(Number(savedHeight));
    } catch {
      return DEFAULT_COLLAPSED_IMAGE_HEIGHT;
    }
  });
  const [immichSettings, setImmichSettings] = useState<ImmichSettings>(
    defaultImmichSettings,
  );
  const [immichStatus, setImmichStatus] = useState(
    "Immich settings are saved when an upload starts.",
  );
  const [immichOutput, setImmichOutput] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [isSettingFolderDate, setIsSettingFolderDate] = useState(false);
  const [isSetFolderDateModalOpen, setIsSetFolderDateModalOpen] =
    useState(false);
  const [isTogglingDoNotUpload, setIsTogglingDoNotUpload] = useState(false);
  const [doNotUploadError, setDoNotUploadError] = useState<{
    pairId: string;
    message: string;
  } | null>(null);
  const [uploadElapsedSeconds, setUploadElapsedSeconds] = useState(0);
  const hasUserChangedRef = useRef(false);
  const dateInputRef = useRef<HTMLInputElement | null>(null);
  const dayInputRef = useRef<HTMLInputElement | null>(null);
  const yearInputRef = useRef<HTMLInputElement | null>(null);
  const dateSegmentsRef = useRef(dateSegments);
  const descriptionInputRef = useRef<HTMLInputElement | null>(null);
  const tagInputRef = useRef<HTMLInputElement | null>(null);
  const immichOutputRef = useRef<HTMLPreElement | null>(null);
  const isImmichOutputFollowingRef = useRef(true);
  const saveTimeoutRef = useRef<number | null>(null);
  const pendingPersistenceRef = useRef<Promise<boolean> | null>(null);

  // Mirrors savedPairIds synchronously, so a filter change can snapshot a save
  // that finished in the same callback before React re-renders.
  const savedPairIdsRef = useRef<ReadonlySet<string>>(new Set());

  /**
   * Records that the given groups now have a sidecar. The filtered list keeps
   * its snapshot; only the option counts update.
   * @param ids - IDs of the groups that were saved.
   */
  const markPairsSaved = useCallback((ids: readonly string[]) => {
    const current = savedPairIdsRef.current;
    if (ids.every((id) => current.has(id))) {
      return;
    }
    const next = new Set(current);
    for (const id of ids) {
      next.add(id);
    }
    savedPairIdsRef.current = next;
    setSavedPairIds(next);
  }, []);

  /**
   * Clears the saved IDs and the filter snapshot when a folder is (re)loaded.
   */
  const resetSavedPairs = useCallback(() => {
    const empty = new Set<string>();
    savedPairIdsRef.current = empty;
    setSavedPairIds(empty);
    setFilterSnapshotPairIds(empty);
  }, []);

  const displayPairs = useMemo(
    () => filterImagePairs(pairs, imageFilter, filterSnapshotPairIds),
    [pairs, imageFilter, filterSnapshotPairIds],
  );

  const filterCounts = useMemo(
    () => countImageFilterMatches(pairs, savedPairIds),
    [pairs, savedPairIds],
  );

  const selectedIndex = useMemo(
    () =>
      Math.max(
        displayPairs.findIndex((pair) => pair.id === selectedPairId),
        0,
      ),
    [displayPairs, selectedPairId],
  );

  const selectedPair = useMemo(
    () => displayPairs[selectedIndex] ?? null,
    [displayPairs, selectedIndex],
  );

  /**
   * Loads the signed-in web user, so the header can show who is signed in and offer sign-out.
   */
  useEffect(() => {
    let isMounted = true;
    void fetchCurrentUser().then((user) => {
      if (isMounted) {
        setCurrentUser(user);
      }
    });
    return () => {
      isMounted = false;
    };
  }, []);

  /**
   * Loads Immich settings from storage on app initialization.
   * Hydrates the immichSettings state and displays any error messages from failed loads.
   */
  useEffect(() => {
    const electronApi = window.electronAPI;
    if (!electronApi) {
      return;
    }

    let isMounted = true;

    const hydrateImmichSettings = async () => {
      try {
        const savedSettings = await electronApi.loadImmichSettings();
        if (isMounted) {
          setImmichSettings(savedSettings);
        }
      } catch (error) {
        if (isMounted) {
          setImmichStatus(
            error instanceof Error
              ? error.message
              : "Unable to load the saved Immich settings.",
          );
        }
      }
    };

    void hydrateImmichSettings();
    return () => {
      isMounted = false;
    };
  }, []);

  /**
   * Persists the expanded/collapsed state of the metadata entry panel to sessionStorage.
   */
  useEffect(() => {
    window.sessionStorage.setItem(
      METADATA_ENTRY_SESSION_KEY,
      String(isMetadataEntryExpanded),
    );
  }, [isMetadataEntryExpanded]);

  /**
   * Persists the collapsed image height preference to localStorage so it survives restarts.
   */
  useEffect(() => {
    try {
      window.localStorage.setItem(
        COLLAPSED_IMAGE_HEIGHT_STORAGE_KEY,
        String(collapsedImageHeight),
      );
    } catch {
      // Storage can be unavailable; the slider still works for this session.
    }
  }, [collapsedImageHeight]);

  /**
   * Sets up an event listener for Immich upload progress updates.
   * Updates the immichOutput and immichStatus states when progress events occur.
   */
  useEffect(() => {
    const electronApi = window.electronAPI;
    if (!electronApi) {
      return;
    }

    return electronApi.onImmichUploadProgress((progress) => {
      setImmichOutput(progress.output);
      setImmichStatus("Immich is processing the selected directory...");
    });
  }, []);

  /**
   * Starts a timer to track upload elapsed time when uploading is in progress.
   * Updates the uploadElapsedSeconds state every second while isUploading is true.
   */
  useEffect(() => {
    if (!isUploading) {
      return;
    }

    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setUploadElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [isUploading]);

  /**
   * Auto-scrolls the immichOutput element to the bottom when new output is available.
   */
  useEffect(() => {
    const outputElement = immichOutputRef.current;
    if (outputElement && isImmichOutputFollowingRef.current) {
      outputElement.scrollTop = outputElement.scrollHeight;
    }
  }, [immichOutput]);

  const toggleExpanded = useCallback(() => {
    setIsExpanded((current) => !current);
  }, []);

  const clearPendingSave = useCallback(() => {
    if (saveTimeoutRef.current !== null) {
      window.clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
  }, []);

  const savePairMetadata = useCallback(
    async (pair: ImagePair, formValues: MetadataForm) => {
      const electronApi = window.electronAPI;
      if (!electronApi) {
        throw new Error("This application must run inside Electron.");
      }

      await electronApi.saveMetadata({
        frontPath: pair.frontPath,
        backPath: pair.backPath,
        date: formValues.date,
        description: formValues.description,
        tags: formValues.tags,
        frontRotation: rotations.front,
        backRotation: rotations.back,
      });

      hasUserChangedRef.current = false;
      if (!pair.hasSidecar) {
        markPairsSaved([pair.id]);
      }
    },
    [markPairsSaved, rotations],
  );

  /**
   * Persists metadata changes to the current selected pair and applies image rotations if needed.
   * This is a debounced operation that saves changes after user input stabilizes.
   * @param formValues - The metadata form values (description, date, tags) to persist.
   *                      If not provided, uses the current metadata state.
   */
  const persistCurrentPair = useCallback(
    (formValues: MetadataForm = metadata) => {
      if (pendingPersistenceRef.current) {
        return pendingPersistenceRef.current;
      }

      const operation = (async () => {
        if (!selectedPair) {
          return true;
        }

        if (!toIsoDate(dateSegmentsRef.current)) {
          setStatus("Enter a valid month, day, and year before saving.");
          return false;
        }

        const electronApi = window.electronAPI;
        if (!electronApi) {
          setStatus("This application must run inside Electron.");
          return false;
        }

        const rotationSnapshot = { ...rotations };
        setIsPersistingRotation(true);
        clearPendingSave();

        try {
          await savePairMetadata(selectedPair, formValues);

          if (rotationSnapshot.front === 0 && rotationSnapshot.back === 0) {
            return true;
          }

          const result = await electronApi.applyImageRotations({
            frontPath: selectedPair.frontPath,
            backPath: selectedPair.backPath,
            frontRotation: rotationSnapshot.front,
            backRotation: rotationSnapshot.back,
          });
          const remainingRotations = { ...rotationSnapshot };

          for (const imageResult of result.results) {
            if (imageResult.ok) {
              remainingRotations[imageResult.field] = 0;
            }
          }

          setRotations(remainingRotations);
          const failures = result.results.filter(
            (imageResult) => !imageResult.ok,
          );
          hasUserChangedRef.current =
            remainingRotations.front !== 0 || remainingRotations.back !== 0;

          if (failures.length) {
            setStatus(
              failures
                .map((failure) => failure.error)
                .filter(Boolean)
                .join(" "),
            );
            return false;
          }

          return result.ok;
        } catch (error) {
          hasUserChangedRef.current =
            rotationSnapshot.front !== 0 || rotationSnapshot.back !== 0;
          setStatus(
            error instanceof Error
              ? error.message
              : "Unable to persist image rotation.",
          );
          return false;
        } finally {
          setIsPersistingRotation(false);
        }
      })();

      pendingPersistenceRef.current = operation;
      void operation.finally(() => {
        if (pendingPersistenceRef.current === operation) {
          pendingPersistenceRef.current = null;
        }
      });
      return operation;
    },
    [clearPendingSave, metadata, rotations, savePairMetadata, selectedPair],
  );

  /**
   * Navigates to a specific image index after persisting changes from the current pair.
   * Binds the index to the valid range of displayed pairs and returns early if already at the target.
   * @param nextIndex - The target zero-based image index to navigate to.
   * @param formValues - Optional metadata form values to persist before navigating.
   */
  const navigateToIndex = useCallback(
    async (nextIndex: number, formValues?: MetadataForm) => {
      const boundedIndex = Math.min(
        Math.max(nextIndex, 0),
        displayPairs.length - 1,
      );

      if (boundedIndex === selectedIndex || isUploading || !isHydrated) {
        return;
      }

      const nextPair = displayPairs[boundedIndex];
      if (!nextPair || !(await persistCurrentPair(formValues))) {
        return;
      }

      setImageNumberInput(String(boundedIndex + 1));
      setIsHydrated(false);
      setSelectedPairId(nextPair.id);
    },
    [displayPairs, isHydrated, isUploading, persistCurrentPair, selectedIndex],
  );

  /**
   * Loads metadata from XMP sidecar files when the selected pair changes.
   * Hydrates the component with initial state and updates metadata, rotations, and status.
   */
  useEffect(() => {
    const electronApi = window.electronAPI;
    if (!selectedPair || !electronApi) {
      return;
    }

    let isMounted = true;
    const imageStatus = formatImageStatus(
      selectedIndex,
      displayPairs.length,
      selectedPair.imageLabel,
    );

    const loadMetadataFromSidecar = async () => {
      try {
        const [frontXmpValues, backXmpValues] = await Promise.all([
          electronApi.readSidecarMetadata(selectedPair.frontPath),
          selectedPair.backPath
            ? electronApi.readSidecarMetadata(selectedPair.backPath)
            : Promise.resolve(null),
        ]);

        if (!isMounted) {
          return;
        }

        hasUserChangedRef.current = false;
        const loadedDate = frontXmpValues.date
          ? frontXmpValues.date.slice(0, 10)
          : defaultDate;
        setMetadata({
          date: loadedDate,
          description: frontXmpValues.description ?? "",
          tags: frontXmpValues.tags ?? [],
        });
        const loadedSegments = parseDateSegments(loadedDate);
        dateSegmentsRef.current = loadedSegments;
        setDateSegments(loadedSegments);
        setRecentTags((current) => [
          ...(frontXmpValues.tags ?? []),
          ...current.filter(
            (tag) =>
              !(frontXmpValues.tags ?? []).some(
                (loadedTag) =>
                  loadedTag.toLocaleLowerCase() === tag.toLocaleLowerCase(),
              ),
          ),
        ]);
        setTagInput("");
        setRotations({
          front: normalizeRotation(frontXmpValues.rotation ?? 0),
          back: normalizeRotation(backXmpValues?.rotation ?? 0),
        });
        setIsHydrated(true);
        setStatus(imageStatus);
      } catch {
        if (!isMounted) {
          return;
        }

        hasUserChangedRef.current = false;
        setMetadata({
          date: defaultDate,
          description: "",
          tags: [],
        });
        const defaultSegments = parseDateSegments(defaultDate);
        dateSegmentsRef.current = defaultSegments;
        setDateSegments(defaultSegments);
        setTagInput("");
        setRotations({ front: 0, back: 0 });
        setIsHydrated(true);
        setStatus(`${imageStatus} Unable to read saved metadata.`);
      }
    };

    void loadMetadataFromSidecar();

    return () => {
      isMounted = false;
    };
  }, [displayPairs.length, selectedIndex, selectedPair]);

  /**
   * Debounces metadata saves and clears pending changes when conditions change.
   * Triggers a save after user changes stabilize or when navigation occurs.
   */
  useEffect(() => {
    const electronApi = window.electronAPI;
    if (!selectedPair || !electronApi || !isHydrated) {
      clearPendingSave();
      hasUserChangedRef.current = false;
      return;
    }

    if (!hasUserChangedRef.current) {
      return;
    }

    clearPendingSave();
    if (!toIsoDate(dateSegmentsRef.current)) {
      return;
    }
    saveTimeoutRef.current = window.setTimeout(async () => {
      try {
        await savePairMetadata(selectedPair, metadata);
        setStatus(formatSavedStatus(selectedPair.imageLabel));
      } catch (error) {
        setStatus(
          error instanceof Error
            ? error.message
            : "Unable to save the metadata.",
        );
      } finally {
        saveTimeoutRef.current = null;
      }
    }, 350);

    return () => {
      clearPendingSave();
    };
  }, [clearPendingSave, selectedPair, metadata, isHydrated, savePairMetadata]);

  /**
   * Focuses the date input field when the component becomes hydrated and a pair is selected.
   */
  useEffect(() => {
    if (!selectedPair || !isHydrated) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      dateInputRef.current?.focus();
      dateInputRef.current?.select();
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [isHydrated, selectedPair]);

  /**
   * Rotates an image by a given delta value (in 90-degree increments).
   * Does not apply rotation if already persisting, uploading, or not hydrated.
   * @param field - Which image to rotate ("front" or "back").
   * @param delta - The rotation change in degrees (typically Â±90).
   */
  const rotateImage = useCallback(
    (field: RotationField, delta: number) => {
      if (isPersistingRotation || isUploading || !isHydrated) {
        return;
      }

      hasUserChangedRef.current = true;
      setRotations((current) => ({
        ...current,
        [field]: normalizeRotation(current[field] + delta),
      }));
    },
    [isHydrated, isPersistingRotation, isUploading],
  );

  /**
   * Flags the selected group "Do not upload", or clears the flag, by renaming its files.
   * Unsaved metadata edits and rotations are saved first, so they land on the old file names
   * before the rename. The pair is then replaced in place with its new paths, keeping it selected.
   */
  const toggleDoNotUpload = useCallback(async () => {
    const electronApi = window.electronAPI;
    if (
      !electronApi ||
      !selectedPair ||
      isTogglingDoNotUpload ||
      isPersistingRotation ||
      isUploading ||
      !isHydrated
    ) {
      return;
    }

    const pair = selectedPair;
    setIsTogglingDoNotUpload(true);
    setDoNotUploadError(null);

    try {
      if (hasUserChangedRef.current && !(await persistCurrentPair())) {
        setDoNotUploadError({
          pairId: pair.id,
          message:
            "The flag was not changed because unsaved changes could not be saved.",
        });
        return;
      }

      const result = await electronApi.setDoNotUpload({
        frontPath: pair.frontPath,
        backPath: pair.backPath,
        value: !pair.doNotUpload,
      });
      setPairs((current) =>
        current.map((candidate) =>
          candidate.id === pair.id
            ? {
                ...candidate,
                id: result.id,
                imageLabel: result.imageLabel,
                frontPath: result.frontPath,
                backPath: result.backPath,
                doNotUpload: result.doNotUpload,
                excludeMismatch: result.excludeMismatch,
              }
            : candidate,
        ),
      );
    } catch (error) {
      setDoNotUploadError({
        pairId: pair.id,
        message:
          error instanceof Error
            ? error.message
            : "Unable to change the Do not upload flag.",
      });
    } finally {
      setIsTogglingDoNotUpload(false);
    }
  }, [
    isHydrated,
    isPersistingRotation,
    isTogglingDoNotUpload,
    isUploading,
    persistCurrentPair,
    selectedPair,
  ]);

  /**
   * Handles keyboard events for navigation and image rotation hotkeys (q, w, e, r, arrow keys).
   * Rotates images on Q/W/E/R or navigates with arrow keys when inputs are not focused.
   */
  useEffect(() => {
    /**
     * Handles keyboard events for image rotation hotkeys (q/w/e/r) and navigation (arrow keys).
     * Does nothing when inputs are focused or during busy operations.
     */
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName ?? "";
      const key = event.key.toLowerCase();
      const isRotationHotkeyBlocked =
        target === descriptionInputRef.current ||
        target === tagInputRef.current ||
        Boolean(target?.closest(".immich-content input"));

      if (isPersistingRotation || isUploading || !isHydrated) {
        return;
      }

      // Space toggles "Do not upload" except where it types text or activates a control.
      const isDoNotUploadHotkeyBlocked =
        isRotationHotkeyBlocked ||
        event.repeat ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        ["BUTTON", "SELECT", "TEXTAREA", "SUMMARY", "A"].includes(tagName) ||
        (tagName === "INPUT" &&
          ["checkbox", "radio", "range"].includes(
            (target as HTMLInputElement).type,
          )) ||
        Boolean(target?.closest("dialog"));
      if (key === " " && !isDoNotUploadHotkeyBlocked) {
        event.preventDefault();
        void toggleDoNotUpload();
        return;
      }

      if (!isRotationHotkeyBlocked) {
        if (key === "q") {
          event.preventDefault();
          rotateImage("front", -90);
          return;
        }

        if (key === "w") {
          event.preventDefault();
          rotateImage("front", 90);
          return;
        }

        if (selectedPair?.backPath) {
          if (key === "e") {
            event.preventDefault();
            rotateImage("back", -90);
            return;
          }

          if (key === "r") {
            event.preventDefault();
            rotateImage("back", 90);
            return;
          }
        }
      }

      if (["INPUT", "TEXTAREA", "SELECT"].includes(tagName)) {
        return;
      }

      if (key === "arrowleft") {
        event.preventDefault();
        void navigateToIndex(selectedIndex - 1);
      }

      if (key === "arrowright") {
        event.preventDefault();
        void navigateToIndex(selectedIndex + 1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    isPersistingRotation,
    isHydrated,
    isUploading,
    navigateToIndex,
    rotateImage,
    selectedIndex,
    selectedPair?.backPath,
    toggleDoNotUpload,
  ]);

  /**
   * Updates a metadata form field value (date or description).
   * Marks the current pair as having user changes that need to be persisted.
   * @param field - The field to update ("date" or "description").
   * @param value - The new value for the field.
   */
  const updateFormField = (field: "date" | "description", value: string) => {
    hasUserChangedRef.current = true;
    setMetadata((current) => ({ ...current, [field]: value }));
  };

  /**
   * Updates the tags array for the current pair's metadata.
   * Marks the current pair as having user changes that need to be persisted.
   * @param tags - The new array of tag strings.
   */
  const updateTags = (tags: string[]) => {
    hasUserChangedRef.current = true;
    setMetadata((current) => ({ ...current, tags }));
  };

  /**
   * Adds a new tag from user input to the current pair's metadata if it doesn't already exist.
   * Moves the added tag to the front of recent tags and clears the input field.
   */
  const addTag = () => {
    const tag = tagInput.trim();
    if (!tag) {
      return;
    }

    const isAlreadySelected = metadata.tags.some(
      (selectedTag) =>
        selectedTag.toLocaleLowerCase() === tag.toLocaleLowerCase(),
    );
    if (!isAlreadySelected) {
      updateTags([...metadata.tags, tag]);
    }

    setRecentTags((current) => [
      tag,
      ...current.filter(
        (recentTag) =>
          recentTag.toLocaleLowerCase() !== tag.toLocaleLowerCase(),
      ),
    ]);
    setTagInput("");
  };

  /**
   * Toggles a tag in the selected tags array - removes it if present, adds it if absent.
   * @param tag - The tag string to toggle (add or remove).
   */
  const toggleTag = (tag: string) => {
    const selectedTagIndex = metadata.tags.findIndex(
      (selectedTag) =>
        selectedTag.toLocaleLowerCase() === tag.toLocaleLowerCase(),
    );
    updateTags(
      selectedTagIndex === -1
        ? [...metadata.tags, tag]
        : metadata.tags.filter((_, index) => index !== selectedTagIndex),
    );
  };

  /**
   * Updates date segment values (month/day/year) and synchronizes with the metadata date field.
   * When a complete valid date is entered, the date form field is updated accordingly.
   * @param next - The updated date segments object with month, day, and year digits.
   */
  const updateDateSegments = (next: DateSegments) => {
    dateSegmentsRef.current = next;
    setDateSegments(next);
    const nextDate = toIsoDate(next);
    if (nextDate && nextDate !== metadata.date) {
      updateFormField("date", nextDate);
    }
  };

  /**
   * Handles individual date segment (month/day/year) input changes with digit validation and focus jumping.
   * Automatically moves focus to the next field when a valid partial value is entered.
   * @param field - The date segment field that changed ("month", "day", or "year").
   * @param value - The new digit string value for the field.
   */
  const handleDateSegmentChange = (
    field: keyof DateSegments,
    value: string,
  ) => {
    const digits = value.replace(/\D/g, "").slice(0, field === "year" ? 4 : 2);
    const next = { ...dateSegmentsRef.current, [field]: digits };
    clearPendingSave();
    updateDateSegments(next);

    // Advance once the segment is complete, including single digits that cannot start a
    // valid two-digit value (e.g. "3" for March); blur pads them to two digits.
    const segmentNumber = Number(digits);
    const isMonthComplete =
      digits.length === 2
        ? segmentNumber >= 1 && segmentNumber <= 12
        : segmentNumber >= 2;
    const isDayComplete =
      digits.length === 2
        ? segmentNumber >= 1 && segmentNumber <= 31
        : segmentNumber >= 4;
    if (field === "month" && digits && isMonthComplete) {
      dayInputRef.current?.focus();
    } else if (field === "day" && digits && isDayComplete) {
      yearInputRef.current?.focus();
    }
  };

  /**
   * Handles keyboard events for the image number navigation input field.
   * Navigates to the specified image index when Enter is pressed with a valid number.
   * @param event - The React keyboard event containing the key pressed.
   */
  const handleImageNumberKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ) => {
    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    const imageNumber = Number(imageNumberInput);
    if (
      !Number.isInteger(imageNumber) ||
      imageNumber < 1 ||
      imageNumber > displayPairs.length
    ) {
      setStatus(`Enter an image number from 1 to ${displayPairs.length}.`);
      return;
    }

    void navigateToIndex(imageNumber - 1);
  };

  /**
   * Validates and completes a date segment value on blur by filling missing digits with defaults.
   * Updates the metadata date field if the resulting ISO date differs from the current value.
   * @param field - The date segment that lost focus ("month", "day", or "year").
   */
  const handleDateSegmentBlur = (field: keyof DateSegments) => {
    const current = dateSegmentsRef.current;
    const next = {
      ...current,
      [field]: completeDateSegment(current[field], field),
    };
    updateDateSegments(next);
    if (!toIsoDate(next)) {
      setStatus("Enter a valid month, day, and year before saving.");
    }
  };

  /**
   * Handles keyboard events for the description input field, navigating to the next image on Enter.
   * Persists current pair's changes and advances navigation when at the last image.
   * @param event - The React keyboard event containing the key pressed.
   */
  const handleDescriptionKeyDown = async (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ) => {
    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    if (selectedIndex + 1 >= displayPairs.length) {
      if (selectedPair && hasUserChangedRef.current) {
        try {
          if (await persistCurrentPair()) {
            setStatus(formatSavedStatus(selectedPair.imageLabel));
          }
        } catch (error) {
          setStatus(
            error instanceof Error
              ? error.message
              : "Unable to save the metadata.",
          );
        }
      }
      return;
    }

    await navigateToIndex(selectedIndex + 1);
  };

  /**
   * Handles keyboard events for date segment inputs, validating and completing values on Enter key.
   * Navigates to the next image after persisting changes or shows an error if date is invalid.
   * @param event - The React keyboard event containing the key pressed.
   * @param field - The date segment field associated with this input ("month", "day", or "year").
   */
  const handleDateKeyDown = async (
    event: ReactKeyboardEvent<HTMLInputElement>,
    field: keyof DateSegments,
  ) => {
    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    const current = dateSegmentsRef.current;
    const next = {
      ...current,
      [field]: completeDateSegment(current[field], field),
    };
    const nextDate = toIsoDate(next);
    if (!nextDate) {
      setStatus("Enter a valid month, day, and year before saving.");
      return;
    }

    clearPendingSave();
    updateDateSegments(next);
    const formValues =
      nextDate === metadata.date ? metadata : { ...metadata, date: nextDate };

    if (selectedIndex + 1 >= displayPairs.length) {
      if (selectedPair && hasUserChangedRef.current) {
        try {
          await savePairMetadata(selectedPair, formValues);
          setStatus(formatSavedStatus(selectedPair.imageLabel));
        } catch (error) {
          setStatus(
            error instanceof Error
              ? error.message
              : "Unable to save the metadata.",
          );
        }
      }
      return;
    }

    await navigateToIndex(selectedIndex + 1, formValues);
  };

  /**
   * Loads images from a selected directory by persisting any pending changes first.
   * Scans the directory for photos and displays them in pairs based on file creation time.
   */
  /**
   * Loads images from a selected directory by persisting any pending changes first.
   * Scans the directory for photos and displays them in pairs based on file creation time.
   */
  const handleChooseDirectory = async () => {
    if (!window.electronAPI) {
      setStatus("This application must run inside Electron.");
      return;
    }

    setIsBusy(true);
    setStatus("Scanning directory for photos...");

    try {
      const selectedDirectory = await window.electronAPI.chooseDirectory();
      if (!selectedDirectory) {
        setStatus("No directory selected.");
        return;
      }

      if (!(await persistCurrentPair())) {
        return;
      }

      setStatus("Scanning directory for photos...");
      const result = await window.electronAPI.readDirectory(
        selectedDirectory,
        sortBy,
      );
      setDirectoryPath(result.directoryPath);
      setIsHydrated(false);
      setPairs(result.files);
      resetSavedPairs();
      setImageFilter("all");
      setRecentTags(result.recentTags);
      setImageNumberInput("1");
      setSelectedPairId(result.files[0]?.id ?? null);

      if (!result.files.length) {
        setStatus("No supported images were found in that directory.");
        return;
      }

      setStatus(
        `Loaded ${result.files.length} photo group${result.files.length === 1 ? "" : "s"}.`,
      );
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "Unable to read the selected directory.",
      );
    } finally {
      setIsBusy(false);
    }
  };

  /**
   * Reloads and re-sorts images in the current directory with a new sort option.
   * Persists any pending changes before refreshing the image list.
   * @param nextSortBy - The new sort field and direction to apply (e.g., "createdAt-asc").
   */
  const reloadDirectory = useCallback(
    async (nextSortBy: SortOption) => {
      if (!window.electronAPI || !directoryPath) {
        setSortBy(nextSortBy);
        return;
      }

      if (!(await persistCurrentPair())) {
        return;
      }

      setIsBusy(true);
      setStatus("Sorting photos...");

      try {
        const result = await window.electronAPI.readDirectory(
          directoryPath,
          nextSortBy,
        );
        setSortBy(nextSortBy);
        setIsHydrated(false);
        setPairs(result.files);
        resetSavedPairs();
        setRecentTags(result.recentTags);
        setImageNumberInput("1");
        setSelectedPairId(
          filterImagePairs(result.files, imageFilter, new Set())[0]?.id ??
            null,
        );
        setStatus(
          `Loaded ${result.files.length} photo group${result.files.length === 1 ? "" : "s"}.`,
        );
      } catch (error) {
        setStatus(
          error instanceof Error
            ? error.message
            : "Unable to sort the selected directory.",
        );
      } finally {
        setIsBusy(false);
      }
    },
    [directoryPath, imageFilter, persistCurrentPair, resetSavedPairs],
  );

  /**
   * Switches the image filter after persisting pending changes to the current
   * pair, then selects the first image in the newly filtered list.
   * @param nextFilter - The filter to apply.
   */
  const changeImageFilter = useCallback(
    async (nextFilter: ImageFilter) => {
      if (nextFilter === imageFilter) {
        return;
      }

      if (!(await persistCurrentPair())) {
        return;
      }

      // Take the snapshot now: images saved later stay in this list until the
      // filter is changed again or the folder is reloaded.
      const snapshot = savedPairIdsRef.current;
      const firstPairId =
        filterImagePairs(pairs, nextFilter, snapshot)[0]?.id ?? null;
      if (firstPairId !== selectedPairId) {
        setIsHydrated(false);
      }
      setFilterSnapshotPairIds(snapshot);
      setImageFilter(nextFilter);
      setSelectedPairId(firstPairId);
      setImageNumberInput("1");
    },
    [imageFilter, pairs, persistCurrentPair, selectedPairId],
  );

  /**
   * Updates an Immich setting field with a new value and persists it to storage.
   * @template Field - The name of the setting field to update (e.g., "serverUrl", "userApiKey").
   * @param field - The setting field identifier.
   * @param value - The new value for this field.
   */
  const updateImmichSetting = <Field extends keyof ImmichSettings>(
    field: Field,
    value: ImmichSettings[Field],
  ) => {
    setImmichSettings((current) => ({ ...current, [field]: value }));
  };

  /**
   * Handles the upload of images to Immich after applying pending image rotations.
   * Saves settings, processes any outstanding rotation tasks, then uploads the directory.
   */
  const handleImmichUpload = async () => {
    const electronApi = window.electronAPI;
    if (!electronApi) {
      setImmichStatus("This application must run inside Electron.");
      return;
    }

    if (!directoryPath) {
      setImmichStatus("Load an image directory before uploading.");
      return;
    }

    try {
      setImmichStatus("Applying pending image rotation before upload...");
      if (!(await persistCurrentPair())) {
        setImmichStatus(
          "Upload stopped because an image rotation could not be persisted.",
        );
        return;
      }

      setIsUploading(true);
      setUploadElapsedSeconds(0);
      setImmichOutput("");
      isImmichOutputFollowingRef.current = true;
      setImmichStatus("Uploading the selected directory to Immich...");
      const savedSettings =
        await electronApi.saveImmichSettings(immichSettings);
      setImmichSettings(savedSettings);
      const result = await electronApi.uploadToImmich(
        savedSettings,
        directoryPath,
      );
      setImmichOutput(result.output);
      setImmichStatus(
        result.ok
          ? "Immich upload completed successfully."
          : `Immich upload failed with exit code ${result.exitCode}.`,
      );
    } catch (error) {
      setImmichStatus(
        error instanceof Error ? error.message : "Unable to upload to Immich.",
      );
    } finally {
      setIsUploading(false);
    }
  };

  /**
   * Sets the date on all image pairs in the current directory that do not yet
   * have an XMP sidecar file to the specified target date.
   * @param date - The target ISO date string chosen from the modal.
   */
  const handleConfirmSetFolderDate = async (date: string) => {
    if (!directoryPath) {
      setStatus("Select a directory before setting dates.");
      return;
    }

    setIsSettingFolderDate(true);
    setStatus(`Setting date for images without saved metadataâ€¦`);

    try {
      const electronApi = window.electronAPI;
      if (!electronApi) {
        throw new Error("API is not available.");
      }

      const result = await electronApi.setFolderDate(directoryPath, date);
      const failedLabels = result.errors.map((error) => error.split(": ")[0]);
      markPairsSaved(
        pairs
          .filter((pair) => !failedLabels.includes(pair.imageLabel))
          .map((pair) => pair.id),
      );

      if (result.ok) {
        const parts: string[] = [];
        if (result.updatedPairs > 0) {
          parts.push(
            `Set date to ${date} for ${result.updatedPairs} image group${result.updatedPairs === 1 ? "" : "s"}.`,
          );
        }
        if (result.skippedPairs > 0) {
          parts.push(
            `Skipped ${result.skippedPairs} group${result.skippedPairs === 1 ? "" : "s"} with existing metadata.`,
          );
        }
        if (result.excludedPairs > 0) {
          parts.push(
            `Skipped ${result.excludedPairs} group${result.excludedPairs === 1 ? "" : "s"} flagged Do not upload.`,
          );
        }
        if (parts.length === 0) {
          parts.push("No images without existing metadata were found.");
        }
        setStatus(parts.join(" "));
      } else {
        setStatus(
          `Date set for ${result.updatedPairs} image group${result.updatedPairs === 1 ? "" : "s"} with ${result.errors.length} error${result.errors.length === 1 ? "" : "s"}: ${result.errors.slice(0, 2).join("; ")}${result.errors.length > 2 ? "â€¦" : ""}`,
        );
      }

      setIsSetFolderDateModalOpen(false);
      // Reload the current pair's metadata to reflect any write that may have
      // affected the currently displayed image.
      setIsHydrated(false);
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "Unable to set the date for all images.",
      );
    } finally {
      setIsSettingFolderDate(false);
    }
  };
  const canUploadToImmich =
    Boolean(directoryPath) &&
    Boolean(immichSettings.serverUrl.trim()) &&
    Boolean(immichSettings.userApiKey.trim());
  const isTransitionLocked =
    isBusy ||
    isPersistingRotation ||
    isUploading ||
    isSettingFolderDate ||
    isTogglingDoNotUpload;
  const flaggedPairCount = pairs.filter((pair) => pair.doNotUpload).length;
  const selectedDoNotUploadError =
    doNotUploadError && doNotUploadError.pairId === selectedPair?.id
      ? doNotUploadError.message
      : "";
  const isImageControlLocked = isTransitionLocked || !isHydrated;
  const imageStackStyle: ImageStackStyle = {
    "--collapsed-image-height": `${collapsedImageHeight}px`,
  };

  return (
    <div className="app-shell">
      <header className="toolbar">
        <div>
          <p className="eyebrow">Local workflow</p>
          <h1>Image Parser</h1>
        </div>
        <div className="toolbar-actions">
          {currentUser?.authMode === "oidc" ? (
            <>
              <span className="signed-in-user">
                Signed in as <strong>{currentUser.username}</strong>
              </span>
              <a className="secondary-button" href="auth/logout">
                Sign out
              </a>
            </>
          ) : null}
          {directoryPath ? (
            <button
              type="button"
              className="secondary-button"
              onClick={() => setIsSetFolderDateModalOpen(true)}
              disabled={isTransitionLocked}
              title="Set a date for all images in this folder that don't yet have saved metadata"
            >
              {isSettingFolderDate ? "Setting date\u2026" : "Set date for all"}
            </button>
          ) : null}
          <button
            type="button"
            className="primary-button"
            onClick={handleChooseDirectory}
            disabled={isTransitionLocked}
          >
            {directoryPath ? "Choose different folder" : "Load directory"}
          </button>
        </div>
      </header>

      <div className="status-bar">
        <span>{status}</span>
        {directoryPath ? <strong>{directoryPath}</strong> : null}
      </div>

      {!directoryPath ? (
        <section className="empty-state">
          <p>Select a local directory to review your images.</p>
        </section>
      ) : (
        <main className="workspace">
          <aside className="metadata-panel">
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
                    {...selectAllOnFocusProps}
                    onChange={(event) =>
                      handleDateSegmentChange("month", event.target.value)
                    }
                    onBlur={() => handleDateSegmentBlur("month")}
                    onKeyDown={(event) =>
                      void handleDateKeyDown(event, "month")
                    }
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
                    {...selectAllOnFocusProps}
                    onChange={(event) =>
                      handleDateSegmentChange("day", event.target.value)
                    }
                    onBlur={() => handleDateSegmentBlur("day")}
                    onKeyDown={(event) => void handleDateKeyDown(event, "day")}
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
                    {...selectAllOnFocusProps}
                    onChange={(event) =>
                      handleDateSegmentChange("year", event.target.value)
                    }
                    onBlur={() => handleDateSegmentBlur("year")}
                    onKeyDown={(event) => void handleDateKeyDown(event, "year")}
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
                  {...selectAllOnFocusProps}
                  onChange={(event) =>
                    updateFormField("description", event.target.value)
                  }
                  placeholder="Image description"
                  onKeyDown={(event) => void handleDescriptionKeyDown(event)}
                  disabled={isPersistingRotation || isUploading}
                />
              </label>

              <details
                className="metadata-details"
                open={isMetadataEntryExpanded}
                onToggle={(event) =>
                  setIsMetadataEntryExpanded(event.currentTarget.open)
                }
              >
                <summary className="metadata-details-summary">
                  <span>Tags</span>
                  <span className="metadata-details-action">
                    {isMetadataEntryExpanded ? "Collapse" : "Expand"}
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
                          if (event.key === "Enter" || event.key === ",") {
                            event.preventDefault();
                            addTag();
                          }
                        }}
                        placeholder="Type a new tag"
                        disabled={isPersistingRotation || isUploading}
                      />
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={addTag}
                        disabled={
                          !tagInput.trim() ||
                          isPersistingRotation ||
                          isUploading
                        }
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
                                  selectedTag.toLocaleLowerCase() ===
                                  tag.toLocaleLowerCase(),
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

              <div className="do-not-upload">
                <button
                  type="button"
                  className={`secondary-button do-not-upload-toggle${
                    selectedPair?.doNotUpload
                      ? " do-not-upload-toggle--active"
                      : ""
                  }`}
                  aria-label="Do not upload"
                  aria-pressed={selectedPair?.doNotUpload ?? false}
                  aria-describedby="do-not-upload-help"
                  title="Do not upload (Space)"
                  onClick={() => void toggleDoNotUpload()}
                  disabled={!selectedPair || isImageControlLocked}
                >
                  <svg
                    className="do-not-upload-icon"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <path d="M12 16V5M7 10l5-5 5 5M5 19h14M4 4l16 16" />
                  </svg>
                </button>
                <span id="do-not-upload-help" className="visually-hidden">
                  Press Space to toggle. Flagged files are renamed with
                  &ldquo;_exclude&rdquo; and skipped by Immich uploads.
                </span>
              </div>
            </div>

            {selectedPair?.excludeMismatch ? (
              <p className="do-not-upload-warning" role="status">
                Only one side of this group is flagged Do not upload. Toggle the
                flag to rename both sides to match.
              </p>
            ) : null}
            {selectedDoNotUploadError ? (
              <p className="do-not-upload-error" role="alert">
                {selectedDoNotUploadError}
              </p>
            ) : null}
          </aside>

          <section className="viewer-panel">
            <div className="viewer-toolbar">
              <label className="sort-control">
                <span>Sort by</span>
                <select
                  value={sortBy}
                  onChange={(event) => {
                    const nextSortBy = event.target.value as SortOption;
                    void reloadDirectory(nextSortBy);
                  }}
                  disabled={isImageControlLocked}
                >
                  <option value="createdAt-asc">
                    File created (oldest first)
                  </option>
                  <option value="createdAt-desc">
                    File created (newest first)
                  </option>
                  <option value="dateTaken-asc">
                    Date taken (oldest first)
                  </option>
                  <option value="dateTaken-desc">
                    Date taken (newest first)
                  </option>
                  <option value="fileName-asc">File name (A-Z)</option>
                  <option value="fileName-desc">File name (Z-A)</option>
                </select>
              </label>
              <label className="sort-control filter-control">
                <span>Show</span>
                <select
                  value={imageFilter}
                  onChange={(event) => {
                    if (isImageFilter(event.target.value)) {
                      void changeImageFilter(event.target.value);
                    }
                  }}
                  disabled={
                    isTransitionLocked || (!isHydrated && selectedPair !== null)
                  }
                >
                  {imageFilterOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label} ({filterCounts[option.value]})
                    </option>
                  ))}
                </select>
              </label>
              <label
                className="size-control"
                title={
                  isExpanded
                    ? "Image height applies to the collapsed view"
                    : undefined
                }
              >
                <span>Image height</span>
                <input
                  type="range"
                  min={MIN_COLLAPSED_IMAGE_HEIGHT}
                  max={MAX_COLLAPSED_IMAGE_HEIGHT}
                  step={COLLAPSED_IMAGE_HEIGHT_STEP}
                  value={collapsedImageHeight}
                  onChange={(event) =>
                    setCollapsedImageHeight(
                      clampCollapsedImageHeight(Number(event.target.value)),
                    )
                  }
                  aria-valuetext={`${collapsedImageHeight} pixels`}
                  disabled={isExpanded}
                />
                <output aria-hidden="true">{collapsedImageHeight}px</output>
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
                  max={displayPairs.length}
                  value={imageNumberInput}
                  onChange={(event) => setImageNumberInput(event.target.value)}
                  onKeyDown={handleImageNumberKeyDown}
                  disabled={isImageControlLocked}
                  aria-label={`Go to image number, current image ${selectedIndex + 1} of ${displayPairs.length}`}
                />
                <span aria-hidden="true">/ {displayPairs.length}</span>
              </label>
              <button
                type="button"
                onClick={() => void navigateToIndex(selectedIndex + 1)}
                disabled={
                  selectedIndex >= displayPairs.length - 1 ||
                  isImageControlLocked
                }
              >
                Next
              </button>
            </div>

            <div
              className={`image-stack${
                !selectedPair || !selectedPair.backPath || isExpanded
                  ? " image-stack--single"
                  : ""
              }${isExpanded ? " image-stack--expanded" : ""}`}
              style={imageStackStyle}
            >
              {displayPairs.length > 0 ? (
                <>
                  <div className="image-card">
                    <div className="image-card-header">
                      <div className="image-label">
                        Front image
                        {selectedPair?.doNotUpload ? (
                          <span className="do-not-upload-badge">
                            Do not upload
                          </span>
                        ) : null}
                      </div>
                      <div className="image-actions">
                        <button
                          type="button"
                          onClick={() => rotateImage("front", -90)}
                          disabled={isImageControlLocked}
                        >
                          Rotate left
                        </button>
                        <button
                          type="button"
                          onClick={() => rotateImage("front", 90)}
                          disabled={isImageControlLocked}
                        >
                          Rotate right
                        </button>
                        <button
                          type="button"
                          onClick={toggleExpanded}
                          disabled={isImageControlLocked}
                        >
                          {isExpanded ? "Collapse" : "Expand"}
                        </button>
                      </div>
                    </div>
                    <MagnifiedImage
                      filePath={selectedPair?.frontPath ?? ""}
                      altText={`${selectedPair?.imageLabel ?? ""}`}
                      rotation={rotations.front}
                    />
                  </div>

                  {selectedPair && selectedPair.backPath ? (
                    <div className="image-card">
                      <div className="image-card-header">
                        <div className="image-label">Back image</div>
                        <div className="image-actions">
                          <button
                            type="button"
                            onClick={() => rotateImage("back", -90)}
                            disabled={isImageControlLocked}
                          >
                            Rotate left
                          </button>
                          <button
                            type="button"
                            onClick={() => rotateImage("back", 90)}
                            disabled={isImageControlLocked}
                          >
                            Rotate right
                          </button>
                          <button
                            type="button"
                            onClick={toggleExpanded}
                            disabled={isImageControlLocked}
                          >
                            {isExpanded ? "Collapse" : "Expand"}
                          </button>
                        </div>
                      </div>
                      <MagnifiedImage
                        filePath={selectedPair?.backPath ?? ""}
                        altText={`${selectedPair?.imageLabel ?? ""} backside`}
                        rotation={rotations.back}
                      />
                    </div>
                  ) : null}
                </>
              ) : (
                <p role="status">
                  {getEmptyFilterMessage(imageFilter, pairs.length)}
                </p>
              )}
            </div>
          </section>

          <details className="immich-panel">
            <summary className="immich-panel-summary">
              <span>
                <span className="eyebrow">Final step</span>
                <span className="immich-panel-title">Upload to Immich</span>
              </span>
              <span className="immich-summary-action">
                Configure and upload
              </span>
            </summary>

            <div className="immich-content">
              <span className="immich-directory">Uploads: {directoryPath}</span>
              {flaggedPairCount > 0 ? (
                <span className="immich-skipped">
                  {flaggedPairCount} image{flaggedPairCount === 1 ? "" : "s"}{" "}
                  flagged Do not upload will be skipped.
                </span>
              ) : null}

              <div className="immich-grid">
                <label>
                  Server URL
                  <input
                    type="url"
                    value={immichSettings.serverUrl}
                    onChange={(event) =>
                      updateImmichSetting("serverUrl", event.target.value)
                    }
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
                    onChange={(event) =>
                      updateImmichSetting("userApiKey", event.target.value)
                    }
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
                    onChange={(event) =>
                      updateImmichSetting("adminApiKey", event.target.value)
                    }
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
                    onChange={(event) =>
                      updateImmichSetting("albumName", event.target.value)
                    }
                    required
                    disabled={isUploading}
                  />
                </label>

                <label className="immich-tags">
                  Tags
                  <input
                    type="text"
                    value={immichSettings.tags}
                    onChange={(event) =>
                      updateImmichSetting("tags", event.target.value)
                    }
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
                      updateImmichSetting(
                        "concurrentTasks",
                        Number(event.target.value),
                      )
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
                      updateImmichSetting(
                        "pauseImmichJobs",
                        event.target.checked,
                      )
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
                  {isUploading ? "Uploading..." : "Upload to Immich"}
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
                      Processing for {formatElapsedTime(uploadElapsedSeconds)}.
                      Activity below updates while immich-go is running.
                    </span>
                  </div>
                ) : null}
                {immichOutput ? (
                  <pre
                    ref={immichOutputRef}
                    onScroll={(event) => {
                      const outputElement = event.currentTarget;
                      const distanceFromBottom =
                        outputElement.scrollHeight -
                        outputElement.scrollTop -
                        outputElement.clientHeight;
                      isImmichOutputFollowingRef.current =
                        distanceFromBottom < 24;
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

      <SetFolderDateModal
        isOpen={isSetFolderDateModalOpen}
        totalCount={pairs.length}
        onConfirm={(date) => void handleConfirmSetFolderDate(date)}
        onClose={() => setIsSetFolderDateModalOpen(false)}
        isSubmitting={isSettingFolderDate}
      />
    </div>
  );
}

export default App;
