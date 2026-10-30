import { useState } from "react";
import { MediaPlayer, MediaProvider, Poster } from "@vidstack/react";
import {
  DefaultVideoLayout,
  defaultLayoutIcons,
} from "@vidstack/react/player/layouts/default";
import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";
import "./VideoPlayer.css";
import { buildSeekStoryboard, getPlayerSourceType } from "./videoModel";

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
 * Plays a video as it is stored (no transcoding), with seek-bar thumbnails when the sprite is available.
 * A codec the browser cannot play is reported in place of the player.
 */
const VideoPlayer = ({
  filePath,
  src,
  posterUrl,
  spriteUrl,
  durationSeconds,
  autoPlay = false,
  title,
}: VideoPlayerProps) => {
  const [playError, setPlayError] = useState<string | null>(null);
  const storyboard = spriteUrl
    ? buildSeekStoryboard(spriteUrl, durationSeconds)
    : null;

  if (playError) {
    return (
      <div className="video-player-unsupported" role="alert">
        <p>
          <strong>This video can&apos;t play in the browser.</strong> Its format
          or codec is not supported here, and videos are never converted.
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
      autoPlay={autoPlay}
      playsInline
      onError={(detail) =>
        setPlayError(detail.message || "The video could not be decoded.")
      }
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

export default VideoPlayer;
