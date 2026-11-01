/**
 * The seek-bar sprite layout. videoMedia.js renders sprites with the same layout, and
 * videoModel.test.mjs keeps the two in step.
 */
export const SEEK_SPRITE_LAYOUT = {
  columns: 10,
  tileWidth: 160,
  tileHeight: 90,
  maxFrames: 60,
} as const;

/**
 * A seek-bar preview storyboard in the shape the Vidstack player reads.
 */
export type SeekStoryboard = {
  url: string;
  tileWidth: number;
  tileHeight: number;
  tiles: { startTime: number; x: number; y: number }[];
};

/**
 * How many frames a seek-bar sprite holds: about one a second, at most SEEK_SPRITE_LAYOUT.maxFrames.
 * @param durationSeconds - The video's duration.
 * @returns The frame count, at least 1.
 */
export const getSeekSpriteFrameCount = (durationSeconds: number) =>
  Math.min(
    SEEK_SPRITE_LAYOUT.maxFrames,
    Math.max(1, Math.ceil(Number(durationSeconds) || 0)),
  );

/**
 * Describes where each frame of a seek-bar sprite sits and which time it shows.
 * @param url - The sprite's URL.
 * @param durationSeconds - The video's duration, as the sprite was rendered for.
 * @returns The storyboard, or null when the duration is unknown.
 */
export const buildSeekStoryboard = (
  url: string,
  durationSeconds: number | null,
): SeekStoryboard | null => {
  if (!url || !durationSeconds || durationSeconds <= 0) {
    return null;
  }
  const { columns, tileWidth, tileHeight } = SEEK_SPRITE_LAYOUT;
  const frames = getSeekSpriteFrameCount(durationSeconds);
  const interval = durationSeconds / frames;
  return {
    url,
    tileWidth,
    tileHeight,
    tiles: Array.from({ length: frames }, (_, index) => ({
      startTime: Math.round(index * interval * 1000) / 1000,
      x: (index % columns) * tileWidth,
      y: Math.floor(index / columns) * tileHeight,
    })),
  };
};

export type VideoCompressionCodec = "h265" | "h264";

/**
 * Compression applied to standalone videos before an Immich upload, replacing the originals.
 */
export type VideoCompressionSettings = {
  enabled: boolean;
  codec: VideoCompressionCodec;
  /** Constant Rate Factor: lower is higher quality and bigger. */
  crf: number;
  preset: "medium" | "slow";
  audioBitrateKbps: number;
};

/**
 * The recommended ranges for digitized tape. videoMedia.js validates the same limits on the server, and
 * videoMedia.test.mjs keeps the two in step.
 */
export const VIDEO_COMPRESSION_LIMITS = {
  h265: { minCrf: 23, maxCrf: 26, defaultCrf: 24 },
  h264: { minCrf: 20, maxCrf: 23, defaultCrf: 21 },
  presets: ["medium", "slow"],
  minAudioBitrateKbps: 128,
  maxAudioBitrateKbps: 192,
} as const;

/**
 * Off by default; H.265 at CRF 24, the medium preset, and 160 kbps AAC when turned on. H.265 gives smaller files
 * and plays in Immich and in most browsers with hardware acceleration; see videoMedia.js.
 */
export const DEFAULT_VIDEO_COMPRESSION: VideoCompressionSettings = {
  enabled: false,
  codec: "h265",
  crf: VIDEO_COMPRESSION_LIMITS.h265.defaultCrf,
  preset: "medium",
  audioBitrateKbps: 160,
};

/**
 * The source type to give the player. QuickTime and M4V files are MP4-family containers that browsers play
 * as MP4, and Matroska is read by the WebM demuxer; whether the codec inside plays is up to the browser.
 * @param filePath - The video's path.
 * @returns The MIME type the player should try.
 */
export const getPlayerSourceType = (filePath: string) =>
  /\.(webm|mkv)$/i.test(filePath) ? "video/webm" : "video/mp4";

/**
 * Formats a video's length for the grid, for example "0:07", "1:05" or "1:02:03".
 * @param durationSeconds - The duration, or null when it is unknown.
 * @returns The formatted length, or an empty string when it is unknown.
 */
export const formatVideoDuration = (durationSeconds: number | null) => {
  if (durationSeconds === null || !Number.isFinite(durationSeconds)) {
    return "";
  }
  const totalSeconds = Math.max(0, Math.round(durationSeconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
};

/**
 * Whether a video element that has loaded is showing no picture: browsers that cannot decode the video codec (for
 * example H.265 without hardware support) still play the sound and raise no error, leaving a black frame.
 * @param video - The video's size and decoded frame count, as a video element reports them.
 * @param hasPlayed - Whether playback has run long enough that frames must have been decoded.
 * @returns True when the video has no picture size, or has played without decoding a single frame.
 */
export const hasMissingPicture = (
  video: {
    readyState: number;
    videoWidth: number;
    videoHeight: number;
    getVideoPlaybackQuality?: () => { totalVideoFrames: number };
  },
  hasPlayed: boolean,
) => {
  // HTMLMediaElement.HAVE_METADATA: before it, the size is not known yet.
  if (video.readyState < 1) {
    return false;
  }
  if (video.videoWidth === 0 || video.videoHeight === 0) {
    return true;
  }
  return hasPlayed && video.getVideoPlaybackQuality?.().totalVideoFrames === 0;
};

/** Where one video is in a compression run. */
export type VideoCompressionStatus =
  "pending" | "in-progress" | "complete" | "skipped" | "failed";

/** One row of the compression progress list. */
export type VideoCompressionItem = {
  /** The video's path relative to the loaded folder. */
  name: string;
  status: VideoCompressionStatus;
  /** How much of the video is encoded, from 0 to 1. */
  fraction: number;
  /** The size change, or why the video was kept or failed. */
  detail?: string;
};

/**
 * A compression progress event from core.js: the list of videos about to be compressed, or one video's new state.
 */
export type VideoCompressionProgressEvent =
  | { type: "plan"; files: string[] }
  | {
      type: "item";
      index: number;
      status: Exclude<VideoCompressionStatus, "pending">;
      fraction: number;
      detail?: string;
    };

/**
 * Applies a compression progress event to the progress list. A plan starts a new list with every video pending;
 * an item event updates one video, and is ignored when it does not match the list (for example when the page
 * connected after the plan was sent).
 * @param items - The current list.
 * @param event - The progress event.
 * @returns The updated list.
 */
export const applyVideoCompressionProgress = (
  items: readonly VideoCompressionItem[],
  event: VideoCompressionProgressEvent,
): VideoCompressionItem[] => {
  if (event.type === "plan") {
    return event.files.map((name) => ({
      name,
      status: "pending",
      fraction: 0,
    }));
  }
  if (!Number.isInteger(event.index) || !items[event.index]) {
    return [...items];
  }
  return items.map((item, index) =>
    index === event.index
      ? {
          ...item,
          status: event.status,
          fraction: Math.min(1, Math.max(0, Number(event.fraction) || 0)),
          detail: event.detail ?? item.detail,
        }
      : item,
  );
};

/** The label shown for each compression status. */
export const VIDEO_COMPRESSION_STATUS_LABELS: Record<
  VideoCompressionStatus,
  string
> = {
  pending: "Pending",
  "in-progress": "In Progress",
  complete: "Complete",
  skipped: "Skipped",
  failed: "Failed",
};

/** One video's result in a compression summary. */
export type VideoCompressionOutcome = {
  /** The video's path relative to the loaded folder, before compression. */
  name: string;
  /** The new path when the video became an .mp4 under a new name. */
  newName: string | null;
  status: "complete" | "skipped" | "failed";
  /** The sizes before and after, for replaced videos only. */
  originalBytes: number | null;
  compressedBytes: number | null;
  /** The size change, or why the video was kept or failed. */
  detail: string;
};

/** What a compression run did, as core.js returns it. Totals cover the replaced videos only. */
export type VideoCompressionSummary = {
  videos: VideoCompressionOutcome[];
  originalBytes: number;
  compressedBytes: number;
  savedBytes: number;
};

/**
 * Formats a byte count the way core.js does in its log, for example "1.4 GB".
 * @param bytes - The size in bytes.
 * @returns The formatted size.
 */
export const formatByteSize = (bytes: number) => {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${bytes} bytes` : `${value.toFixed(1)} ${units[unit]}`;
};

/**
 * The share of the original size that compression saved, as a whole percent.
 * @param originalBytes - The size before.
 * @param savedBytes - The bytes saved.
 * @returns The percent saved, or 0 when nothing was compressed.
 */
export const getSavedPercent = (originalBytes: number, savedBytes: number) =>
  originalBytes > 0 ? Math.round((savedBytes / originalBytes) * 100) : 0;
