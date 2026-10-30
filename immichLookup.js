/**
 * Read-only lookups against the Immich API, made with the signed-in user's own API key so results respect
 * that user's permissions. The key is only sent to Immich; it is never logged or returned to the browser.
 */

/**
 * How long a lookup result is reused before Immich is asked again.
 * @type {number}
 */
const lookupCacheMilliseconds = 60_000;

/**
 * How long Immich may take to answer before the lookup gives up, so a slow server never blocks the UI.
 * @type {number}
 */
const lookupTimeoutMilliseconds = 10_000;

/**
 * Error for a failed lookup whose message is safe to show to the user.
 */
class ImmichLookupError extends Error {}

/**
 * Calls a GET endpoint of the Immich API and parses the JSON answer.
 * @param {{serverUrl: string, userApiKey: string}} settings - The Immich URL and the user's API key.
 * @param {string} endpoint - The API path, for example "/albums".
 * @param {typeof fetch} fetchImpl - The fetch implementation (replaced in tests).
 * @returns {Promise<any>} The parsed JSON body.
 * @throws {ImmichLookupError} When Immich is not configured, unreachable, or answers with an error.
 */
const getImmichJson = async (settings, endpoint, fetchImpl = fetch) => {
  const serverUrl = String(settings?.serverUrl ?? "")
    .trim()
    .replace(/\/+$/, "");
  const apiKey = String(settings?.userApiKey ?? "").trim();
  if (!serverUrl || !apiKey) {
    throw new ImmichLookupError(
      "Enter the Immich server URL and your API key to load existing values.",
    );
  }

  let response;
  try {
    response = await fetchImpl(`${serverUrl}/api${endpoint}`, {
      headers: { "x-api-key": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(lookupTimeoutMilliseconds),
    });
  } catch {
    throw new ImmichLookupError("Immich could not be reached.");
  }
  if (!response.ok) {
    throw new ImmichLookupError(
      `Immich refused the request (status ${response.status}). Check the API key permissions.`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new ImmichLookupError("Immich returned an unreadable answer.");
  }
};

/**
 * Keeps the albums the user owns or can add assets to, and reduces them to the fields the browser needs.
 * @param {any[]} albums - The albums from Immich GET /albums.
 * @param {string} userId - The signed-in user's Immich id.
 * @returns {Array<{id: string, albumName: string, assetCount: number, shared: boolean}>} The permitted albums, sorted by name.
 */
const mapPermittedAlbums = (albums, userId) =>
  (Array.isArray(albums) ? albums : [])
    .filter((album) => {
      if (album?.ownerId === userId) {
        return true;
      }
      return (
        Array.isArray(album?.albumUsers) &&
        album.albumUsers.some(
          (member) => member?.user?.id === userId && member?.role === "editor",
        )
      );
    })
    .map((album) => ({
      id: String(album.id),
      albumName: String(album.albumName ?? ""),
      assetCount: Number(album.assetCount) || 0,
      shared: album.ownerId !== userId || Boolean(album.shared),
    }))
    .filter((album) => album.albumName)
    .sort((left, right) =>
      left.albumName.localeCompare(right.albumName, undefined, {
        sensitivity: "base",
      }),
    );

/**
 * Finds an existing album whose name equals the typed name, ignoring case and surrounding spaces.
 * @param {Array<{albumName: string}>} albums - The user's albums.
 * @param {string} typedName - The name the user typed.
 * @returns {{albumName: string}|undefined} The matching album, so its exact stored spelling can be used.
 */
const findAlbumByName = (albums, typedName) => {
  const wanted = String(typedName ?? "")
    .trim()
    .toLocaleLowerCase();
  return wanted
    ? albums.find((album) => album.albumName.toLocaleLowerCase() === wanted)
    : undefined;
};

/**
 * Creates a small time-based cache for per-user lookups.
 * @param {() => number} [now] - The clock in milliseconds (replaced in tests).
 * @returns {{get: (key: string) => any, set: (key: string, value: any) => void, delete: (key: string) => void}}
 */
const createLookupCache = (now = Date.now) => {
  const entries = new Map();
  return {
    get: (key) => {
      const entry = entries.get(key);
      if (!entry || now() - entry.storedAt > lookupCacheMilliseconds) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set: (key, value) => entries.set(key, { value, storedAt: now() }),
    delete: (key) => entries.delete(key),
  };
};

/**
 * Loads the albums the user may upload into.
 * @param {{serverUrl: string, userApiKey: string}} settings - The Immich URL and the user's API key.
 * @param {typeof fetch} [fetchImpl] - The fetch implementation (replaced in tests).
 * @returns {Promise<Array<{id: string, albumName: string, assetCount: number, shared: boolean}>>}
 */
const fetchImmichAlbums = async (settings, fetchImpl = fetch) => {
  const me = await getImmichJson(settings, "/users/me", fetchImpl);
  const [owned, shared] = await Promise.all([
    getImmichJson(settings, "/albums", fetchImpl),
    getImmichJson(settings, "/albums?shared=true", fetchImpl),
  ]);
  const byId = new Map();
  for (const album of [...owned, ...shared]) {
    byId.set(album?.id, album);
  }
  return mapPermittedAlbums([...byId.values()], String(me?.id ?? ""));
};

/**
 * Reduces Immich tags to their full hierarchical paths (for example "Family/Parents"), without duplicates
 * (ignoring case), sorted by path.
 * @param {any[]} tags - The tags from Immich GET /tags.
 * @returns {string[]} The tag paths.
 */
const mapTagValues = (tags) => {
  const uniqueByLowerCase = new Map();
  for (const tag of Array.isArray(tags) ? tags : []) {
    const value = String(tag?.value ?? "").trim();
    if (value && !uniqueByLowerCase.has(value.toLocaleLowerCase())) {
      uniqueByLowerCase.set(value.toLocaleLowerCase(), value);
    }
  }
  return [...uniqueByLowerCase.values()].sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" }),
  );
};

/**
 * Loads the user's existing Immich tags.
 * @param {{serverUrl: string, userApiKey: string}} settings - The Immich URL and the user's API key.
 * @param {typeof fetch} [fetchImpl] - The fetch implementation (replaced in tests).
 * @returns {Promise<string[]>} The full tag paths.
 */
const fetchImmichTags = async (settings, fetchImpl = fetch) =>
  mapTagValues(await getImmichJson(settings, "/tags", fetchImpl));

export {
  createLookupCache,
  fetchImmichAlbums,
  fetchImmichTags,
  mapTagValues,
  findAlbumByName,
  getImmichJson,
  ImmichLookupError,
  mapPermittedAlbums,
};
