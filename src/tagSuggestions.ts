export type TagOption = { tag: string; isNew: boolean };

const sameTag = (left: string, right: string) =>
  left.toLocaleLowerCase() === right.toLocaleLowerCase();

/**
 * Merges tag sources into one list, keeping the first spelling of each tag (ignoring case), so Immich tags
 * come before recent sidecar tags that Immich does not have yet.
 */
export const mergeTagSources = (...sources: string[][]): string[] => {
  const uniqueTags = new Map<string, string>();
  for (const source of sources) {
    for (const value of source) {
      const tag = value.trim();
      if (tag && !uniqueTags.has(tag.toLocaleLowerCase())) {
        uniqueTags.set(tag.toLocaleLowerCase(), tag);
      }
    }
  }
  return [...uniqueTags.values()];
};

/**
 * Whether a tag path matches the query. The query matches the full path or any path segment, so "par" finds
 * "Family/Parents"; an empty query matches everything.
 */
export const tagMatchesQuery = (tag: string, query: string): boolean => {
  const wanted = query.trim().toLocaleLowerCase();
  return (
    !wanted ||
    tag.toLocaleLowerCase().includes(wanted) ||
    tag
      .toLocaleLowerCase()
      .split("/")
      .some((segment) => segment.includes(wanted))
  );
};

/**
 * Builds the typeahead options: matching known tags (not already chosen), then the typed text as a new tag
 * when no known tag has exactly that path.
 * @param suggestions - Merged known tags, Immich first.
 * @param query - The typed text.
 * @param selectedTags - Tags already on the image, which are not offered again.
 */
export const buildTagOptions = (
  suggestions: string[],
  query: string,
  selectedTags: string[] = [],
): TagOption[] => {
  const options: TagOption[] = suggestions
    .filter(
      (tag) =>
        tagMatchesQuery(tag, query) &&
        !selectedTags.some((selected) => sameTag(selected, tag)),
    )
    .map((tag) => ({ tag, isNew: false }));

  const typed = query.trim();
  const isKnown = suggestions.some((tag) => sameTag(tag, typed));
  const isSelected = selectedTags.some((tag) => sameTag(tag, typed));
  if (typed && !isKnown && !isSelected) {
    options.push({ tag: typed, isNew: true });
  }
  return options;
};
