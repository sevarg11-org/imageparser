import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTagOptions,
  mergeTagSources,
  tagMatchesQuery,
} from "./tagSuggestions.ts";

test("Immich tags come first and duplicates are dropped ignoring case", () => {
  assert.deepEqual(
    mergeTagSources(["Family/Parents", "Zoo"], ["zoo", "School", " "]),
    ["Family/Parents", "Zoo", "School"],
  );
});

test("a query matches any path segment and shows the full path", () => {
  assert.equal(tagMatchesQuery("Family/Parents", "par"), true);
  assert.equal(tagMatchesQuery("Family/Parents", "FAM"), true);
  assert.equal(tagMatchesQuery("Family/Parents", "zoo"), false);
  assert.equal(tagMatchesQuery("Family/Parents", ""), true);
});

test("unmatched text is offered as a new tag, known text is not", () => {
  const known = ["Family/Parents", "Zoo"];
  assert.deepEqual(buildTagOptions(known, "par"), [
    { tag: "Family/Parents", isNew: false },
    { tag: "par", isNew: true },
  ]);
  assert.deepEqual(buildTagOptions(known, "zoo"), [
    { tag: "Zoo", isNew: false },
  ]);
  assert.deepEqual(buildTagOptions(known, "Pets/Dogs"), [
    { tag: "Pets/Dogs", isNew: true },
  ]);
});

test("already selected tags are not offered again", () => {
  assert.deepEqual(buildTagOptions(["Zoo"], "zoo", ["ZOO"]), []);
});
