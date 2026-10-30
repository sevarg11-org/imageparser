import assert from "node:assert/strict";
import test from "node:test";
import {
  createLookupCache,
  fetchImmichAlbums,
  fetchImmichTags,
  findAlbumByName,
  mapPermittedAlbums,
  mapTagValues,
} from "./immichLookup.js";

const albums = [
  {
    id: "1",
    albumName: "Vacation",
    assetCount: 3,
    ownerId: "me",
    shared: false,
    secret: "x",
  },
  {
    id: "2",
    albumName: "Edit me",
    assetCount: 1,
    ownerId: "o",
    albumUsers: [{ user: { id: "me" }, role: "editor" }],
  },
  {
    id: "3",
    albumName: "View only",
    ownerId: "o",
    albumUsers: [{ user: { id: "me" }, role: "viewer" }],
  },
  { id: "4", albumName: "Not mine", ownerId: "o", albumUsers: [] },
];

test("older Immich: ownerId and editor roles still work", () => {
  assert.deepEqual(mapPermittedAlbums(albums, "me"), [
    { id: "2", albumName: "Edit me", assetCount: 1, shared: true },
    { id: "1", albumName: "Vacation", assetCount: 3, shared: false },
  ]);
});

/** Albums as current Immich returns them: no ownerId; the owner is an albumUsers entry with the owner role. */
const currentAlbums = [
  {
    id: "1",
    albumName: "Vacation",
    assetCount: 3,
    shared: false,
    albumUsers: [{ user: { id: "me" }, role: "owner" }],
  },
  {
    id: "2",
    albumName: "Edit me",
    assetCount: 1,
    shared: true,
    albumUsers: [
      { user: { id: "o" }, role: "owner" },
      { user: { id: "me" }, role: "editor" },
    ],
  },
  {
    id: "3",
    albumName: "View only",
    albumUsers: [
      { user: { id: "o" }, role: "owner" },
      { user: { id: "me" }, role: "viewer" },
    ],
  },
  {
    id: "4",
    albumName: "Not mine",
    albumUsers: [{ user: { id: "o" }, role: "owner" }],
  },
];

test("current Immich: owned and editor albums are kept, with the owner read from albumUsers", () => {
  assert.deepEqual(mapPermittedAlbums(currentAlbums, "me"), [
    { id: "2", albumName: "Edit me", assetCount: 1, shared: true },
    { id: "1", albumName: "Vacation", assetCount: 3, shared: false },
  ]);
});

test("a shared album the user owns is still listed", () => {
  const owned = [
    {
      id: "5",
      albumName: "Family",
      shared: true,
      albumUsers: [
        { user: { id: "me" }, role: "owner" },
        { user: { id: "o" }, role: "viewer" },
      ],
    },
  ];
  assert.deepEqual(mapPermittedAlbums(owned, "me"), [
    { id: "5", albumName: "Family", assetCount: 0, shared: true },
  ]);
});

test("album names match case-insensitively and return the stored spelling", () => {
  const list = [{ albumName: "Vacation" }];
  assert.equal(findAlbumByName(list, " vacation ")?.albumName, "Vacation");
  assert.equal(findAlbumByName(list, "Holiday"), undefined);
  assert.equal(findAlbumByName(list, ""), undefined);
});

test("fetchImmichAlbums calls Immich once with the key and maps the albums", async () => {
  const seen = [];
  const fetchMock = async (url, options) => {
    seen.push([url, options.headers["x-api-key"]]);
    const body = url.endsWith("/users/me") ? { id: "me" } : currentAlbums;
    return { ok: true, status: 200, json: async () => body };
  };
  const result = await fetchImmichAlbums(
    { serverUrl: "https://immich.test/", userApiKey: "key" },
    fetchMock,
  );
  assert.equal(result.length, 2);
  assert.deepEqual(
    seen.map(([url]) => url),
    ["https://immich.test/api/users/me", "https://immich.test/api/albums"],
  );
  assert.ok(seen.every(([, key]) => key === "key"));
});

test("lookup failures carry a safe message without the key", async () => {
  await assert.rejects(
    fetchImmichAlbums(
      { serverUrl: "https://i.test", userApiKey: "secret-key" },
      async () => ({ ok: false, status: 401 }),
    ),
    (error) =>
      /401/.test(error.message) && !error.message.includes("secret-key"),
  );
  await assert.rejects(
    fetchImmichAlbums({ serverUrl: "", userApiKey: "" }),
    /Enter the Immich/,
  );
});

test("tags map to unique full paths and drop everything else", async () => {
  const raw = [
    {
      id: "a",
      name: "Parents",
      value: "Family/Parents",
      parentId: "p",
      color: "#fff",
    },
    { id: "b", name: "family", value: "family/parents" },
    { id: "c", name: "Zoo", value: "Zoo" },
    { id: "d", name: "", value: "" },
  ];
  assert.deepEqual(mapTagValues(raw), ["Family/Parents", "Zoo"]);
  const result = await fetchImmichTags(
    { serverUrl: "https://i.test", userApiKey: "k" },
    async (url) => {
      assert.equal(url, "https://i.test/api/tags");
      return { ok: true, status: 200, json: async () => raw };
    },
  );
  assert.deepEqual(result, ["Family/Parents", "Zoo"]);
});

test("the cache expires entries after a minute", () => {
  let now = 0;
  const cache = createLookupCache(() => now);
  cache.set("u", [1]);
  assert.deepEqual(cache.get("u"), [1]);
  now = 60_001;
  assert.equal(cache.get("u"), undefined);
});
