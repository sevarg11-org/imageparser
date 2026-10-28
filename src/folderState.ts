/**
 * Whether a reviewer marked a folder processed, read from the folder's `.imageparser.json` marker.
 */
export type FolderState = {
  processed: boolean;
  // ISO timestamp of when the folder was marked, or null when unknown or not processed.
  processedAt: string | null;
  // The user who marked the folder, or null without sign-in or when not processed.
  processedBy: string | null;
};

export const unprocessedFolderState: FolderState = {
  processed: false,
  processedAt: null,
  processedBy: null,
};

/**
 * The result of marking a folder, and optionally its subfolders, processed or not processed.
 */
export type SetFolderProcessedResult = {
  ok: boolean;
  state: FolderState;
  updatedFolders: number;
  errors: string[];
};

const padDatePart = (value: number) => value.toString().padStart(2, "0");

/**
 * Formats a timestamp as a local YYYY-MM-DD date.
 * @param timestamp - An ISO timestamp.
 * @returns The local date, or null when the timestamp is invalid.
 */
const formatLocalDate = (timestamp: string) => {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
};

/**
 * Describes who marked a folder processed and when, for tooltips.
 * @param state - The folder state.
 * @returns For example "Processed by dennis on 2026-10-27", or "Not processed".
 */
export const describeFolderState = (state: FolderState) => {
  if (!state.processed) {
    return "Not processed";
  }
  const date = state.processedAt ? formatLocalDate(state.processedAt) : null;
  return [
    "Processed",
    state.processedBy ? `by ${state.processedBy}` : null,
    date ? `on ${date}` : null,
  ]
    .filter(Boolean)
    .join(" ");
};
