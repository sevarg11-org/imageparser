import { memo, useCallback, useEffect, useRef, useState } from "react";
import "./ThumbnailGrid.css";
import {
  createThumbnailLoadQueue,
  describeGridCell,
  formatGridDate,
  type ThumbnailGridCell,
  type ThumbnailLoadQueue,
} from "./thumbnailGridModel";

type VisibilityListener = (isVisible: boolean) => void;

/**
 * Starts reporting when an element comes near the viewport; returns a function that stops it.
 */
type ObserveVisibility = (
  element: Element,
  listener: VisibilityListener,
) => () => void;

type RegisterButton = (id: string, button: HTMLButtonElement | null) => void;

type ThumbnailGridProps = {
  cells: readonly ThumbnailGridCell[];
  /** The cell to focus and scroll to when the grid opens, such as the image just reviewed. */
  focusCellId: string | null;
  /** Shown instead of the grid when there are no cells. */
  emptyMessage: string;
  onOpen: (id: string) => void;
  /** Rotates a cell's A image by the given degrees (±90). */
  onRotate: (id: string, delta: number) => void;
  /** False while rotating is unavailable, such as during an upload. */
  canRotate: boolean;
  /** The IDs of the cells chosen for a bulk action. */
  selectedIds: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
};

type LazyThumbnailProps = {
  url: string;
  /** The rotation, in degrees, to show the thumbnail with until the file itself is rotated. */
  rotation: number;
  observeVisibility: ObserveVisibility;
  loadQueue: ThumbnailLoadQueue;
};

/**
 * Shows a placeholder until the thumbnail scrolls near the viewport and the load queue
 * has a free slot, then loads it. Leaving the grid abandons loads still in progress.
 */
const LazyThumbnail = ({
  url,
  rotation,
  observeVisibility,
  loadQueue,
}: LazyThumbnailProps) => {
  const frameRef = useRef<HTMLSpanElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  // Once the load has started, the image has its source and the cell never needs a slot again.
  // Queueing it again would take a slot that no load event ever releases.
  const hasStartedRef = useRef(false);
  const [src, setSrc] = useState("");
  const [status, setStatus] = useState<"waiting" | "loaded" | "error">(
    "waiting",
  );

  useEffect(() => {
    const frame = frameRef.current;
    const image = imageRef.current;
    if (!frame || !image) {
      return;
    }

    const stopObserving = observeVisibility(frame, (isVisible) => {
      if (hasStartedRef.current) {
        return;
      }
      if (isVisible) {
        loadQueue.enqueue(url, () => {
          hasStartedRef.current = true;
          setSrc(url);
        });
      } else {
        loadQueue.withdraw(url);
      }
    });

    return () => {
      stopObserving();
      loadQueue.release(url);
      // Removing the source cancels a request that is still in flight.
      if (!image.complete) {
        image.removeAttribute("src");
      }
    };
  }, [loadQueue, observeVisibility, url]);

  const finishLoad = (nextStatus: "loaded" | "error") => {
    setStatus(nextStatus);
    loadQueue.release(url);
  };

  return (
    <span
      ref={frameRef}
      className={`thumbnail-frame thumbnail-frame--${status}`}
      aria-hidden="true"
    >
      <img
        ref={imageRef}
        src={src || undefined}
        alt=""
        style={rotation ? { transform: `rotate(${rotation}deg)` } : undefined}
        decoding="async"
        draggable={false}
        onLoad={() => finishLoad("loaded")}
        onError={() => finishLoad("error")}
      />
      {status === "error" ? (
        <span className="thumbnail-placeholder-text">No preview</span>
      ) : null}
    </span>
  );
};

type ThumbnailCellProps = {
  cell: ThumbnailGridCell;
  observeVisibility: ObserveVisibility;
  loadQueue: ThumbnailLoadQueue;
  registerButton: RegisterButton;
  onOpen: (id: string) => void;
  onRotate: (id: string, delta: number) => void;
  canRotate: boolean;
  isSelected: boolean;
  onToggleSelect: (id: string) => void;
};

const ThumbnailCell = memo(function ThumbnailCell({
  cell,
  observeVisibility,
  loadQueue,
  registerButton,
  onOpen,
  onRotate,
  canRotate,
  isSelected,
  onToggleSelect,
}: ThumbnailCellProps) {
  const { id } = cell;
  const setButton = useCallback(
    (button: HTMLButtonElement | null) => registerButton(id, button),
    [id, registerButton],
  );

  return (
    <li
      className={`thumbnail-cell${isSelected ? " thumbnail-cell--selected" : ""}`}
    >
      <button
        ref={setButton}
        type="button"
        className="thumbnail-button"
        aria-label={describeGridCell(cell)}
        title={cell.imageLabel}
        onClick={() => onOpen(id)}
      >
        <LazyThumbnail
          key={cell.thumbnailUrl}
          url={cell.thumbnailUrl}
          rotation={cell.rotation}
          observeVisibility={observeVisibility}
          loadQueue={loadQueue}
        />
        <span className="thumbnail-caption" aria-hidden="true">
          <span
            className={`thumbnail-date${cell.date ? "" : " thumbnail-date--missing"}`}
          >
            {formatGridDate(cell.date)}
          </span>
          {cell.isPaired || cell.doNotUpload || cell.isUnprocessed ? (
            <span className="thumbnail-badges">
              {cell.isPaired ? (
                <span className="thumbnail-badge thumbnail-badge--paired">
                  Paired
                </span>
              ) : null}
              {cell.doNotUpload ? (
                <span className="thumbnail-badge thumbnail-badge--excluded">
                  Do not upload
                </span>
              ) : null}
              {cell.isUnprocessed ? (
                <span className="thumbnail-badge thumbnail-badge--unprocessed">
                  Unprocessed
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
      </button>
      {/* Siblings of the cell's button, since buttons cannot be nested; they sit over its corners. */}
      <input
        type="checkbox"
        className="thumbnail-select"
        aria-label={`Select ${cell.imageLabel}`}
        checked={isSelected}
        onChange={() => onToggleSelect(id)}
      />
      <button
        type="button"
        className="thumbnail-rotate thumbnail-rotate--left"
        aria-label={`Rotate ${cell.imageLabel} left`}
        title="Rotate left"
        disabled={!canRotate}
        onClick={() => onRotate(id, -90)}
      >
        <span aria-hidden="true">↺</span>
      </button>
      <button
        type="button"
        className="thumbnail-rotate thumbnail-rotate--right"
        aria-label={`Rotate ${cell.imageLabel} right`}
        title="Rotate right"
        disabled={!canRotate}
        onClick={() => onRotate(id, 90)}
      >
        <span aria-hidden="true">↻</span>
      </button>
    </li>
  );
});

/**
 * Shows every image group as an A-side thumbnail with its XMP date. Thumbnails load lazily,
 * at most a few at a time; pressing a cell opens that image in Review.
 */
export const ThumbnailGrid = ({
  cells,
  focusCellId,
  emptyMessage,
  onOpen,
  onRotate,
  canRotate,
  selectedIds,
  onToggleSelect,
}: ThumbnailGridProps) => {
  const [loadQueue] = useState(createThumbnailLoadQueue);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const listenersRef = useRef(new Map<Element, VisibilityListener>());
  const buttonsRef = useRef(new Map<string, HTMLButtonElement>());
  // Only the cell named when the grid opens is focused; later selection changes,
  // such as picking a filter, must not move focus away from the control in use.
  const initialFocusCellIdRef = useRef(focusCellId);

  const observeVisibility = useCallback<ObserveVisibility>(
    (element, listener) => {
      if (!observerRef.current) {
        observerRef.current = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              listenersRef.current.get(entry.target)?.(entry.isIntersecting);
            }
          },
          { rootMargin: "400px 0px" },
        );
      }

      const observer = observerRef.current;
      const listeners = listenersRef.current;
      listeners.set(element, listener);
      observer.observe(element);
      return () => {
        listeners.delete(element);
        observer.unobserve(element);
      };
    },
    [],
  );

  const registerButton = useCallback<RegisterButton>((id, button) => {
    if (button) {
      buttonsRef.current.set(id, button);
    } else {
      buttonsRef.current.delete(id);
    }
  }, []);

  useEffect(() => {
    const focusCellId = initialFocusCellIdRef.current;
    const button = focusCellId ? buttonsRef.current.get(focusCellId) : null;
    if (button) {
      button.focus({ preventScroll: true });
      button.scrollIntoView({ block: "center" });
    }
  }, []);

  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      loadQueue.clear();
    },
    [loadQueue],
  );

  if (!cells.length) {
    return <p role="status">{emptyMessage}</p>;
  }

  return (
    <ul className="thumbnail-grid" aria-label="Images">
      {cells.map((cell) => (
        <ThumbnailCell
          key={cell.id}
          cell={cell}
          observeVisibility={observeVisibility}
          loadQueue={loadQueue}
          registerButton={registerButton}
          onOpen={onOpen}
          onRotate={onRotate}
          canRotate={canRotate}
          isSelected={selectedIds.has(cell.id)}
          onToggleSelect={onToggleSelect}
        />
      ))}
    </ul>
  );
};
