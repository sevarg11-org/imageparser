import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGeocoder, mapPhotonPlaces } from "./geocoder.js";

const photonAnswer = {
  features: [
    {
      geometry: { coordinates: [-87.6298, 41.8781] },
      properties: {
        osm_type: "N",
        osm_id: 1,
        name: "Lincoln High School",
        city: "Chicago",
        state: "Illinois",
        country: "United States",
      },
    },
    {
      geometry: { coordinates: [999, 41] },
      properties: { name: "Out of range" },
    },
    { geometry: { coordinates: [1, 2] }, properties: {} },
  ],
};

/** A fetch mock that records its calls and answers with the Photon sample. */
const createFetchMock = (status = 200) => {
  const calls = [];
  const fetchMock = async (url, options) => {
    calls.push({ url: String(url), headers: options.headers });
    return { ok: status === 200, status, json: async () => photonAnswer };
  };
  return { calls, fetchMock };
};

const instantClock = () => {
  let time = 0;
  const sleeps = [];
  return {
    now: () => time,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      time += milliseconds;
    },
    sleeps,
  };
};

test("maps Photon features to places and drops invalid ones", () => {
  assert.deepEqual(mapPhotonPlaces(photonAnswer), [
    {
      id: "N1",
      name: "Lincoln High School",
      locality: "Chicago",
      region: "Illinois",
      country: "United States",
      latitude: 41.8781,
      longitude: -87.6298,
    },
  ]);
});

test("rejects short queries without calling the service", async () => {
  const { calls, fetchMock } = createFetchMock();
  const geocoder = createGeocoder({ fetchImpl: fetchMock });
  await assert.rejects(geocoder.search("ab"), /at least 3 characters/);
  assert.equal(calls.length, 0);
});

test("one search makes one call with a user agent and a result limit", async () => {
  const { calls, fetchMock } = createFetchMock();
  const geocoder = createGeocoder({
    baseUrl: "https://geo.example/",
    fetchImpl: fetchMock,
  });
  const places = await geocoder.search("  Lincoln   High ");
  assert.equal(places.length, 1);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, "https://geo.example/api");
  assert.equal(url.searchParams.get("q"), "lincoln high");
  assert.equal(url.searchParams.get("limit"), "8");
  assert.match(calls[0].headers["User-Agent"], /ImageParser/);
});

test("repeated searches are served from the cache", async () => {
  const { calls, fetchMock } = createFetchMock();
  const geocoder = createGeocoder({ fetchImpl: fetchMock });
  await geocoder.search("Lincoln High");
  await geocoder.search("lincoln  high");
  assert.equal(calls.length, 1);
});

test("the persistent cache survives a restart and keeps recent places", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "geocoder-"));
  const cacheFile = path.join(directory, "geocode-cache.json");
  try {
    const first = createFetchMock();
    const geocoder = createGeocoder({ cacheFile, fetchImpl: first.fetchMock });
    const [place] = await geocoder.search("Lincoln High");
    await geocoder.rememberPlace(place);

    const second = createFetchMock();
    const restarted = createGeocoder({
      cacheFile,
      fetchImpl: second.fetchMock,
    });
    assert.equal((await restarted.search("Lincoln High")).length, 1);
    assert.equal(second.calls.length, 0);
    assert.deepEqual(
      (await restarted.getRecentPlaces()).map((recent) => recent.name),
      ["Lincoln High School"],
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("outgoing calls are spaced one second apart", async () => {
  const { calls, fetchMock } = createFetchMock();
  const clock = instantClock();
  const geocoder = createGeocoder({ fetchImpl: fetchMock, ...clock });
  await Promise.all([
    geocoder.search("first place"),
    geocoder.search("second place"),
    geocoder.search("third place"),
  ]);
  assert.equal(calls.length, 3);
  assert.deepEqual(clock.sleeps, [1000, 1000]);
});

test("a long queue is refused with an explicit throttling error", async () => {
  const { fetchMock } = createFetchMock();
  const clock = instantClock();
  const geocoder = createGeocoder({ fetchImpl: fetchMock, ...clock });
  const searches = Array.from({ length: 5 }, (_, index) =>
    geocoder.search(`place number ${index}`),
  );
  await assert.rejects(
    geocoder.search("one too many"),
    (error) => error.statusCode === 429 && /Too many/.test(error.message),
  );
  await Promise.all(searches);
});

test("a throttled or failing service gives an explicit error", async () => {
  const throttled = createGeocoder({
    fetchImpl: createFetchMock(429).fetchMock,
  });
  await assert.rejects(
    throttled.search("Lincoln High"),
    (error) => error.statusCode === 429 && /limiting/.test(error.message),
  );
  const unreachable = createGeocoder({
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  await assert.rejects(
    unreachable.search("Lincoln High"),
    /could not be reached/,
  );
});

test("remembering a place rejects invalid coordinates", async () => {
  const geocoder = createGeocoder();
  await assert.rejects(
    geocoder.rememberPlace({ name: "Nowhere", latitude: 91, longitude: 0 }),
    /valid coordinates/,
  );
});
