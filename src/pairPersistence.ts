export type RotationField = "front" | "back";

export type PairRotationState = {
  front: number;
  back: number;
};

export type ImageSaveResult = {
  field: RotationField;
  filePath: string;
  ok: boolean;
  dateWritten: boolean;
  rotated: boolean;
  version?: string;
  error?: string;
};

/**
 * Decides whether leaving a pair has to save it.
 * A pair is saved when the user edited it, when a rotation is still pending, or when it has no
 * sidecar yet (so viewing a new pair still records its date, as before). Otherwise nothing is written.
 * @param state - Whether the user changed the form, the pending rotations, and whether the A-file sidecar exists.
 * @returns True when the pair must be saved.
 */
export const needsSaveOnLeave = ({
  hasUserChanged,
  rotations,
  hasSidecar,
}: {
  hasUserChanged: boolean;
  rotations: PairRotationState;
  hasSidecar: boolean;
}) =>
  hasUserChanged ||
  rotations.front !== 0 ||
  rotations.back !== 0 ||
  !hasSidecar;

/**
 * Returns the rotations that are still pending after a save: the ones whose image failed to update.
 * Rotations that were applied are cleared, so they are never applied a second time.
 * @param rotations - The rotations sent with the save.
 * @param results - The per-image save results.
 * @returns The rotations still to apply.
 */
export const getRemainingRotations = (
  rotations: PairRotationState,
  results: readonly ImageSaveResult[],
): PairRotationState => {
  const remaining = { ...rotations };
  for (const result of results) {
    if (result.ok) {
      remaining[result.field] = 0;
    }
  }
  return remaining;
};

/**
 * Collects the version of every image a save rewrote, so their previews are reloaded.
 * @param results - The per-image save results.
 * @returns A map from file path to its new version.
 */
export const getUpdatedImageVersions = (
  results: readonly ImageSaveResult[],
): Record<string, string> =>
  Object.fromEntries(
    results
      .filter((result) => result.ok && result.version)
      .map((result) => [result.filePath, result.version as string]),
  );

/**
 * Builds the status message for a save that failed, naming the affected image.
 * @param imageLabel - The image pair's label.
 * @param reason - The error messages, if any.
 * @returns The status message.
 */
export const describeSaveFailure = (
  imageLabel: string,
  reason: readonly (string | undefined)[] = [],
) => {
  const details = reason.filter(Boolean).join(" ");
  return `Could not save changes to ${imageLabel}.${details ? ` ${details}` : ""} Your changes are kept; open the image again to retry.`;
};

/**
 * Builds a status suffix listing images whose changes could not be saved.
 * @param imageLabels - The labels of the affected images.
 * @returns The suffix, or an empty string when every save succeeded.
 */
export const describeUnsavedImages = (imageLabels: readonly string[]) =>
  imageLabels.length
    ? ` Unsaved changes: ${imageLabels.slice(0, 3).join(", ")}${imageLabels.length > 3 ? ` and ${imageLabels.length - 3} more` : ""}.`
    : "";

/**
 * Computes the visible box of an image shown with a CSS rotation, fitted to the available space.
 * @param options - The image's natural size, its rotation, the width available, and the target height (null to fill the width).
 * @returns The visible width and height of the rotated image.
 */
export const getRotatedImageBox = ({
  naturalWidth,
  naturalHeight,
  rotation,
  availableWidth,
  targetHeight,
}: {
  naturalWidth: number;
  naturalHeight: number;
  rotation: number;
  availableWidth: number;
  targetHeight: number | null;
}) => {
  const isQuarterTurn = rotation % 180 !== 0;
  const visibleAspect = isQuarterTurn
    ? naturalHeight / naturalWidth
    : naturalWidth / naturalHeight;

  let width =
    targetHeight === null ? availableWidth : targetHeight * visibleAspect;
  let height =
    targetHeight === null ? availableWidth / visibleAspect : targetHeight;
  if (width > availableWidth) {
    width = availableWidth;
    height = availableWidth / visibleAspect;
  }
  return { width, height };
};

/**
 * Rotates a point clockwise (in screen coordinates) around the origin by a multiple of 90 degrees.
 * @param point - The point to rotate.
 * @param rotation - The clockwise rotation in degrees.
 * @returns The rotated point.
 */
export const rotatePoint = (
  point: { x: number; y: number },
  rotation: number,
) => {
  const quarterTurns = ((Math.round(rotation / 90) % 4) + 4) % 4;
  switch (quarterTurns) {
    case 1:
      return { x: -point.y, y: point.x };
    case 2:
      return { x: -point.x, y: -point.y };
    case 3:
      return { x: point.y, y: -point.x };
    default:
      return { x: point.x, y: point.y };
  }
};

/**
 * Maps a point on a rotated image (relative to its visible box) back to the unrotated image.
 * Used by the magnifier, which samples the unrotated image and rotates the lens contents.
 * @param point - The point relative to the visible box's top-left corner.
 * @param visibleSize - The visible (rotated) box size.
 * @param layoutSize - The image's unrotated layout size.
 * @param rotation - The clockwise rotation in degrees (a multiple of 90).
 * @returns The point relative to the unrotated image's top-left corner.
 */
export const mapRotatedPointToImage = (
  point: { x: number; y: number },
  visibleSize: { width: number; height: number },
  layoutSize: { width: number; height: number },
  rotation: number,
) => {
  const { x, y } = rotatePoint(
    {
      x: point.x - visibleSize.width / 2,
      y: point.y - visibleSize.height / 2,
    },
    -rotation,
  );
  return { x: x + layoutSize.width / 2, y: y + layoutSize.height / 2 };
};
