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
 * Off by default; H.264 at CRF 21, the medium preset, and 160 kbps AAC when turned on. H.264 plays in every
 * browser and in Immich as uploaded; see videoMedia.js.
 */
export const DEFAULT_VIDEO_COMPRESSION: VideoCompressionSettings = {
  enabled: false,
  codec: "h264",
  crf: VIDEO_COMPRESSION_LIMITS.h264.defaultCrf,
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
