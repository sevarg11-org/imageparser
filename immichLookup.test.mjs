import assert from "node:assert/strict";
import test from "node:test";
import {
  createLookupCache,
  fetchImmichAlbums,
  findAlbumByName,
  mapPermittedAlbums,
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

test("maps albums to the minimal fields and keeps only permitted ones", () => {
  assert.deepEqual(mapPermittedAlbums(albums, "me"), [
    { id: "2", albumName: "Edit me", assetCount: 1, shared: true },
    { id: "1", albumName: "Vacation", assetCount: 3, shared: false },
  ]);
});

test("album names match case-insensitively and return the stored spelling", () => {
  const list = [{ albumName: "Vacation" }];
  assert.equal(findAlbumByName(list, " vacation ")?.albumName, "Vacation");
  assert.equal(findAlbumByName(list, "Holiday"), undefined);
  assert.equal(findAlbumByName(list, ""), undefined);
});

test("fetchImmichAlbums calls Immich with the key and merges shared albums", async () => {
  const seen = [];
  const fetchMock = async (url, options) => {
    seen.push([url, options.headers["x-api-key"]]);
    const body = url.endsWith("/users/me")
      ? { id: "me" }
      : url.endsWith("shared=true")
        ? [albums[1]]
        : [albums[0]];
    return { ok: true, status: 200, json: async () => body };
  };
  const result = await fetchImmichAlbums(
    { serverUrl: "https://immich.test/", userApiKey: "key" },
    fetchMock,
  );
  assert.equal(result.length, 2);
  assert.ok(
    seen.every(
      ([url, key]) =>
        url.startsWith("https://immich.test/api/") && key === "key",
    ),
  );
});

test("lookup failures carry a safe message without the key", async () => {
  await assert.rejects(
    fetchImmichAlbums(
      { serverUrl: "https://i.test", userApiKey: "secret-key" },
      async () => ({ ok: false, status: 401 }),
    ),
    (error) => /401/.test(error.message) && !error.message.includes("secret-key"),
  );
  await assert.rejects(
    fetchImmichAlbums({ serverUrl: "", userApiKey: "" }),
    /Enter the Immich/,
  );
});

test("the cache expires entries after a minute", () => {
  let now = 0;
  const cache = createLookupCache(() => now);
  cache.set("u", [1]);
  assert.deepEqual(cache.get("u"), [1]);
  now = 60_001;
  assert.equal(cache.get("u"), undefined);
});
