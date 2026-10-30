import assert from "node:assert/strict";
import test from "node:test";
import { buildAlbumOptions, resolveAlbumName } from "./albumOptions.ts";

const albums = [
  { albumName: "Vacation", assetCount: 2, shared: false },
  { albumName: "Family", assetCount: 5, shared: true },
];

test("typing filters albums and offers to create an unmatched name", () => {
  const options = buildAlbumOptions(albums, "vac");
  assert.deepEqual(
    options.map((option) => [option.kind, option.albumName]),
    [
      ["existing", "Vacation"],
      ["create", "vac"],
    ],
  );
});

test("an exact match ignoring case offers no duplicate create option", () => {
  const options = buildAlbumOptions(albums, "vacation");
  assert.deepEqual(
    options.map((option) => option.kind),
    ["existing"],
  );
});

test("empty text lists every album without a create option", () => {
  assert.equal(buildAlbumOptions(albums, "  ").length, 2);
});

test("the resolved name uses the stored spelling of a case-insensitive match", () => {
  assert.equal(resolveAlbumName(albums, " vacation "), "Vacation");
  assert.equal(resolveAlbumName(albums, " New one "), "New one");
});
