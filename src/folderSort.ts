/**
 * Sorting for the folder browser. Pure helpers, so the order can be tested without a browser.
 */

export type FolderSortField = "name" | "created" | "processed";

export type FolderSortDirection = "ascending" | "descending";

export type FolderSort = {
  field: FolderSortField;
  direction: FolderSortDirection;
};

/**
 * A folder's filesystem date. `createdAtSource` is "modified" when the filesystem reports no creation
 * time and the modification time is used instead, and null when the folder has no date (a drive root).
 */
export type FolderDate = {
  // Milliseconds since the epoch, or null when unknown.
  createdAt: number | null;
  createdAtSource: "created" | "modified" | null;
};

export type SortableFolder = FolderDate & { name: string; processed: boolean };

export const FOLDER_SORT_STORAGE_KEY = "imageparser:folder-sort";

export const defaultFolderSort: FolderSort = {
  field: "name",
  direction: "ascending",
};

export const folderSortFieldLabels: Record<FolderSortField, string> = {
  name: "Name",
  created: "Date created",
  processed: "Processed",
};

const isFolderSortField = (value: unknown): value is FolderSortField =>
  value === "name" || value === "created" || value === "processed";

const isFolderSortDirection = (value: unknown): value is FolderSortDirection =>
  value === "ascending" || value === "descending";

/**
 * Reads a remembered sort, falling back to the default for anything missing or invalid.
 * @param stored - The raw stored JSON, or null when nothing is stored.
 * @returns The sort to use.
 */
export const parseFolderSort = (stored: string | null): FolderSort => {
  if (!stored) {
    return defaultFolderSort;
  }
  try {
    const value: unknown = JSON.parse(stored);
    if (value && typeof value === "object") {
      const { field, direction } = value as Record<string, unknown>;
      if (isFolderSortField(field) && isFolderSortDirection(direction)) {
        return { field, direction };
      }
    }
  } catch {
    // A corrupt value falls through to the default.
  }
  return defaultFolderSort;
};

// Natural order that ignores case, so "2" comes before "10" and "archive" sits with "Archive".
const nameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

const compareNames = (left: SortableFolder, right: SortableFolder) =>
  nameCollator.compare(left.name, right.name);

/**
 * Sorts folders for the folder browser without changing the input.
 * Name sorts naturally. Date created sorts oldest first when ascending, with undated folders last in
 * both directions. Processed puts unprocessed folders first when ascending. Ties sort by name ascending.
 * @param folders - The folders to sort.
 * @param sort - The field and direction.
 * @returns A new, sorted array.
 */
export const sortFolders = <T extends SortableFolder>(
  folders: readonly T[],
  sort: FolderSort,
): T[] => {
  const sign = sort.direction === "ascending" ? 1 : -1;
  const compare = (left: T, right: T) => {
    if (sort.field === "name") {
      return sign * compareNames(left, right);
    }
    if (sort.field === "created") {
      if (left.createdAt !== right.createdAt) {
        if (left.createdAt === null) {
          return 1;
        }
        if (right.createdAt === null) {
          return -1;
        }
        return sign * (left.createdAt - right.createdAt);
      }
    } else if (left.processed !== right.processed) {
      return sign * (left.processed ? 1 : -1);
    }
    return compareNames(left, right);
  };
  return [...folders].sort(compare);
};

const padDatePart = (value: number) => value.toString().padStart(2, "0");

/**
 * Describes a folder's filesystem date for the folder list, naming the fallback honestly.
 * @param folder - The folder's date.
 * @returns For example "Created 2026-10-27" or "Modified 2026-10-27", or null when there is no date.
 */
export const describeFolderDate = (folder: FolderDate) => {
  if (folder.createdAt === null || folder.createdAtSource === null) {
    return null;
  }
  const date = new Date(folder.createdAt);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const label = folder.createdAtSource === "created" ? "Created" : "Modified";
  return `${label} ${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
};
