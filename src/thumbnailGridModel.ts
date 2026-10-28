/**
 * The long-edge size, in pixels, requested for grid thumbnails.
 */
export const GRID_THUMBNAIL_SIZE = 320;

/**
 * The most thumbnails the grid loads at once. Thumbnail renders share the serial
 * image queue with metadata saves, so this keeps a save from waiting long.
 */
export const MAX_THUMBNAIL_LOADS = 4;

/**
 * What a grid cell shows about one image group.
 */
export type ThumbnailGridCell = {
  id: string;
  imageLabel: string;
  /** The A-file XMP date as YYYY-MM-DD, or an empty string when there is none. */
  date: string;
  isPaired: boolean;
  doNotUpload: boolean;
  isUnprocessed: boolean;
  thumbnailUrl: string;
  /** A rotation, in degrees, chosen in the grid but not yet applied to the file. */
  rotation: number;
};

/**
 * The caption shown under a thumbnail.
 * @param date - The XMP date as YYYY-MM-DD, or an empty string.
 * @returns The date, or "No date".
 */
export const formatGridDate = (date: string) => date || "No date";

/**
 * Builds a grid cell's accessible name, for example
 * "img001_a.jpg, dated 1991-12-25, paired".
 * @param cell - The cell to describe.
 * @returns The accessible name for the cell's button.
 */
export const describeGridCell = (
  cell: Pick<
    ThumbnailGridCell,
    "imageLabel" | "date" | "isPaired" | "doNotUpload" | "isUnprocessed"
  >,
) =>
  [
    cell.imageLabel,
    cell.date ? `dated ${cell.date}` : "no date",
    cell.isPaired ? "paired" : "",
    cell.doNotUpload ? "do not upload" : "",
    cell.isUnprocessed ? "unprocessed" : "",
  ]
    .filter(Boolean)
    .join(", ");

/**
 * A first-in, first-out queue that lets at most a fixed number of thumbnails load at once.
 */
export type ThumbnailLoadQueue = {
  /**
   * Asks to load a thumbnail. `start` runs now if a slot is free, or later when one frees up.
   * Asking again for a key that is already waiting or loading does nothing.
   */
  enqueue: (key: string, start: () => void) => void;
  /**
   * Frees the key's slot when its load finished, failed, or was abandoned,
   * or drops it from the waiting list if it had not started.
   */
  release: (key: string) => void;
  /**
   * Drops the key if it is still waiting, for example when its cell scrolls out of view.
   * A load that has already started keeps its slot until it is released.
   */
  withdraw: (key: string) => void;
  /** Drops every waiting and loading key, for example when the grid closes. */
  clear: () => void;
  /** The number of loads in progress. */
  activeCount: () => number;
  /** The number of loads waiting for a free slot. */
  waitingCount: () => number;
};

/**
 * Creates a thumbnail load queue.
 * @param maxActive - The most loads allowed at once.
 * @returns The queue.
 */
export const createThumbnailLoadQueue = (
  maxActive: number = MAX_THUMBNAIL_LOADS,
): ThumbnailLoadQueue => {
  const active = new Set<string>();
  const waiting = new Map<string, () => void>();

  const startWaiting = () => {
    for (const [key, start] of waiting) {
      if (active.size >= maxActive) {
        return;
      }
      waiting.delete(key);
      active.add(key);
      start();
    }
  };

  return {
    enqueue: (key, start) => {
      if (active.has(key) || waiting.has(key)) {
        return;
      }
      waiting.set(key, start);
      startWaiting();
    },
    release: (key) => {
      waiting.delete(key);
      if (active.delete(key)) {
        startWaiting();
      }
    },
    withdraw: (key) => {
      waiting.delete(key);
    },
    clear: () => {
      waiting.clear();
      active.clear();
    },
    activeCount: () => active.size,
    waitingCount: () => waiting.size,
  };
};
