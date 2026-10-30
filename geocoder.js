import fs from "node:fs/promises";
import path from "node:path";

/**
 * Place-name search for tagging photos with a location, kept to very few outgoing calls: explicit searches
 * only, a minimum query length, an in-memory and a persistent cache, a 1 request/second queue, and a small
 * result limit. The service is Photon (OpenStreetMap data); IMAGEPARSER_GEOCODER_URL can point at a
 * self-hosted Photon-compatible service.
 */

const defaultGeocoderUrl = "https://photon.komoot.io";
const userAgent =
  "ImageParser/1.0 (+https://github.com/sevarg11-org/imageparser)";
const minimumQueryLength = 3;
const maximumQueryLength = 200;
const resultLimit = 8;
const requestIntervalMilliseconds = 1000;
const requestTimeoutMilliseconds = 10_000;
/** Searches waiting for their turn beyond this are refused instead of piling up. */
const maximumQueuedRequests = 5;
const memoryCacheEntries = 200;
const persistentCacheEntries = 500;
const recentPlaceEntries = 20;

/**
 * Error whose message is safe to show to the user; statusCode says how the server should answer.
 */
class GeocoderError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Checks a latitude/longitude pair.
 * @param {number} latitude - Degrees, -90 through 90.
 * @param {number} longitude - Degrees, -180 through 180.
 * @returns {boolean} Whether both are finite and in range.
 */
const isValidCoordinatePair = (latitude, longitude) =>
  Number.isFinite(latitude) &&
  Number.isFinite(longitude) &&
  Math.abs(latitude) <= 90 &&
  Math.abs(longitude) <= 180;

/**
 * Normalizes a query for cache keys and comparison.
 * @param {string} query - The typed query.
 * @returns {string} Lower-cased text with collapsed spaces.
 */
const normalizeQuery = (query) =>
  String(query ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();

/**
 * Reduces Photon GeoJSON features to the places the browser shows, dropping anything without valid coordinates.
 * @param {any} payload - The parsed Photon answer.
 * @returns {Array<{id: string, name: string, locality: string, region: string, country: string, latitude: number, longitude: number}>}
 */
const mapPhotonPlaces = (payload) => {
  const places = [];
  for (const feature of Array.isArray(payload?.features)
    ? payload.features
    : []) {
    const [longitude, latitude] = feature?.geometry?.coordinates ?? [];
    const properties = feature?.properties ?? {};
    if (!isValidCoordinatePair(latitude, longitude)) {
      continue;
    }
    const locality = String(
      properties.city ??
        properties.town ??
        properties.village ??
        properties.district ??
        properties.county ??
        "",
    );
    const name = String(
      properties.name ?? properties.street ?? locality ?? "",
    ).trim();
    if (!name) {
      continue;
    }
    places.push({
      id: `${properties.osm_type ?? "x"}${properties.osm_id ?? `${latitude},${longitude}`}`,
      name,
      locality,
      region: String(properties.state ?? ""),
      country: String(properties.country ?? ""),
      latitude,
      longitude,
    });
  }
  return places;
};

/**
 * Creates the geocoder with its caches and request queue.
 * @param {{
 *   baseUrl?: string,
 *   cacheFile?: string|null,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   sleep?: (milliseconds: number) => Promise<void>,
 * }} [options] - The service URL, the persistent cache file (none keeps everything in memory), and
 *   replaceable fetch, clock and sleep for tests.
 * @returns {{search: (query: string) => Promise<Array<Object>>, getRecentPlaces: () => Promise<Array<Object>>, rememberPlace: (place: Object) => Promise<Object>}}
 */
const createGeocoder = ({
  baseUrl = defaultGeocoderUrl,
  cacheFile = null,
  fetchImpl = fetch,
  now = Date.now,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) => {
  const serviceUrl = String(baseUrl || defaultGeocoderUrl).replace(/\/+$/, "");
  const memoryCache = new Map();
  const inFlight = new Map();
  let persistent = null;
  let queue = Promise.resolve();
  let queued = 0;
  let lastRequestAt = -Infinity;

  const loadPersistent = async () => {
    if (persistent) {
      return persistent;
    }
    persistent = { queries: {}, recent: [] };
    if (cacheFile) {
      try {
        const stored = JSON.parse(await fs.readFile(cacheFile, "utf8"));
        persistent = {
          queries:
            stored?.queries && typeof stored.queries === "object"
              ? stored.queries
              : {},
          recent: Array.isArray(stored?.recent) ? stored.recent : [],
        };
      } catch {
        // A missing or unreadable cache simply starts empty.
      }
    }
    return persistent;
  };

  const savePersistent = async () => {
    if (!cacheFile) {
      return;
    }
    try {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      const temporaryFile = `${cacheFile}.tmp`;
      await fs.writeFile(temporaryFile, JSON.stringify(persistent), "utf8");
      await fs.rename(temporaryFile, cacheFile);
    } catch {
      // The cache only saves future calls; failing to write it must not fail the search.
    }
  };

  const remember = (map, key, value, limit) => {
    map.delete(key);
    map.set(key, value);
    while (map.size > limit) {
      map.delete(map.keys().next().value);
    }
  };

  /** Runs one outgoing request, at most one per second, refusing when too many are already waiting. */
  const enqueue = (task) => {
    if (queued >= maximumQueuedRequests) {
      throw new GeocoderError(
        429,
        "Too many place searches are waiting. Try again in a few seconds.",
      );
    }
    queued += 1;
    const run = queue.then(async () => {
      const wait = lastRequestAt + requestIntervalMilliseconds - now();
      if (wait > 0) {
        await sleep(wait);
      }
      lastRequestAt = now();
      return task();
    });
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      queued -= 1;
    });
  };

  const requestPlaces = async (query) => {
    const url = new URL(`${serviceUrl}/api`);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(resultLimit));
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { "User-Agent": userAgent, Accept: "application/json" },
        signal: AbortSignal.timeout(requestTimeoutMilliseconds),
      });
    } catch {
      throw new GeocoderError(502, "The place search could not be reached.");
    }
    if (response.status === 429) {
      throw new GeocoderError(
        429,
        "The place search service is limiting requests. Try again in a minute.",
      );
    }
    if (!response.ok) {
      throw new GeocoderError(
        502,
        `The place search failed (status ${response.status}).`,
      );
    }
    try {
      return mapPhotonPlaces(await response.json()).slice(0, resultLimit);
    } catch {
      throw new GeocoderError(
        502,
        "The place search returned an unreadable answer.",
      );
    }
  };

  const search = async (query) => {
    const key = normalizeQuery(query);
    if (key.length < minimumQueryLength) {
      throw new GeocoderError(
        400,
        `Enter at least ${minimumQueryLength} characters to search for a place.`,
      );
    }
    if (key.length > maximumQueryLength) {
      throw new GeocoderError(400, "The place search text is too long.");
    }

    const cached = memoryCache.get(key);
    if (cached) {
      remember(memoryCache, key, cached, memoryCacheEntries);
      return cached;
    }
    const stored = (await loadPersistent()).queries[key];
    if (Array.isArray(stored)) {
      remember(memoryCache, key, stored, memoryCacheEntries);
      return stored;
    }

    // The same search typed twice at once makes one call.
    if (inFlight.has(key)) {
      return inFlight.get(key);
    }
    const pending = enqueue(() => requestPlaces(key))
      .then(async (places) => {
        remember(memoryCache, key, places, memoryCacheEntries);
        const store = await loadPersistent();
        delete store.queries[key];
        store.queries[key] = places;
        // Objects keep insertion order, so the oldest searches are dropped first.
        for (const oldKey of Object.keys(store.queries).slice(
          0,
          -persistentCacheEntries,
        )) {
          delete store.queries[oldKey];
        }
        await savePersistent();
        return places;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    return pending;
  };

  const getRecentPlaces = async () => [...(await loadPersistent()).recent];

  const rememberPlace = async (place) => {
    const latitude = Number(place?.latitude);
    const longitude = Number(place?.longitude);
    const name = String(place?.name ?? "").trim();
    if (!name || !isValidCoordinatePair(latitude, longitude)) {
      throw new GeocoderError(400, "That place has no valid coordinates.");
    }
    const entry = {
      id: String(place?.id ?? `${latitude},${longitude}`),
      name,
      locality: String(place?.locality ?? ""),
      region: String(place?.region ?? ""),
      country: String(place?.country ?? ""),
      latitude,
      longitude,
    };
    const store = await loadPersistent();
    store.recent = [
      entry,
      ...store.recent.filter((recent) => recent.id !== entry.id),
    ].slice(0, recentPlaceEntries);
    await savePersistent();
    return entry;
  };

  return { search, getRecentPlaces, rememberPlace };
};

export {
  createGeocoder,
  defaultGeocoderUrl,
  GeocoderError,
  isValidCoordinatePair,
  mapPhotonPlaces,
  minimumQueryLength,
};
