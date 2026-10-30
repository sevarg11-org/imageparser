export type AlbumOption =
  | { kind: "existing"; albumName: string; assetCount: number; shared: boolean }
  | { kind: "create"; albumName: string };

type AlbumSource = { albumName: string; assetCount: number; shared: boolean };

/**
 * Builds the combobox options for the typed text: albums whose name contains it (case-insensitive), then an
 * explicit "create" option when no album already has exactly that name, so `Vacation` and `vacation` never
 * produce a duplicate album.
 */
export const buildAlbumOptions = (
  albums: AlbumSource[],
  typedText: string,
): AlbumOption[] => {
  const typed = typedText.trim();
  const wanted = typed.toLocaleLowerCase();
  const options: AlbumOption[] = albums
    .filter((album) => album.albumName.toLocaleLowerCase().includes(wanted))
    .map((album) => ({ kind: "existing", ...album }));

  const hasExactMatch = albums.some(
    (album) => album.albumName.toLocaleLowerCase() === wanted,
  );
  if (typed && !hasExactMatch) {
    options.push({ kind: "create", albumName: typed });
  }
  return options;
};

/**
 * Resolves the name to upload into: an existing album's exact spelling when the text matches one ignoring case,
 * otherwise the trimmed text (immich-go creates that album).
 */
export const resolveAlbumName = (
  albums: AlbumSource[],
  typedText: string,
): string => {
  const typed = typedText.trim();
  const wanted = typed.toLocaleLowerCase();
  return (
    albums.find((album) => album.albumName.toLocaleLowerCase() === wanted)
      ?.albumName ?? typed
  );
};
