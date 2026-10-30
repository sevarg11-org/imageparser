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
  type SyntheticEvent,
} from "react";
import "./App.css";
import { chooseDirectory } from "./chooseDirectory";
import {
  completeDateSegment,
  parseDateSegments,
  toIsoDate,
  type DateSegments,
} from "./dateEntry";
import type { DirectoryListing } from "./DirectoryBrowser";
import {
  describeFolderState,
  unprocessedFolderState,
  type FolderState,
  type SetFolderProcessedResult,
} from "./folderState";
import {
  describeSaveFailure,
  describeUnsavedImages,
  getRemainingRotations,
  getRotatedImageBox,
  getUpdatedImageVersions,
  mapRotatedPointToImage,
  needsSaveOnLeave,
  rotatePoint,
  type ImageSaveResult,
  type PairRotationState,
  type RotationField,
} from "./pairPersistence";
import {
  countImageFilterMatches,
  filterImagePairs,
  getEmptyFilterMessage,
  imageFilterOptions,
  isImageFilter,
  isPairProcessed,
  type ImageFilter,
} from "./imageFilters";
import { AddTagsModal } from "./AddTagsModal";
import AlbumCombobox from "./AlbumCombobox";
import { SetFolderDateModal } from "./SetFolderDateModal";
import { ThumbnailGrid } from "./ThumbnailGrid";
import {
  GRID_THUMBNAIL_SIZE,
  type ThumbnailGridCell,
} from "./thumbnailGridModel";
import TagInput from "./TagInput";
import { mergeTagSources } from "./tagSuggestions";
import {
  fetchCurrentUser,
  isWebApp,
  loadImmichTags,
  type CurrentUser,
} from "./webApi";

type ImagePair = {
  id: string;
  /** The A-file name, prefixed with its folder relative to the loaded folder in nested mode. */
  imageLabel: string;
  /** The pair's folder relative to the loaded folder, with forward slashes; "" for the loaded folder itself. */
  relativeDirectory: string;
  frontPath: string;
  backPath: string | null;
  frontVersion: string;
  backVersion: string | null;
  createdAt: number;
  doNotUpload: boolean;
  excludeMismatch: boolean;
  hasSidecar: boolean;
  /** The A-file XMP date as YYYY-MM-DD when the folder was read, or an empty string. */
  sidecarDate: string;
};

type ViewMode = "grid" | "review";

type SetDoNotUploadResult = Pick<
  ImagePair,
  | "id"
  | "imageLabel"
  | "frontPath"
  | "backPath"
  | "frontVersion"
  | "backVersion"
  | "doNotUpload"
  | "excludeMismatch"
> & {
  ok: boolean;
  renamed: Array<{ from: string; to: string }>;
};

type SidecarValues = {
  date: string;
  description: string;
  tags: string[];
  rotation: number;
  hasSidecar: boolean;
};

type UnsavedPairEdits = {
  imageLabel: string;
  formValues: MetadataForm;
  rotations: PairRotationState;
};

type SortField = "createdAt" | "dateTaken" | "fileName";
type SortDirection = "asc" | "desc";
type SortOption = `${SortField}-${SortDirection}`;

type MetadataForm = {
  date: string;
  description: string;
  tags: string[];
};

/** Immich settings the web server provides (environment or sign-in), which the user cannot edit. */
type ImmichManagedFields = {
  serverUrl: boolean;
  userApiKey: boolean;
  adminApiKey: boolean;
};

type ImmichSettings = {
  serverUrl: string;
  userApiKey: string;
  adminApiKey: string;
  albumName: string;
  tags: string;
  pauseImmichJobs: boolean;
  concurrentTasks: number;
  /** Set by the web server only; managed keys are never sent to the browser. */
  managed?: ImmichManagedFields;
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
  version?: string;
  error?: string;
};

type SaveMetadataResult = {
  ok: boolean;
  updatedFiles: number;
  sidecarFile: string;
  sidecarWritten: boolean;
  results: ImageSaveResult[];
};

type ApplyImageRotationsResult = {
  ok: boolean;
  updatedFiles: number;
  results: ImageRotationResult[];
};

declare global {
  interface Window {
    electronAPI?: {
      browseDirectory: (
        directoryPath: string | null,
      ) => Promise<DirectoryListing>;
      readDirectory: (
        directoryPath: string,
        sortBy: SortOption,
        recursive: boolean,
      ) => Promise<{
        directoryPath: string;
        /** Whether nested folders were included. */
        recursive: boolean;
        /** The number of folders scanned, including the loaded folder. */
        folderCount: number;
        files: ImagePair[];
        recentTags: string[];
        folderState: FolderState;
        hasSubfolders: boolean;
      }>;
      readSidecarMetadata: (filePath: string) => Promise<SidecarValues>;
      saveMetadata: (metadata: {
        frontPath: string;
        backPath: string | null;
        date: string;
        description: string;
        tags: string[];
        frontRotation: number;
        backRotation: number;
      }) => Promise<SaveMetadataResult>;
      getPreviewDataUrl: (filePath: string, version: string) => Promise<string>;
      getThumbnailUrl: (
        filePath: string,
        size: number,
        version: string,
      ) => string;
      applyImageRotations: (request: {
        frontPath: string;
        backPath: string | null;
        frontRotation: number;
        backRotation: number;
      }) => Promise<ApplyImageRotationsResult>;
      setFolderDate: (
        directoryPath: string,
        date: string,
        recursive: boolean,
      ) => Promise<SetFolderDateResult>;
      setPairsDate: (
        pairs: { frontPath: string; backPath: string | null }[],
        date: string,
      ) => Promise<{
        ok: boolean;
        updatedPairs: number;
        failedFrontPaths: string[];
        errors: string[];
      }>;
      addTagsToPairs: (
        pairs: { frontPath: string; backPath: string | null }[],
        tags: string[],
      ) => Promise<{
        ok: boolean;
        updatedPairs: number;
        failedFrontPaths: string[];
        errors: string[];
      }>;
      resetFolderMetadata: (
        directoryPath: string,
        recursive: boolean,
      ) => Promise<{
        ok: boolean;
        deletedFiles: number;
        resetPairs: number;
        errors: string[];
      }>;
      setDoNotUpload: (request: {
        frontPath: string;
        backPath: string | null;
        value: boolean;
        relativeDirectory: string;
      }) => Promise<SetDoNotUploadResult>;
      setFolderProcessed: (
        directoryPath: string,
        value: boolean,
        includeSubfolders: boolean,
      ) => Promise<SetFolderProcessedResult>;
      loadImmichSettings: () => Promise<ImmichSettings>;
      saveImmichSettings: (settings: ImmichSettings) => Promise<ImmichSettings>;
      uploadToImmich: (
        settings: ImmichSettings,
        directoryPath: string,
        recursive: boolean,
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
 * Formats the status shown after a folder loads, naming the folder count in nested mode.
 * @param result - The number of groups found, whether nested folders were included, and how many folders were scanned.
 * @returns A formatted status string.
 */
const describeLoadedGroups = ({
  files,
  recursive,
  folderCount,
}: {
  files: readonly unknown[];
  recursive: boolean;
  folderCount: number;
}) =>
  `Loaded ${files.length} photo group${files.length === 1 ? "" : "s"}${
    recursive
      ? ` from ${folderCount} folder${folderCount === 1 ? "" : "s"}`
      : ""
  }.`;

/**
 * Moves a map entry to a new key, for example after a "Do not upload" rename changes a group's ID.
 * @param map - The map to update.
 * @param from - The old key.
 * @param to - The new key.
 * @returns The updated map, or the same map when there is nothing to move.
 */
const renameMapKey = <Value,>(
  map: ReadonlyMap<string, Value>,
  from: string,
  to: string,
): ReadonlyMap<string, Value> => {
  if (from === to || !map.has(from)) {
    return map;
  }
  const next = new Map(map);
  next.set(to, next.get(from) as Value);
  next.delete(from);
  return next;
};

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
 * Reports whether two paths name the same image, treating a "Do not upload" rename as the same file.
 * Flagging inserts the _exclude marker before the side suffix or extension (img001_exclude_a.jpg).
 * @param previousPath - The path of the shown image.
 * @param nextPath - The path of the image to show.
 * @returns True when the paths differ at most by the _exclude marker.
 */
const isSameImageFile = (previousPath: string, nextPath: string) => {
  const withoutExcludeMarker = (filePath: string) =>
    filePath.replace(/_exclude(?=[_.][^\\/]*$)/, "");
  return (
    previousPath === nextPath ||
    withoutExcludeMarker(previousPath) === withoutExcludeMarker(nextPath)
  );
};

type DisplayedPreview = {
  filePath: string;
  version: string;
  src: string;
  rotation: number;
  naturalWidth: number;
  naturalHeight: number;
};

/**
 * Resolves the preview shown for one version of an image.
 * The web app builds the URL locally; Electron renders TIFF files in the main process.
 * When a save rewrites the shown file (a new date or an applied rotation gives it a new version), or a
 * "Do not upload" toggle renames it, the new preview is downloaded and decoded before it replaces the old
 * one, together with its size. Until then the old image stays, with the rotation it was shown with, so the
 * picture never shrinks, blanks, or flips.
 * @param filePath - The path to the image file.
 * @param version - The file's version; it changes whenever the file is rewritten.
 * @param rotation - The CSS rotation for the current version, in degrees.
 * @returns The shown source URL, the rotation to show it with, its natural size (0 until known), and a load handler for the image element.
 */
const useDisplayedPreview = (
  filePath: string,
  version: string,
  rotation: number,
) => {
  const [shown, setShown] = useState<DisplayedPreview>({
    filePath: "",
    version: "",
    src: "",
    rotation: 0,
    naturalWidth: 0,
    naturalHeight: 0,
  });
  const rotationRef = useRef(rotation);
  const shownRef = useRef(shown);
  const isCurrentVersion =
    shown.filePath === filePath && shown.version === version;

  // While the shown version is current, it keeps the latest rotation, ready for the next version swap.
  if (isCurrentVersion && shown.rotation !== rotation) {
    setShown({ ...shown, rotation });
  }

  useEffect(() => {
    rotationRef.current = rotation;
    shownRef.current = shown;
  });

  useEffect(() => {
    let isActive = true;

    const resolvePreview = async () => {
      let src = "";
      if (filePath) {
        try {
          src = window.electronAPI
            ? (await window.electronAPI.getPreviewDataUrl(filePath, version)) ||
              toFileUrl(filePath)
            : toFileUrl(filePath);
        } catch {
          src = toFileUrl(filePath);
        }
      }
      if (!isActive) {
        return;
      }

      let naturalWidth = 0;
      let naturalHeight = 0;
      const previous = shownRef.current;
      if (
        src &&
        isSameImageFile(previous.filePath, filePath) &&
        previous.src &&
        previous.src !== src
      ) {
        const preloadedImage = new Image();
        preloadedImage.src = src;
        try {
          await preloadedImage.decode();
          naturalWidth = preloadedImage.naturalWidth;
          naturalHeight = preloadedImage.naturalHeight;
        } catch {
          // Show the new version anyway; the image element reports its own loading errors.
        }
        if (!isActive) {
          return;
        }
      }

      setShown({
        filePath,
        version,
        src,
        rotation: rotationRef.current,
        naturalWidth,
        naturalHeight,
      });
    };

    void resolvePreview();

    return () => {
      isActive = false;
    };
  }, [filePath, version]);

  /**
   * Records the natural size of the shown image once the element has loaded it.
   * @param event - The image element's load event.
   */
  const handleImageLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = event.currentTarget;
    const loadedSrc = event.currentTarget.getAttribute("src");
    setShown((current) =>
      current.src === loadedSrc
        ? { ...current, naturalWidth, naturalHeight }
        : current,
    );
  };

  return {
    src: shown.src,
    rotation: isCurrentVersion ? rotation : shown.rotation,
    naturalWidth: shown.naturalWidth,
    naturalHeight: shown.naturalHeight,
    handleImageLoad,
  };
};

const MAGNIFIER_LENS_SIZE = 160;
const MAGNIFIER_ZOOM = 2.5;
const MAGNIFIER_EDGE_BUFFER = 32;

const MagnifiedImage = ({
  filePath,
  version,
  altText,
  rotation: requestedRotation,
  isExpanded,
  collapsedHeight,
}: {
  filePath: string;
  version: string;
  altText: string;
  rotation: number;
  isExpanded: boolean;
  collapsedHeight: number;
}) => {
  // The rotation that matches the shown image, which lags the requested one only while a new version loads.
  const { src, rotation, naturalWidth, naturalHeight, handleImageLoad } =
    useDisplayedPreview(filePath, version, requestedRotation);
  const [isLoading, setIsLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [lensStyle, setLensStyle] = useState<{
    left: number;
    top: number;
    backgroundSize: string;
    backgroundPosition: string;
  } | null>(null);

  /**
   * Tracks the width available to the image, so quarter-turned images can be fitted to it.
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const observer = new ResizeObserver(() => {
      const style = window.getComputedStyle(container);
      setAvailableWidth(
        container.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight),
      );
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // A quarter turn swaps the visible width and height, so the image is sized and centred in a frame
  // that has the rotated proportions.
  const rotatedBox =
    rotation % 180 !== 0 && naturalWidth > 0 && availableWidth > 0
      ? getRotatedImageBox({
          naturalWidth,
          naturalHeight,
          rotation,
          availableWidth,
          targetHeight: isExpanded ? null : collapsedHeight,
        })
      : null;
  const frameStyle: CSSProperties | undefined = rotatedBox
    ? {
        position: "relative",
        width: rotatedBox.width,
        height: rotatedBox.height,
        marginInline: "auto",
      }
    : undefined;
  const imageStyle: CSSProperties | undefined = rotatedBox
    ? {
        position: "absolute",
        left: (rotatedBox.width - rotatedBox.height) / 2,
        top: (rotatedBox.height - rotatedBox.width) / 2,
        width: rotatedBox.height,
        height: rotatedBox.width,
        maxWidth: "none",
        margin: 0,
        transform: `rotate(${rotation}deg)`,
      }
    : rotation
      ? { transform: `rotate(${rotation}deg)` }
      : undefined;

  /**
   * Handles mouse movement events to update the magnifier lens position and style.
   * The lens samples the unrotated image and rotates its contents to match the displayed image.
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

    // offsetWidth/offsetHeight ignore the CSS rotation, giving the unrotated layout size.
    const layoutSize = { width: image.offsetWidth, height: image.offsetHeight };
    const sample = mapRotatedPointToImage(
      { x: sampledImageX, y: sampledImageY },
      { width: imageRect.width, height: imageRect.height },
      layoutSize,
      rotation,
    );
    const pointerInLens = rotatePoint(
      { x: pointerX - lensLeft - halfLens, y: pointerY - lensTop - halfLens },
      -rotation,
    );

    setLensStyle({
      left: lensLeft,
      top: lensTop,
      backgroundSize: `${layoutSize.width * MAGNIFIER_ZOOM}px ${layoutSize.height * MAGNIFIER_ZOOM}px`,
      backgroundPosition: `${halfLens + pointerInLens.x - sample.x * MAGNIFIER_ZOOM}px ${
        halfLens + pointerInLens.y - sample.y * MAGNIFIER_ZOOM
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
      <div className="magnifier-frame" style={frameStyle}>
        <img
          ref={imageRef}
          src={src}
          alt={altText}
          style={imageStyle}
          onLoad={(event) => {
            setIsLoading(false);
            handleImageLoad(event);
          }}
        />
      </div>
      {!isLoading && lensStyle && src ? (
        <div
          className="magnifier-lens"
          style={{
            left: lensStyle.left,
            top: lensStyle.top,
            width: MAGNIFIER_LENS_SIZE,
            height: MAGNIFIER_LENS_SIZE,
          }}
        >
          <div
            className="magnifier-lens-image"
            style={{
              backgroundImage: `url("${src.replace(/"/g, '\\"')}")`,
              backgroundRepeat: "no-repeat",
              backgroundSize: lensStyle.backgroundSize,
              backgroundPosition: lensStyle.backgroundPosition,
              transform: rotation ? `rotate(${rotation}deg)` : undefined,
            }}
          />
        </div>
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

/**
 * Reads the sidecar metadata of both images in a pair.
 * @param electronApi - The desktop or web API.
 * @param pair - The pair to read.
 * @returns The front and back sidecar values (null without a back image).
 */
const readPairSidecars = (
  electronApi: NonNullable<Window["electronAPI"]>,
  pair: ImagePair,
) =>
  Promise.all([
    electronApi.readSidecarMetadata(pair.frontPath),
    pair.backPath
      ? electronApi.readSidecarMetadata(pair.backPath)
      : Promise.resolve(null),
  ]);

function App() {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [directoryPath, setDirectoryPath] = useState("");
  // Set from the folder browser on each load; sorting, set-date, and upload keep using it.
  const [includeNested, setIncludeNested] = useState(false);
  const [folderCount, setFolderCount] = useState(0);
  const [folderState, setFolderState] = useState<FolderState>(
    unprocessedFolderState,
  );
  const [hasSubfolders, setHasSubfolders] = useState(false);
  const [includeSubfoldersInProcessed, setIncludeSubfoldersInProcessed] =
    useState(false);
  const [isSettingFolderProcessed, setIsSettingFolderProcessed] =
    useState(false);
  const [folderProcessedError, setFolderProcessedError] = useState("");
  // Set after a successful upload of the open folder, to offer marking it processed.
  const [hasUploadedFolder, setHasUploadedFolder] = useState(false);
  const [pairs, setPairs] = useState<ImagePair[]>([]);
  const [selectedPairId, setSelectedPairId] = useState<string | null>(null);
  const [savedPairIds, setSavedPairIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Saved IDs as they were when the filter was chosen or the folder loaded.
  const [filterSnapshotPairIds, setFilterSnapshotPairIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [gridFocusPairId, setGridFocusPairId] = useState<string | null>(null);
  // Dates saved since the folder was read, so the grid shows them without reloading.
  // Kept apart from `pairs` because replacing the selected pair would reload it in Review.
  const [savedDates, setSavedDates] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
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
  const [recentTags, setRecentTags] = useState<string[]>([]);
  const [immichTags, setImmichTags] = useState<string[]>([]);
  const [immichTagError, setImmichTagError] = useState("");
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
  const [selectedGridIds, setSelectedGridIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [isSelectedDateModalOpen, setIsSelectedDateModalOpen] = useState(false);
  const [isAddTagsModalOpen, setIsAddTagsModalOpen] = useState(false);
  const [isAddingTags, setIsAddingTags] = useState(false);
  const [addTagsFailures, setAddTagsFailures] = useState<string[]>([]);
  const [isSetFolderDateModalOpen, setIsSetFolderDateModalOpen] =
    useState(false);
  const [isTogglingDoNotUpload, setIsTogglingDoNotUpload] = useState(false);
  const [doNotUploadError, setDoNotUploadError] = useState<{
    pairId: string;
    message: string;
  } | null>(null);
  const [uploadElapsedSeconds, setUploadElapsedSeconds] = useState(0);
  // Versions of files rewritten since the directory was listed, so their previews are reloaded.
  const [imageVersions, setImageVersions] = useState<Record<string, string>>(
    {},
  );
  // The pair whose pending save has finished, so its images can be shown without stale orientation.
  const [readyPairId, setReadyPairId] = useState<string | null>(null);
  const [pairReloadToken, setPairReloadToken] = useState(0);
  const [pendingSaveCount, setPendingSaveCount] = useState(0);
  const hasUserChangedRef = useRef(false);
  // Incremented on every edit, so a save only marks the form clean if nothing changed meanwhile.
  const editRevisionRef = useRef(0);
  const pairHasSidecarRef = useRef(false);
  const selectedPairIdRef = useRef<string | null>(null);
  const pendingSavesRef = useRef(new Map<string, Promise<boolean>>());
  const unsavedEditsRef = useRef(new Map<string, UnsavedPairEdits>());
  const sidecarPrefetchRef = useRef(
    new Map<string, Promise<[SidecarValues, SidecarValues | null]>>(),
  );
  const leavingSaveRef = useRef<{
    pairId: string;
    operation: Promise<boolean>;
  } | null>(null);
  // A-image rotations chosen in the grid that are not on disk yet, by group ID. The grid and
  // Review show them until the file is rotated.
  const [gridRotations, setGridRotations] = useState<
    ReadonlyMap<string, number>
  >(new Map());
  const gridRotationsRef = useRef(new Map<string, number>());
  // Groups whose grid rotation is queued behind another save and has not started yet.
  const queuedGridRotationsRef = useRef(new Set<string>());
  const dateInputRef = useRef<HTMLInputElement | null>(null);
  const dayInputRef = useRef<HTMLInputElement | null>(null);
  const yearInputRef = useRef<HTMLInputElement | null>(null);
  const dateSegmentsRef = useRef(dateSegments);
  const descriptionInputRef = useRef<HTMLInputElement | null>(null);
  const tagInputRef = useRef<HTMLInputElement | null>(null);
  const immichOutputRef = useRef<HTMLPreElement | null>(null);
  const isImmichOutputFollowingRef = useRef(true);

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
    setSavedDates(new Map());
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

  const gridCells = useMemo<ThumbnailGridCell[]>(() => {
    const electronApi = window.electronAPI;
    if (!electronApi) {
      return [];
    }
    return displayPairs.map((pair) => ({
      id: pair.id,
      imageLabel: pair.imageLabel,
      date: savedDates.get(pair.id) ?? pair.sidecarDate,
      isPaired: pair.backPath !== null,
      doNotUpload: pair.doNotUpload,
      isUnprocessed: !pair.doNotUpload && !isPairProcessed(pair, savedPairIds),
      // A rotation or save rewrites the file, giving the thumbnail a new URL.
      thumbnailUrl: electronApi.getThumbnailUrl(
        pair.frontPath,
        GRID_THUMBNAIL_SIZE,
        imageVersions[pair.frontPath] ?? pair.frontVersion,
      ),
      rotation: gridRotations.get(pair.id) ?? 0,
    }));
  }, [displayPairs, gridRotations, imageVersions, savedDates, savedPairIds]);

  /**
   * Loads the user's existing Immich tags for the tag typeahead (web app only). A failed lookup leaves the
   * recent-tag suggestions and free entry in place, with the reason shown.
   */
  useEffect(() => {
    if (!isWebApp()) {
      return;
    }
    let isMounted = true;
    loadImmichTags().then(
      (tags) => {
        if (isMounted) {
          setImmichTags(tags);
          setImmichTagError("");
        }
      },
      (error) => {
        if (isMounted) {
          setImmichTagError(
            error instanceof Error
              ? error.message
              : "Tags could not be loaded.",
          );
        }
      },
    );
    return () => {
      isMounted = false;
    };
  }, []);

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

  /**
   * Records an edit to the current pair, so it is saved when the user moves on.
   */
  const markUserChanged = useCallback(() => {
    hasUserChangedRef.current = true;
    editRevisionRef.current += 1;
  }, []);

  /**
   * Keeps the selected pair's id in a ref, so background saves can tell whether their pair is still shown.
   */
  useEffect(() => {
    selectedPairIdRef.current = selectedPair?.id ?? null;
  }, [selectedPair?.id]);

  /**
   * Records a write to a group's files as its latest pending save, so the next save of the group
   * runs after it, Review waits for it before showing the group, and quitting waits for it.
   * @param pairId - The ID of the image group being written.
   * @param operation - The write, which resolves to whether it succeeded.
   */
  const trackPairOperation = useCallback(
    (pairId: string, operation: Promise<boolean>) => {
      pendingSavesRef.current.set(pairId, operation);
      setPendingSaveCount(pendingSavesRef.current.size);
      void operation.then(() => {
        if (pendingSavesRef.current.get(pairId) === operation) {
          pendingSavesRef.current.delete(pairId);
        }
        setPendingSaveCount(pendingSavesRef.current.size);
      });
    },
    [],
  );

  /**
   * Saves a pair's metadata and applies its pending rotations without blocking the UI.
   * Saves of the same pair run in order. The returned promise never rejects; it resolves to whether the save succeeded.
   * A failed save names the image in the status line and keeps its values (and any rotation not yet applied),
   * so reopening the pair shows the user's edits.
   * @param pair - The pair to save.
   * @param formValues - The pair's form values.
   * @param pairRotations - The rotations to apply to the files (zero to save metadata only).
   * @param editRevision - The edit revision the form values belong to.
   * @returns Whether the save succeeded.
   */
  const startPairSave = useCallback(
    (
      pair: ImagePair,
      formValues: MetadataForm,
      pairRotations: PairRotationState,
      editRevision: number,
    ) => {
      const electronApi = window.electronAPI;
      if (!electronApi) {
        return Promise.resolve(false);
      }

      const appliesRotation =
        pairRotations.front !== 0 || pairRotations.back !== 0;
      const previousSave =
        pendingSavesRef.current.get(pair.id) ?? Promise.resolve(true);
      sidecarPrefetchRef.current.delete(pair.id);

      const operation = previousSave.then(async () => {
        try {
          const result = await electronApi.saveMetadata({
            frontPath: pair.frontPath,
            backPath: pair.backPath,
            date: formValues.date,
            description: formValues.description,
            tags: formValues.tags,
            frontRotation: pairRotations.front,
            backRotation: pairRotations.back,
          });
          const updatedVersions = getUpdatedImageVersions(result.results);
          if (Object.keys(updatedVersions).length) {
            setImageVersions((current) => ({ ...current, ...updatedVersions }));
          }
          if (result.sidecarWritten) {
            const savedDate = formValues.date.slice(0, 10);
            setSavedDates((current) =>
              current.get(pair.id) === savedDate
                ? current
                : new Map(current).set(pair.id, savedDate),
            );
          }

          const remainingRotations = getRemainingRotations(
            pairRotations,
            result.results,
          );
          if (!pair.hasSidecar) {
            markPairsSaved([pair.id]);
          }
          if (selectedPairIdRef.current === pair.id) {
            pairHasSidecarRef.current = true;
            if (appliesRotation) {
              setRotations(remainingRotations);
            }
            if (result.ok && editRevisionRef.current === editRevision) {
              hasUserChangedRef.current = false;
            }
          }

          if (result.ok) {
            unsavedEditsRef.current.delete(pair.id);
            return true;
          }

          unsavedEditsRef.current.set(pair.id, {
            imageLabel: pair.imageLabel,
            formValues,
            rotations: remainingRotations,
          });
          setStatus(
            describeSaveFailure(
              pair.imageLabel,
              result.results
                .filter((imageResult) => !imageResult.ok)
                .map((imageResult) => imageResult.error),
            ),
          );
          return false;
        } catch (error) {
          unsavedEditsRef.current.set(pair.id, {
            imageLabel: pair.imageLabel,
            formValues,
            rotations: pairRotations,
          });
          setStatus(
            describeSaveFailure(pair.imageLabel, [
              error instanceof Error ? error.message : undefined,
            ]),
          );
          return false;
        }
      });

      trackPairOperation(pair.id, operation);
      return operation;
    },
    [markPairsSaved, trackPairOperation],
  );

  /**
   * Rotates a group's A image from the grid. The thumbnail turns at once; the file is rotated in
   * the background, after any save of the same group, and clicks made before it starts are
   * combined into one rotation. Only the image is rewritten: the grid never writes a sidecar,
   * so rotating does not record a date the user never chose.
   * @param pairId - The ID of the image group to rotate.
   * @param delta - The rotation change in degrees (±90).
   */
  const rotateFromGrid = useCallback(
    (pairId: string, delta: number) => {
      const electronApi = window.electronAPI;
      const pair = pairs.find((candidate) => candidate.id === pairId);
      if (!electronApi || !pair || isUploading) {
        return;
      }

      const pendingRotations = gridRotationsRef.current;
      const setPendingRotation = (rotation: number) => {
        if (rotation) {
          pendingRotations.set(pairId, rotation);
        } else {
          pendingRotations.delete(pairId);
        }
        setGridRotations(new Map(pendingRotations));
      };
      setPendingRotation(
        normalizeRotation((pendingRotations.get(pairId) ?? 0) + delta),
      );

      // A rotation that has not started yet applies the latest angle when it runs.
      if (queuedGridRotationsRef.current.has(pairId)) {
        return;
      }
      queuedGridRotationsRef.current.add(pairId);

      const previousSave =
        pendingSavesRef.current.get(pairId) ?? Promise.resolve(true);
      const operation = previousSave.then(async () => {
        queuedGridRotationsRef.current.delete(pairId);
        const rotation = pendingRotations.get(pairId) ?? 0;
        if (!rotation) {
          return true;
        }

        let error: string | undefined;
        try {
          const result = await electronApi.applyImageRotations({
            frontPath: pair.frontPath,
            backPath: null,
            frontRotation: rotation,
            backRotation: 0,
          });
          const frontResult = result.results.find(
            (imageResult) => imageResult.field === "front",
          );
          if (frontResult?.ok) {
            const { version } = frontResult;
            if (version) {
              setImageVersions((current) => ({
                ...current,
                [pair.frontPath]: version,
              }));
            }
          } else {
            error = frontResult?.error ?? "The image was not rotated.";
          }
        } catch (rotationError) {
          error =
            rotationError instanceof Error
              ? rotationError.message
              : "The image was not rotated.";
        }

        // Clicks made while this rotation ran stay pending for the next one.
        setPendingRotation(
          normalizeRotation((pendingRotations.get(pairId) ?? 0) - rotation),
        );
        if (error) {
          setStatus(`Could not rotate ${pair.imageLabel}: ${error}`);
        }
        // A failure is reported here, so later saves of this group still go ahead.
        return true;
      });
      trackPairOperation(pairId, operation);
    },
    [isUploading, pairs, trackPairOperation],
  );

  /**
   * Waits until every pending save has finished.
   * @returns The labels of images whose changes could not be saved (empty when all saves succeeded).
   */
  const waitForPendingSaves = useCallback(async () => {
    while (pendingSavesRef.current.size) {
      await Promise.all(pendingSavesRef.current.values());
    }
    return Array.from(
      unsavedEditsRef.current.values(),
      (edits) => edits.imageLabel,
    );
  }, []);

  /**
   * Saves the selected pair when it has changes, a pending rotation, or no sidecar yet; otherwise writes nothing.
   * @param formValues - The metadata form values to persist. If not provided, uses the current metadata state.
   * @param options - Set wait to false to save in the background and return as soon as the date is validated.
   * @returns False when the date is invalid or (when waiting) the save failed.
   */
  const persistCurrentPair = useCallback(
    async (
      formValues: MetadataForm = metadata,
      { wait = true }: { wait?: boolean } = {},
    ) => {
      if (!selectedPair || !isHydrated) {
        return true;
      }

      const leavingSave = leavingSaveRef.current;
      if (leavingSave?.pairId === selectedPair.id) {
        return wait ? leavingSave.operation : true;
      }

      if (!toIsoDate(dateSegmentsRef.current)) {
        setStatus("Enter a valid month, day, and year before saving.");
        return false;
      }

      if (!window.electronAPI) {
        setStatus("This application must run inside Electron.");
        return false;
      }

      if (
        !needsSaveOnLeave({
          hasUserChanged: hasUserChangedRef.current,
          rotations,
          hasSidecar: pairHasSidecarRef.current,
        })
      ) {
        return wait
          ? ((await pendingSavesRef.current.get(selectedPair.id)) ?? true)
          : true;
      }

      const operation = startPairSave(
        selectedPair,
        formValues,
        rotations,
        editRevisionRef.current,
      );
      const nextLeavingSave = { pairId: selectedPair.id, operation };
      leavingSaveRef.current = nextLeavingSave;
      void operation.then(() => {
        if (leavingSaveRef.current === nextLeavingSave) {
          leavingSaveRef.current = null;
        }
      });

      if (!wait) {
        return true;
      }

      setIsPersistingRotation(true);
      try {
        return await operation;
      } finally {
        setIsPersistingRotation(false);
      }
    },
    [isHydrated, metadata, rotations, selectedPair, startPairSave],
  );

  /**
   * Saves the reviewed pair before the image list changes. No metadata is saved from the grid:
   * its only edits are rotations, which are written as they are made, and Review's edits are
   * saved on the way back to the grid. Saving there would write a default date for an image
   * the user never opened.
   * @returns True when it is safe to continue.
   */
  const persistReviewedPair = useCallback(
    () =>
      viewMode === "review" ? persistCurrentPair() : Promise.resolve(true),
    [persistCurrentPair, viewMode],
  );

  /**
   * Navigates to a specific image index, saving the current pair in the background.
   * Only an invalid date blocks moving on; a failed save is reported in the status line.
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

      // The save runs in the background; only an invalid date blocks moving on.
      const nextPair = displayPairs[boundedIndex];
      if (
        !nextPair ||
        !(await persistCurrentPair(formValues, { wait: false }))
      ) {
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
   * Waits for the pair's own pending save first, then uses prefetched sidecar values when available.
   * Unsaved values from a failed save take precedence over the sidecar.
   */
  useEffect(() => {
    const electronApi = window.electronAPI;
    if (!selectedPair || !electronApi) {
      return;
    }

    let isMounted = true;
    const pair = selectedPair;
    const imageStatus = formatImageStatus(
      selectedIndex,
      displayPairs.length,
      pair.imageLabel,
    );

    const applyLoadedValues = (
      values: MetadataForm,
      pairRotations: PairRotationState,
      hasChanges: boolean,
      statusMessage: string,
    ) => {
      hasUserChangedRef.current = hasChanges;
      setMetadata(values);
      const loadedSegments = parseDateSegments(values.date);
      dateSegmentsRef.current = loadedSegments;
      setDateSegments(loadedSegments);
      setRotations(pairRotations);
      setIsHydrated(true);
      setStatus(statusMessage);
    };

    const loadMetadataFromSidecar = async () => {
      await pendingSavesRef.current.get(pair.id);
      if (!isMounted) {
        return;
      }
      setReadyPairId(pair.id);

      const unsavedEdits = unsavedEditsRef.current.get(pair.id);
      const otherUnsavedImages = describeUnsavedImages(
        Array.from(unsavedEditsRef.current)
          .filter(([pairId]) => pairId !== pair.id)
          .map(([, edits]) => edits.imageLabel),
      );
      const unsavedStatus = unsavedEdits
        ? " Changes to this image are not saved yet."
        : "";

      try {
        const prefetchedSidecars = sidecarPrefetchRef.current.get(pair.id);
        sidecarPrefetchRef.current.delete(pair.id);
        const [frontXmpValues, backXmpValues] = await (prefetchedSidecars ??
          readPairSidecars(electronApi, pair));

        if (!isMounted) {
          return;
        }

        pairHasSidecarRef.current = frontXmpValues.hasSidecar;
        const loadedTags = frontXmpValues.tags ?? [];
        setRecentTags((current) => [
          ...loadedTags,
          ...current.filter(
            (tag) =>
              !loadedTags.some(
                (loadedTag) =>
                  loadedTag.toLocaleLowerCase() === tag.toLocaleLowerCase(),
              ),
          ),
        ]);
        applyLoadedValues(
          unsavedEdits?.formValues ?? {
            date: frontXmpValues.date
              ? frontXmpValues.date.slice(0, 10)
              : defaultDate,
            description: frontXmpValues.description ?? "",
            tags: loadedTags,
          },
          unsavedEdits?.rotations ?? {
            front: normalizeRotation(frontXmpValues.rotation ?? 0),
            back: normalizeRotation(backXmpValues?.rotation ?? 0),
          },
          Boolean(unsavedEdits),
          `${imageStatus}${unsavedStatus}${otherUnsavedImages}`,
        );
      } catch {
        if (!isMounted) {
          return;
        }

        // Treat an unreadable sidecar as existing, so leaving the pair unchanged does not overwrite it.
        pairHasSidecarRef.current = true;
        applyLoadedValues(
          unsavedEdits?.formValues ?? {
            date: defaultDate,
            description: "",
            tags: [],
          },
          unsavedEdits?.rotations ?? { front: 0, back: 0 },
          Boolean(unsavedEdits),
          `${imageStatus} Unable to read saved metadata.${unsavedStatus}${otherUnsavedImages}`,
        );
      }
    };

    void loadMetadataFromSidecar();

    return () => {
      isMounted = false;
    };
  }, [displayPairs.length, pairReloadToken, selectedIndex, selectedPair]);

  /**
   * Prefetches the neighbouring pairs' images and sidecar metadata once the current pair is shown.
   * Pairs with a pending save are skipped; they are loaded after their save finishes.
   */
  useEffect(() => {
    const electronApi = window.electronAPI;
    if (!electronApi || !selectedPair || !isHydrated) {
      return;
    }

    const neighbours = [
      displayPairs[selectedIndex + 1],
      displayPairs[selectedIndex - 1],
    ].filter((pair): pair is ImagePair => Boolean(pair));
    const neighbourIds = new Set(neighbours.map((pair) => pair.id));
    for (const pairId of sidecarPrefetchRef.current.keys()) {
      if (!neighbourIds.has(pairId)) {
        sidecarPrefetchRef.current.delete(pairId);
      }
    }

    const timer = window.setTimeout(() => {
      for (const pair of neighbours) {
        if (pendingSavesRef.current.has(pair.id)) {
          continue;
        }

        if (!sidecarPrefetchRef.current.has(pair.id)) {
          const request = readPairSidecars(electronApi, pair);
          sidecarPrefetchRef.current.set(pair.id, request);
          request.catch(() => {
            if (sidecarPrefetchRef.current.get(pair.id) === request) {
              sidecarPrefetchRef.current.delete(pair.id);
            }
          });
        }

        const images: [string | null, string | null][] = [
          [pair.frontPath, pair.frontVersion],
          [pair.backPath, pair.backVersion],
        ];
        for (const [filePath, listedVersion] of images) {
          if (!filePath) {
            continue;
          }
          void electronApi
            .getPreviewDataUrl(
              filePath,
              imageVersions[filePath] ?? listedVersion ?? "",
            )
            .then((url) => {
              if (url) {
                const preloadedImage = new Image();
                preloadedImage.src = url;
              }
            })
            .catch(() => {
              // Prefetching is optional; the image loads normally when the pair is opened.
            });
        }
      }
    }, 150);

    return () => window.clearTimeout(timer);
  }, [displayPairs, imageVersions, isHydrated, selectedIndex, selectedPair]);

  /**
   * Warns before leaving the web app while saves are pending or have failed,
   * or while the current pair has edits that have not been saved yet.
   * The desktop app instead waits for pending writes before it quits.
   */
  useEffect(() => {
    if (!isWebApp()) {
      return;
    }

    const warnAboutPendingSaves = (event: BeforeUnloadEvent) => {
      if (
        pendingSavesRef.current.size ||
        unsavedEditsRef.current.size ||
        hasUserChangedRef.current
      ) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", warnAboutPendingSaves);
    return () =>
      window.removeEventListener("beforeunload", warnAboutPendingSaves);
  }, []);

  /**
   * Focuses the date input field when the component becomes hydrated and a pair is selected.
   */
  useEffect(() => {
    if (!selectedPair || !isHydrated || viewMode !== "review") {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      dateInputRef.current?.focus();
      dateInputRef.current?.select();
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [isHydrated, selectedPair, viewMode]);

  /**
   * Rotates an image by a given delta value (in 90-degree increments).
   * The rotation is shown with CSS straight away and written to the file when the pair is left.
   * Does not apply rotation if already persisting, uploading, or not hydrated.
   * @param field - Which image to rotate ("front" or "back").
   * @param delta - The rotation change in degrees (typically Â±90).
   */
  const rotateImage = useCallback(
    (field: RotationField, delta: number) => {
      if (isPersistingRotation || isUploading || !isHydrated) {
        return;
      }

      markUserChanged();
      setRotations((current) => ({
        ...current,
        [field]: normalizeRotation(current[field] + delta),
      }));
    },
    [isHydrated, isPersistingRotation, isUploading, markUserChanged],
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
      const hasPendingChanges =
        hasUserChangedRef.current ||
        rotations.front !== 0 ||
        rotations.back !== 0;
      if (hasPendingChanges && !(await persistCurrentPair())) {
        setDoNotUploadError({
          pairId: pair.id,
          message:
            "The flag was not changed because unsaved changes could not be saved.",
        });
        return;
      }

      // Renaming must not race a background save that still targets the old file names.
      if (!(await (pendingSavesRef.current.get(pair.id) ?? true))) {
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
        relativeDirectory: pair.relativeDirectory,
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
                frontVersion: result.frontVersion,
                backVersion: result.backVersion,
                doNotUpload: result.doNotUpload,
                excludeMismatch: result.excludeMismatch,
              }
            : candidate,
        ),
      );
      setSavedDates((current) => renameMapKey(current, pair.id, result.id));
      // The pair id comes from the file name, so follow the renamed pair.
      setSelectedPairId(result.id);
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
    rotations,
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

      // Review shortcuts act on the selected image, which the grid does not show.
      if (
        viewMode !== "review" ||
        isPersistingRotation ||
        isUploading ||
        !isHydrated
      ) {
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
    viewMode,
  ]);

  /**
   * Updates a metadata form field value (date or description).
   * Marks the current pair as having user changes that need to be persisted.
   * @param field - The field to update ("date" or "description").
   * @param value - The new value for the field.
   */
  const updateFormField = (field: "date" | "description", value: string) => {
    markUserChanged();
    setMetadata((current) => ({ ...current, [field]: value }));
  };

  /**
   * Updates the tags array for the current pair's metadata.
   * Marks the current pair as having user changes that need to be persisted.
   * @param tags - The new array of tag strings.
   */
  const updateTags = (tags: string[]) => {
    markUserChanged();
    setMetadata((current) => ({ ...current, tags }));
  };

  /**
   * Adds a new tag from user input to the current pair's metadata if it doesn't already exist.
   * Moves the added tag to the front of recent tags and clears the input field.
   */
  const addTag = (newTag: string) => {
    const tag = newTag.trim();
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

    updateDateSegments(next);
    const formValues =
      nextDate === metadata.date ? metadata : { ...metadata, date: nextDate };

    if (selectedIndex + 1 >= displayPairs.length) {
      if (selectedPair && hasUserChangedRef.current) {
        if (await persistCurrentPair(formValues)) {
          setStatus(formatSavedStatus(selectedPair.imageLabel));
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
      const selection = await chooseDirectory(
        window.electronAPI.browseDirectory,
      );
      if (!selection) {
        setStatus("No directory selected.");
        return;
      }

      if (!(await persistReviewedPair())) {
        return;
      }

      setStatus("Saving changes...");
      const unsavedImages = await waitForPendingSaves();
      if (
        unsavedImages.length &&
        !window.confirm(
          `Changes to ${unsavedImages.join(", ")} could not be saved and will be lost. Open the other folder anyway?`,
        )
      ) {
        setStatus(
          `Stayed in this folder.${describeUnsavedImages(unsavedImages)}`,
        );
        return;
      }

      setStatus(
        selection.recursive
          ? "Scanning directory and nested folders for photos..."
          : "Scanning directory for photos...",
      );
      const result = await window.electronAPI.readDirectory(
        selection.path,
        sortBy,
        selection.recursive,
      );
      unsavedEditsRef.current.clear();
      sidecarPrefetchRef.current.clear();
      setImageVersions({});
      setDirectoryPath(result.directoryPath);
      setIncludeNested(result.recursive);
      setFolderCount(result.folderCount);
      setFolderState(result.folderState);
      setHasSubfolders(result.hasSubfolders);
      setIncludeSubfoldersInProcessed(false);
      setFolderProcessedError("");
      setHasUploadedFolder(false);
      setIsHydrated(false);
      setPairs(result.files);
      resetSavedPairs();
      setViewMode("grid");
      setGridFocusPairId(null);
      setSelectedGridIds(new Set());
      setImageFilter("all");
      setRecentTags(result.recentTags);
      setImageNumberInput("1");
      setSelectedPairId(result.files[0]?.id ?? null);

      if (!result.files.length) {
        setStatus(
          result.recursive
            ? "No supported images were found in that directory or its nested folders."
            : "No supported images were found in that directory.",
        );
        return;
      }

      setStatus(describeLoadedGroups(result));
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

      if (!(await persistReviewedPair())) {
        return;
      }

      setIsBusy(true);
      setStatus("Sorting photos...");

      try {
        await waitForPendingSaves();
        const result = await window.electronAPI.readDirectory(
          directoryPath,
          nextSortBy,
          includeNested,
        );
        sidecarPrefetchRef.current.clear();
        setImageVersions({});
        setSortBy(nextSortBy);
        setFolderCount(result.folderCount);
        setFolderState(result.folderState);
        setHasSubfolders(result.hasSubfolders);
        setIsHydrated(false);
        setPairs(result.files);
        resetSavedPairs();
        setRecentTags(result.recentTags);
        setImageNumberInput("1");
        setSelectedPairId(
          filterImagePairs(result.files, imageFilter, new Set())[0]?.id ?? null,
        );
        setStatus(describeLoadedGroups(result));
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
    [
      directoryPath,
      imageFilter,
      includeNested,
      persistReviewedPair,
      resetSavedPairs,
      waitForPendingSaves,
    ],
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

      if (!(await persistReviewedPair())) {
        return;
      }

      await waitForPendingSaves();
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
    [
      imageFilter,
      pairs,
      persistReviewedPair,
      selectedPairId,
      waitForPendingSaves,
    ],
  );

  /**
   * Opens an image from the grid in Review. The grid saves no metadata, so there is nothing to
   * save first; a grid rotation still being written is shown, and Review loads after it.
   * @param pairId - The ID of the image group to review.
   */
  const openPairInReview = useCallback(
    (pairId: string) => {
      const index = displayPairs.findIndex((pair) => pair.id === pairId);
      if (index === -1) {
        return;
      }

      if (pairId !== selectedPairId) {
        setIsHydrated(false);
        setSelectedPairId(pairId);
      }
      setImageNumberInput(String(index + 1));
      setViewMode("review");
    },
    [displayPairs, selectedPairId],
  );

  /**
   * Saves the reviewed image, then returns to the grid with that image focused.
   * Waits for the save so the grid shows the new date; stays in Review when it fails,
   * and the status bar explains why.
   */
  const returnToGrid = useCallback(async () => {
    if (viewMode === "grid") {
      return;
    }

    if (!(await persistCurrentPair())) {
      return;
    }

    setGridFocusPairId(selectedPair?.id ?? null);
    setViewMode("grid");
  }, [persistCurrentPair, selectedPair, viewMode]);

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
      if (!(await persistReviewedPair())) {
        setImmichStatus(
          "Upload stopped because an image rotation could not be persisted.",
        );
        return;
      }

      const unsavedImages = await waitForPendingSaves();
      if (unsavedImages.length) {
        setImmichStatus(
          `Upload stopped because changes to ${unsavedImages.join(", ")} could not be saved. Open those images to retry.`,
        );
        return;
      }

      setIsUploading(true);
      setUploadElapsedSeconds(0);
      setImmichOutput("");
      setHasUploadedFolder(false);
      isImmichOutputFollowingRef.current = true;
      setImmichStatus(
        includeNested
          ? "Uploading the selected directory and its nested folders to Immich..."
          : "Uploading the selected directory to Immich...",
      );
      const savedSettings =
        await electronApi.saveImmichSettings(immichSettings);
      setImmichSettings(savedSettings);
      const result = await electronApi.uploadToImmich(
        savedSettings,
        directoryPath,
        includeNested,
      );
      setImmichOutput(result.output);
      setHasUploadedFolder(result.ok);
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

      await waitForPendingSaves();
      const result = await electronApi.setFolderDate(
        directoryPath,
        date,
        includeNested,
      );
      const failedLabels = result.errors.map((error) => error.split(": ")[0]);
      // The bulk write skips flagged groups and groups that already have a sidecar.
      const datedPairIds = pairs
        .filter(
          (pair) =>
            !pair.doNotUpload &&
            !isPairProcessed(pair, savedPairIdsRef.current) &&
            !failedLabels.includes(pair.imageLabel),
        )
        .map((pair) => pair.id);
      setSavedDates((current) => {
        const next = new Map(current);
        for (const id of datedPairIds) {
          next.set(id, date);
        }
        return next;
      });
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
      sidecarPrefetchRef.current.clear();
      setIsHydrated(false);
      setPairReloadToken((current) => current + 1);
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

  /**
   * Deletes the XMP sidecar files of every image in the folder after the user confirms, so every
   * image goes back to unprocessed. The folder is read again afterwards to show the reset state.
   */
  const handleResetProcessing = async () => {
    if (!directoryPath) {
      return;
    }
    if (
      !window.confirm(
        `Reset processing for all images${includeNested ? " in this folder and its nested folders" : " in this folder"}?

This permanently deletes their .xmp sidecar files, including the saved dates, descriptions and tags. The images themselves are not deleted. This cannot be undone.`,
      )
    ) {
      return;
    }

    setIsSettingFolderDate(true);
    setStatus("Resetting processing for all images...");

    try {
      const electronApi = window.electronAPI;
      if (!electronApi) {
        throw new Error("API is not available.");
      }

      await waitForPendingSaves();
      unsavedEditsRef.current.clear();
      const result = await electronApi.resetFolderMetadata(
        directoryPath,
        includeNested,
      );
      const listing = await electronApi.readDirectory(
        directoryPath,
        sortBy,
        includeNested,
      );
      sidecarPrefetchRef.current.clear();
      setImageVersions({});
      setFolderCount(listing.folderCount);
      setFolderState(listing.folderState);
      setHasSubfolders(listing.hasSubfolders);
      setIsHydrated(false);
      setPairs(listing.files);
      resetSavedPairs();
      setSelectedGridIds(new Set());
      setRecentTags(listing.recentTags);
      setSelectedPairId(
        filterImagePairs(listing.files, imageFilter, new Set())[0]?.id ?? null,
      );
      setPairReloadToken((current) => current + 1);

      setStatus(
        result.ok
          ? `Reset ${result.resetPairs} image group${result.resetPairs === 1 ? "" : "s"} (${result.deletedFiles} .xmp file${result.deletedFiles === 1 ? "" : "s"} deleted).`
          : `Reset ${result.resetPairs} image group${result.resetPairs === 1 ? "" : "s"} with ${result.errors.length} error${result.errors.length === 1 ? "" : "s"}: ${result.errors.slice(0, 2).join("; ")}${result.errors.length > 2 ? "..." : ""}`,
      );
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "Unable to reset the processing state.",
      );
    } finally {
      setIsSettingFolderDate(false);
    }
  };

  const toggleGridSelection = useCallback((pairId: string) => {
    setSelectedGridIds((current) => {
      const next = new Set(current);
      if (!next.delete(pairId)) {
        next.add(pairId);
      }
      return next;
    });
  }, []);

  /**
   * Sets the chosen date on the groups selected in the grid, with the same rules as saving one image.
   * @param date - The ISO date string chosen from the modal.
   */
  const handleConfirmSetSelectedDate = async (date: string) => {
    const chosenPairs = pairs.filter((pair) => selectedGridIds.has(pair.id));
    if (!chosenPairs.length) {
      setIsSelectedDateModalOpen(false);
      return;
    }

    setIsSettingFolderDate(true);
    setStatus(`Setting date for ${chosenPairs.length} selected groups...`);

    try {
      const electronApi = window.electronAPI;
      if (!electronApi) {
        throw new Error("API is not available.");
      }

      await waitForPendingSaves();
      const result = await electronApi.setPairsDate(
        chosenPairs.map(({ frontPath, backPath }) => ({ frontPath, backPath })),
        date,
      );
      const failedPaths = new Set(result.failedFrontPaths);
      const datedPairs = chosenPairs.filter(
        (pair) => !failedPaths.has(pair.frontPath),
      );
      setSavedDates((current) => {
        const next = new Map(current);
        for (const pair of datedPairs) {
          next.set(pair.id, date);
        }
        return next;
      });
      markPairsSaved(datedPairs.map((pair) => pair.id));
      // Failed groups stay selected so the date can be retried.
      setSelectedGridIds(
        new Set(
          chosenPairs
            .filter((pair) => failedPaths.has(pair.frontPath))
            .map((pair) => pair.id),
        ),
      );

      setStatus(
        result.ok
          ? `Set date to ${date} for ${result.updatedPairs} image group${result.updatedPairs === 1 ? "" : "s"}.`
          : `Date set for ${result.updatedPairs} image group${result.updatedPairs === 1 ? "" : "s"} with ${result.errors.length} error${result.errors.length === 1 ? "" : "s"}: ${result.errors.slice(0, 2).join("; ")}${result.errors.length > 2 ? "..." : ""}`,
      );
      setIsSelectedDateModalOpen(false);
      sidecarPrefetchRef.current.clear();
      setIsHydrated(false);
      setPairReloadToken((current) => current + 1);
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "Unable to set the date for the selected images.",
      );
    } finally {
      setIsSettingFolderDate(false);
    }
  };
  /**
   * Adds tags to the groups selected in the grid. Existing tags are kept; groups that fail stay selected and
   * are listed in the dialog so the tags can be added again.
   * @param tags - The tags chosen in the modal.
   */
  const handleConfirmAddTags = async (tags: string[]) => {
    const chosenPairs = pairs.filter((pair) => selectedGridIds.has(pair.id));
    if (!chosenPairs.length || !tags.length) {
      setIsAddTagsModalOpen(false);
      return;
    }

    setIsAddingTags(true);
    setAddTagsFailures([]);
    setStatus(`Adding tags to ${chosenPairs.length} selected groups...`);

    try {
      const electronApi = window.electronAPI;
      if (!electronApi) {
        throw new Error("API is not available.");
      }

      await waitForPendingSaves();
      const result = await electronApi.addTagsToPairs(
        chosenPairs.map(({ frontPath, backPath }) => ({ frontPath, backPath })),
        tags,
      );
      const failedPaths = new Set(result.failedFrontPaths);
      markPairsSaved(
        chosenPairs
          .filter((pair) => !failedPaths.has(pair.frontPath))
          .map((pair) => pair.id),
      );
      setRecentTags((current) => mergeTagSources(tags, current));
      setSelectedGridIds(
        new Set(
          chosenPairs
            .filter((pair) => failedPaths.has(pair.frontPath))
            .map((pair) => pair.id),
        ),
      );
      setStatus(
        result.ok
          ? `Added ${tags.length} tag${tags.length === 1 ? "" : "s"} to ${result.updatedPairs} image group${result.updatedPairs === 1 ? "" : "s"}.`
          : `Tags added to ${result.updatedPairs} image group${result.updatedPairs === 1 ? "" : "s"}; ${result.errors.length} failed.`,
      );
      if (result.ok) {
        setIsAddTagsModalOpen(false);
      } else {
        setAddTagsFailures(result.errors);
      }
      sidecarPrefetchRef.current.clear();
      setIsHydrated(false);
      setPairReloadToken((current) => current + 1);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to add tags to the selected images.";
      setStatus(message);
      setAddTagsFailures([message]);
    } finally {
      setIsAddingTags(false);
    }
  };

  /**
   * Marks the open folder, and optionally every subfolder, as processed or not processed.
   * @param value - Whether the folder is processed.
   * @param includeSubfolders - Whether to mark every subfolder the same way.
   */
  const handleSetFolderProcessed = async (
    value: boolean,
    includeSubfolders: boolean,
  ) => {
    const electronApi = window.electronAPI;
    if (!electronApi || !directoryPath) {
      return;
    }

    setIsSettingFolderProcessed(true);
    setFolderProcessedError("");
    try {
      const result = await electronApi.setFolderProcessed(
        directoryPath,
        value,
        includeSubfolders,
      );
      setFolderState(result.state);
      const scope =
        result.updatedFolders === 1
          ? "this folder"
          : `${result.updatedFolders} folders`;
      setStatus(`Marked ${scope} as ${value ? "processed" : "not processed"}.`);
      if (!result.ok) {
        setFolderProcessedError(
          `Some subfolders could not be marked: ${result.errors.join("; ")}`,
        );
      }
    } catch (error) {
      setFolderProcessedError(
        error instanceof Error
          ? error.message
          : "Unable to change the folder's processed state.",
      );
    } finally {
      setIsSettingFolderProcessed(false);
    }
  };
  const tagSuggestions = mergeTagSources(immichTags, recentTags);
  const uploadTags = immichSettings.tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  const managedImmichFields = immichSettings.managed;
  const canUploadToImmich =
    Boolean(directoryPath) &&
    (Boolean(managedImmichFields?.serverUrl) ||
      Boolean(immichSettings.serverUrl.trim())) &&
    (Boolean(managedImmichFields?.userApiKey) ||
      Boolean(immichSettings.userApiKey.trim()));
  const isTransitionLocked =
    isBusy ||
    isPersistingRotation ||
    isUploading ||
    isSettingFolderDate ||
    isSettingFolderProcessed ||
    isTogglingDoNotUpload;
  const flaggedPairCount = pairs.filter((pair) => pair.doNotUpload).length;
  const folderNestedDescription = `(including nested folders, ${folderCount} folder${folderCount === 1 ? "" : "s"})`;
  const selectedDoNotUploadError =
    doNotUploadError && doNotUploadError.pairId === selectedPair?.id
      ? doNotUploadError.message
      : "";
  const isImageControlLocked = isTransitionLocked || !isHydrated;
  const getDisplayedVersion = (
    filePath: string | null,
    listedVersion: string | null,
  ) => (filePath ? (imageVersions[filePath] ?? listedVersion ?? "") : "");
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
          {directoryPath && viewMode === "grid" && selectedGridIds.size > 0 ? (
            <>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setSelectedGridIds(new Set())}
                disabled={isTransitionLocked}
              >
                Clear selection
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => setIsSelectedDateModalOpen(true)}
                disabled={isTransitionLocked}
                title="Set a date for the selected images, replacing any date already saved"
              >
                Set date for selected ({selectedGridIds.size})
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  setAddTagsFailures([]);
                  setIsAddTagsModalOpen(true);
                }}
                disabled={isTransitionLocked}
                title="Add tags to the selected images, keeping the tags they already have"
              >
                Add tags to selected ({selectedGridIds.size})
              </button>
            </>
          ) : null}
          {directoryPath ? (
            <button
              type="button"
              className="secondary-button"
              onClick={() => void handleResetProcessing()}
              disabled={isTransitionLocked}
              title="Delete the .xmp files of all images in this folder so they are unprocessed again"
            >
              Reset processing
            </button>
          ) : null}
          {directoryPath ? (
            <button
              type="button"
              className="secondary-button"
              onClick={() => setIsSetFolderDateModalOpen(true)}
              disabled={isTransitionLocked}
              title={
                includeNested
                  ? "Set a date for all images in this folder and its nested folders that don't yet have saved metadata"
                  : "Set a date for all images in this folder that don't yet have saved metadata"
              }
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
        {pendingSaveCount > 0 ? (
          <span className="save-indicator" role="status">
            Saving {pendingSaveCount} image{pendingSaveCount === 1 ? "" : "s"}…
          </span>
        ) : null}
        {directoryPath ? (
          <div className="folder-processed">
            <strong>{directoryPath}</strong>
            {includeNested ? (
              <span className="folder-nested">{folderNestedDescription}</span>
            ) : null}
            <button
              type="button"
              className="processed-toggle"
              aria-pressed={folderState.processed}
              title={describeFolderState(folderState)}
              onClick={() =>
                void handleSetFolderProcessed(
                  !folderState.processed,
                  hasSubfolders && includeSubfoldersInProcessed,
                )
              }
              disabled={isTransitionLocked}
            >
              <span aria-hidden="true">
                {folderState.processed ? "✓" : "○"}
              </span>{" "}
              Processed
            </button>
            {hasSubfolders ? (
              <label className="processed-subfolders">
                <input
                  type="checkbox"
                  checked={includeSubfoldersInProcessed}
                  onChange={(event) =>
                    setIncludeSubfoldersInProcessed(event.target.checked)
                  }
                  disabled={isTransitionLocked}
                />
                Include subfolders
              </label>
            ) : null}
            {folderProcessedError ? (
              <span className="folder-processed-error" role="alert">
                {folderProcessedError}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {!directoryPath ? (
        <section className="empty-state">
          <p>Select a local directory to review your images.</p>
        </section>
      ) : (
        <main className="workspace">
          <div className="view-bar">
            <div className="view-switch" role="group" aria-label="View">
              <button
                type="button"
                aria-pressed={viewMode === "grid"}
                onClick={() => void returnToGrid()}
                disabled={isTransitionLocked}
              >
                Grid
              </button>
              <button
                type="button"
                aria-pressed={viewMode === "review"}
                onClick={() => {
                  if (selectedPair) {
                    openPairInReview(selectedPair.id);
                  }
                }}
                disabled={!selectedPair || isTransitionLocked}
              >
                Review
              </button>
            </div>
            <div className="view-bar-controls">
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
            </div>
          </div>

          {viewMode === "grid" ? (
            <section className="viewer-panel grid-panel" aria-label="Images">
              <ThumbnailGrid
                key={directoryPath}
                cells={gridCells}
                focusCellId={gridFocusPairId}
                emptyMessage={getEmptyFilterMessage(imageFilter, pairs.length)}
                onOpen={openPairInReview}
                onRotate={rotateFromGrid}
                canRotate={!isUploading}
                selectedIds={selectedGridIds}
                onToggleSelect={toggleGridSelection}
              />
            </section>
          ) : (
            <>
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
                        onKeyDown={(event) =>
                          void handleDateKeyDown(event, "day")
                        }
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
                        onKeyDown={(event) =>
                          void handleDateKeyDown(event, "year")
                        }
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
                      onKeyDown={(event) =>
                        void handleDescriptionKeyDown(event)
                      }
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
                        <TagInput
                          id="new-tag"
                          inputRef={tagInputRef}
                          suggestions={tagSuggestions}
                          selectedTags={metadata.tags}
                          onAdd={addTag}
                          placeholder="Type a new tag"
                          disabled={isPersistingRotation || isUploading}
                          lookupError={immichTagError}
                        />
                      </div>

                      {metadata.tags.length ? (
                        <div
                          className="selected-tags"
                          aria-label="Selected tags"
                        >
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
                    Only one side of this group is flagged Do not upload. Toggle
                    the flag to rename both sides to match.
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
                  <button
                    type="button"
                    className="back-to-grid"
                    onClick={() => void returnToGrid()}
                    disabled={isTransitionLocked}
                  >
                    <span aria-hidden="true">&larr;</span> Back to grid
                  </button>
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
                      onChange={(event) =>
                        setImageNumberInput(event.target.value)
                      }
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
                          filePath={
                            selectedPair && readyPairId === selectedPair.id
                              ? selectedPair.frontPath
                              : ""
                          }
                          version={getDisplayedVersion(
                            selectedPair?.frontPath ?? null,
                            selectedPair?.frontVersion ?? null,
                          )}
                          altText={`${selectedPair?.imageLabel ?? ""}`}
                          rotation={normalizeRotation(
                            rotations.front +
                              (gridRotations.get(selectedPair?.id ?? "") ?? 0),
                          )}
                          isExpanded={isExpanded}
                          collapsedHeight={collapsedImageHeight}
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
                            filePath={
                              readyPairId === selectedPair.id
                                ? selectedPair.backPath
                                : ""
                            }
                            version={getDisplayedVersion(
                              selectedPair.backPath,
                              selectedPair.backVersion,
                            )}
                            altText={`${selectedPair?.imageLabel ?? ""} backside`}
                            rotation={rotations.back}
                            isExpanded={isExpanded}
                            collapsedHeight={collapsedImageHeight}
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
            </>
          )}

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
              <span className="immich-directory">
                Uploads: {directoryPath}
                {includeNested ? ` ${folderNestedDescription}` : ""}
              </span>
              {flaggedPairCount > 0 ? (
                <span className="immich-skipped">
                  {flaggedPairCount} image{flaggedPairCount === 1 ? "" : "s"}{" "}
                  flagged Do not upload will be skipped.
                </span>
              ) : null}

              <div className="immich-grid">
                {managedImmichFields?.serverUrl ? (
                  // Shown as text, not a read-only input, so it does not look editable.
                  <div
                    className="immich-managed-field"
                    role="group"
                    aria-labelledby="immich-server-url-label"
                  >
                    <span id="immich-server-url-label">Server URL</span>
                    <span className="immich-managed-value">
                      {immichSettings.serverUrl}
                    </span>
                    <span className="field-help">
                      Set by your administrator.
                    </span>
                  </div>
                ) : (
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
                )}

                {managedImmichFields?.userApiKey ? null : (
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
                )}

                {managedImmichFields?.adminApiKey ? null : (
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
                )}

                {isWebApp() ? (
                  <AlbumCombobox
                    value={immichSettings.albumName}
                    onChange={(albumName) =>
                      updateImmichSetting("albumName", albumName)
                    }
                    disabled={isUploading}
                    reloadKey={immichSettings.serverUrl}
                  />
                ) : (
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
                )}

                <div className="immich-tags">
                  <label htmlFor="immich-upload-tag">Tags</label>
                  <TagInput
                    id="immich-upload-tag"
                    suggestions={tagSuggestions}
                    selectedTags={uploadTags}
                    onAdd={(tag) =>
                      updateImmichSetting(
                        "tags",
                        [...uploadTags, tag].join(", "),
                      )
                    }
                    placeholder="family, archive, scanned"
                    disabled={isUploading}
                    lookupError={immichTagError}
                  />
                  {uploadTags.length ? (
                    <div className="selected-tags" aria-label="Upload tags">
                      {uploadTags.map((tag) => (
                        <button
                          key={tag.toLocaleLowerCase()}
                          type="button"
                          onClick={() =>
                            updateImmichSetting(
                              "tags",
                              uploadTags
                                .filter((current) => current !== tag)
                                .join(", "),
                            )
                          }
                          disabled={isUploading}
                          aria-label={`Remove ${tag}`}
                        >
                          {tag} <span aria-hidden="true">&times;</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>

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

              {hasUploadedFolder && !folderState.processed ? (
                <div
                  className="immich-mark-processed"
                  role="group"
                  aria-label="Mark folder as processed"
                >
                  <span>Mark folder as processed?</span>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void handleSetFolderProcessed(true, false)}
                    disabled={isTransitionLocked}
                  >
                    This folder
                  </button>
                  {hasSubfolders ? (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void handleSetFolderProcessed(true, true)}
                      disabled={isTransitionLocked}
                    >
                      This folder and all subfolders
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </details>
        </main>
      )}

      <SetFolderDateModal
        isOpen={isSetFolderDateModalOpen}
        totalCount={pairs.length}
        nestedFolderCount={includeNested ? folderCount : null}
        onConfirm={(date) => void handleConfirmSetFolderDate(date)}
        onClose={() => setIsSetFolderDateModalOpen(false)}
        isSubmitting={isSettingFolderDate}
      />
      <AddTagsModal
        isOpen={isAddTagsModalOpen}
        selectedCount={selectedGridIds.size}
        suggestions={tagSuggestions}
        lookupError={immichTagError}
        isSubmitting={isAddingTags}
        failures={addTagsFailures}
        onConfirm={(tags) => void handleConfirmAddTags(tags)}
        onClose={() => setIsAddTagsModalOpen(false)}
      />
      <SetFolderDateModal
        isOpen={isSelectedDateModalOpen}
        totalCount={pairs.length}
        nestedFolderCount={null}
        selectedCount={selectedGridIds.size}
        onConfirm={(date) => void handleConfirmSetSelectedDate(date)}
        onClose={() => setIsSelectedDateModalOpen(false)}
        isSubmitting={isSettingFolderDate}
      />
    </div>
  );
}

export default App;
