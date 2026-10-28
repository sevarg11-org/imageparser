/**
 * The single-choice image filter shown in the review toolbar.
 */
export type ImageFilter = "all" | "pairs" | "unprocessed";

/**
 * The fields of an image group that the filters read.
 */
export type FilterablePair = {
  id: string;
  backPath: string | null;
  hasSidecar: boolean;
};

export const imageFilterOptions: ReadonlyArray<{
  value: ImageFilter;
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "pairs", label: "Pairs" },
  { value: "unprocessed", label: "Unprocessed" },
];

/**
 * Checks whether a value is one of the supported image filters.
 * @param value - The value to check, for example a `<select>` value.
 * @returns True when the value is a valid image filter.
 */
export const isImageFilter = (value: string): value is ImageFilter =>
  imageFilterOptions.some((option) => option.value === value);

/**
 * Checks whether an image group has been processed: its A file has an XMP
 * sidecar on disk, or a sidecar was saved for it during this session.
 * @param pair - The image group to check.
 * @param savedPairIds - IDs of groups whose metadata was saved this session.
 * @returns True when the group counts as processed.
 */
export const isPairProcessed = (
  pair: FilterablePair,
  savedPairIds: ReadonlySet<string>,
) => pair.hasSidecar || savedPairIds.has(pair.id);

/**
 * Checks whether an image group matches a filter.
 * @param pair - The image group to check.
 * @param filter - The selected image filter.
 * @param savedPairIds - IDs of groups whose metadata was saved this session.
 * @returns True when the group belongs in the filtered list.
 */
export const matchesImageFilter = (
  pair: FilterablePair,
  filter: ImageFilter,
  savedPairIds: ReadonlySet<string>,
) => {
  switch (filter) {
    case "pairs":
      return pair.backPath !== null;
    case "unprocessed":
      return !isPairProcessed(pair, savedPairIds);
    default:
      return true;
  }
};

/**
 * Filters image groups for display. Pass the saved IDs as they were when the
 * filter was chosen, so groups saved afterwards stay in the list and can still
 * be reached with Previous.
 * @param pairs - All image groups in the folder, in display order.
 * @param filter - The selected image filter.
 * @param savedPairIds - IDs of groups whose metadata was saved this session.
 * @returns The filtered image groups, in their original order.
 */
export const filterImagePairs = <Pair extends FilterablePair>(
  pairs: readonly Pair[],
  filter: ImageFilter,
  savedPairIds: ReadonlySet<string>,
) => pairs.filter((pair) => matchesImageFilter(pair, filter, savedPairIds));

/**
 * Counts how many image groups match each filter, for the option labels.
 * @param pairs - All image groups in the folder.
 * @param savedPairIds - IDs of groups whose metadata was saved this session.
 * @returns The number of matching groups for every filter.
 */
export const countImageFilterMatches = (
  pairs: readonly FilterablePair[],
  savedPairIds: ReadonlySet<string>,
): Record<ImageFilter, number> => {
  const counts: Record<ImageFilter, number> = {
    all: 0,
    pairs: 0,
    unprocessed: 0,
  };
  for (const pair of pairs) {
    for (const { value } of imageFilterOptions) {
      if (matchesImageFilter(pair, value, savedPairIds)) {
        counts[value] += 1;
      }
    }
  }
  return counts;
};

/**
 * Describes why a filtered list is empty, for the review screen's empty state.
 * @param filter - The selected image filter.
 * @param totalCount - The number of image groups in the folder.
 * @returns A short message for the empty state.
 */
export const getEmptyFilterMessage = (
  filter: ImageFilter,
  totalCount: number,
) => {
  if (totalCount === 0) {
    return "No images to review. Choose a folder that contains photos.";
  }
  switch (filter) {
    case "pairs":
      return "No images in this folder have both an A and a B side.";
    case "unprocessed":
      return "All images in this folder have been processed.";
    default:
      return "No images to review.";
  }
};
