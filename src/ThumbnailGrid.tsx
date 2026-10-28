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
};

type LazyThumbnailProps = {
  url: string;
  observeVisibility: ObserveVisibility;
  loadQueue: ThumbnailLoadQueue;
};

/**
 * Shows a placeholder until the thumbnail scrolls near the viewport and the load queue
 * has a free slot, then loads it. Leaving the grid abandons loads still in progress.
 */
const LazyThumbnail = ({
  url,
  observeVisibility,
  loadQueue,
}: LazyThumbnailProps) => {
  const frameRef = useRef<HTMLSpanElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
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
      if (isVisible) {
        loadQueue.enqueue(url, () => setSrc(url));
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
};

const ThumbnailCell = memo(function ThumbnailCell({
  cell,
  observeVisibility,
  loadQueue,
  registerButton,
  onOpen,
}: ThumbnailCellProps) {
  const { id } = cell;
  const setButton = useCallback(
    (button: HTMLButtonElement | null) => registerButton(id, button),
    [id, registerButton],
  );

  return (
    <li className="thumbnail-cell">
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
        />
      ))}
    </ul>
  );
};
