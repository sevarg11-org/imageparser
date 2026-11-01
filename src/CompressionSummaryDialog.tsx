import { useEffect, useRef } from "react";
import {
  formatByteSize,
  getSavedPercent,
  type VideoCompressionSummary,
} from "./videoModel";
import "./ConfirmDialog.css";
import "./CompressionSummaryDialog.css";

type CompressionSummaryDialogProps = {
  /** The run to describe, or null to show nothing. */
  summary: VideoCompressionSummary | null;
  /** Whether the run only compressed (Compress videos now), so the summary notes that nothing was uploaded. */
  isCompressOnly: boolean;
  onClose: () => void;
};

const statusLabels = {
  complete: "Complete",
  skipped: "Skipped",
  failed: "Failed",
} as const;

/**
 * Shows what a compression run did once it finishes: the total size of the replaced videos before and after,
 * the space saved, and each video's result.
 */
const CompressionSummaryDialogContent = ({
  summary,
  isCompressOnly,
  onClose,
}: Omit<CompressionSummaryDialogProps, "summary"> & {
  summary: VideoCompressionSummary;
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    closeButtonRef.current?.focus();
  }, []);

  const replaced = summary.videos.filter(
    (video) => video.status === "complete",
  );
  const failed = summary.videos.filter((video) => video.status === "failed");
  const savedPercent = getSavedPercent(
    summary.originalBytes,
    summary.savedBytes,
  );

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog compression-summary-dialog"
      aria-labelledby="compression-summary-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="confirm-dialog-content">
        <header className="confirm-dialog-header">
          <h2 id="compression-summary-title">
            {failed.length
              ? "Video compression finished with errors"
              : "Video compression complete"}
          </h2>
        </header>
        <div className="confirm-dialog-body">
          <p>
            {replaced.length} of {summary.videos.length}{" "}
            {summary.videos.length === 1 ? "video was" : "videos were"}{" "}
            compressed and replaced.
            {isCompressOnly ? " Nothing was uploaded." : ""}
          </p>

          <dl className="compression-summary-totals">
            <div>
              <dt>Original size</dt>
              <dd>{formatByteSize(summary.originalBytes)}</dd>
            </div>
            <div>
              <dt>Compressed size</dt>
              <dd>{formatByteSize(summary.compressedBytes)}</dd>
            </div>
            <div className="compression-summary-saved">
              <dt>Space saved</dt>
              <dd>
                {formatByteSize(summary.savedBytes)}
                <span> ({savedPercent}%)</span>
              </dd>
            </div>
          </dl>

          {summary.videos.length ? (
            <div className="compression-summary-table-wrap">
              <table className="compression-summary-table">
                <caption className="visually-hidden">
                  Each video&apos;s result
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Video</th>
                    <th scope="col">Original</th>
                    <th scope="col">Compressed</th>
                    <th scope="col">Saved</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.videos.map((video) => (
                    <tr
                      key={video.name}
                      className={`compression-summary-${video.status}`}
                    >
                      <th scope="row">
                        {video.newName ?? video.name}
                        {video.newName ? (
                          <span className="compression-summary-note">
                            was {video.name}
                          </span>
                        ) : null}
                        {video.status !== "complete" ? (
                          <span className="compression-summary-note">
                            {statusLabels[video.status]}: {video.detail}
                          </span>
                        ) : null}
                      </th>
                      {video.status === "complete" &&
                      video.originalBytes !== null &&
                      video.compressedBytes !== null ? (
                        <>
                          <td>{formatByteSize(video.originalBytes)}</td>
                          <td>{formatByteSize(video.compressedBytes)}</td>
                          <td>
                            {getSavedPercent(
                              video.originalBytes,
                              video.originalBytes - video.compressedBytes,
                            )}
                            %
                          </td>
                        </>
                      ) : (
                        <td colSpan={3} className="compression-summary-kept">
                          {statusLabels[video.status]}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>There were no videos to compress.</p>
          )}
        </div>
        <footer className="confirm-dialog-footer">
          <button
            ref={closeButtonRef}
            type="button"
            className="primary-button"
            onClick={onClose}
          >
            Close
          </button>
        </footer>
      </div>
    </dialog>
  );
};

export const CompressionSummaryDialog = ({
  summary,
  ...props
}: CompressionSummaryDialogProps) =>
  summary ? (
    <CompressionSummaryDialogContent summary={summary} {...props} />
  ) : null;
