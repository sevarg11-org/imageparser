import { useRef, useState } from "react";
import {
  MediaPlayer,
  MediaProvider,
  Poster,
  type MediaPlayerInstance,
} from "@vidstack/react";
import {
  DefaultVideoLayout,
  defaultLayoutIcons,
} from "@vidstack/react/player/layouts/default";
import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";
import "./VideoPlayer.css";
import {
  buildSeekStoryboard,
  getPlayerSourceType,
  hasMissingPicture,
} from "./videoModel";

/** Shown when the browser plays a video's sound but cannot decode its picture, which raises no error. */
const missingPictureMessage =
  "The browser plays this video's sound but cannot show its picture. This usually means it does not support the video codec, such as H.265 (HEVC).";

/** How much must have played before a video that has decoded no frames counts as having no picture. */
const missingPictureCheckSeconds = 1.5;

/**
 * Adds up the time ranges that have played.
 * @param played - The played ranges, as a media element reports them.
 * @returns The seconds played.
 */
const getPlayedSeconds = (played: TimeRanges) => {
  let total = 0;
  for (let index = 0; index < played.length; index += 1) {
    total += played.end(index) - played.start(index);
  }
  return total;
};

type VideoPlayerProps = {
  /** The video's path, used for its name and source type. */
  filePath: string;
  /** The URL that streams the video. */
  src: string;
  /** The poster frame shown before playback starts. */
  posterUrl?: string;
  /** The seek-bar sprite URL; previews show only when the duration is known too. */
  spriteUrl?: string;
  durationSeconds: number | null;
  /** Starts playback as soon as the video can play, as for a live photo's toggle. */
  autoPlay?: boolean;
  /** Accessible name for the player, for example the file name. */
  title: string;
};

/**
 * Plays one video source. VideoPlayer remounts it for each source; see there.
 */
const VideoPlayerForSource = ({
  filePath,
  src,
  posterUrl,
  spriteUrl,
  durationSeconds,
  autoPlay = false,
  title,
}: VideoPlayerProps) => {
  const [playError, setPlayError] = useState<string | null>(null);
  const playerRef = useRef<MediaPlayerInstance>(null);

  /**
   * Reports a video whose picture the browser cannot decode. Browsers then play only the sound and raise no error,
   * so the picture is checked once the metadata loads and again after a moment of playback.
   * @param hasPlayed - Whether playback has run long enough for frames to have been decoded.
   */
  const checkPicture = (hasPlayed: boolean) => {
    const video = playerRef.current?.el?.querySelector("video");
    if (video && hasMissingPicture(video, hasPlayed)) {
      setPlayError(missingPictureMessage);
    }
  };
  const storyboard = spriteUrl
    ? buildSeekStoryboard(spriteUrl, durationSeconds)
    : null;

  if (playError) {
    return (
      <div className="video-player-unsupported" role="alert">
        <p>
          <strong>This video can&apos;t play in the browser.</strong> Its format
          or codec is not supported here, and videos are not converted for
          playback.
        </p>
        <p className="video-player-unsupported-detail">{playError}</p>
        <p>
          <a href={src} download={filePath.split(/[\\/]/).pop()}>
            Download the original
          </a>{" "}
          to watch it in another player.
        </p>
      </div>
    );
  }

  return (
    <MediaPlayer
      className="video-player"
      title={title}
      src={{ src, type: getPlayerSourceType(filePath) }}
      ref={playerRef}
      autoPlay={autoPlay}
      playsInline
      onError={(detail) =>
        setPlayError(detail.message || "The video could not be decoded.")
      }
      onLoadedMetadata={() => checkPicture(false)}
      onTimeUpdate={({ played }) => {
        // Measured from what has actually played, so a seek while paused never counts as playback.
        if (getPlayedSeconds(played) >= missingPictureCheckSeconds) {
          checkPicture(true);
        }
      }}
    >
      <MediaProvider>
        {posterUrl ? (
          <Poster className="vds-poster" src={posterUrl} alt="" />
        ) : null}
      </MediaProvider>
      <DefaultVideoLayout
        icons={defaultLayoutIcons}
        thumbnails={storyboard ?? undefined}
      />
    </MediaPlayer>
  );
};

/**
 * Plays a video as it is stored (no transcoding), with seek-bar thumbnails when the sprite is available.
 * A codec the browser cannot play is reported in place of the player.
 *
 * Each video gets a fresh player: Vidstack can keep the previous video's state and never load the next source
 * (for example after compression replaced the file it was playing, which left Review with an empty player), and a
 * fresh player also clears a "can't play" message left by the previous video.
 */
const VideoPlayer = (props: VideoPlayerProps) => (
  <VideoPlayerForSource key={props.src} {...props} />
);

export default VideoPlayer;
