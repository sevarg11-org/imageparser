import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import {
  buildSidecarDocument,
  formatXmpCoordinate,
  parseXmpCoordinate,
  readLocationFromXmp,
  shutdownCore,
  writeSidecarFile,
} from "./core.js";

after(() => shutdownCore());

test("coordinates format correctly in all four hemispheres", () => {
  assert.equal(formatXmpCoordinate(41.8781, "latitude"), "41,52.6860N");
  assert.equal(formatXmpCoordinate(-33.8688, "latitude"), "33,52.1280S");
  assert.equal(formatXmpCoordinate(-87.6298, "longitude"), "87,37.7880W");
  assert.equal(formatXmpCoordinate(151.2093, "longitude"), "151,12.5580E");
  assert.equal(formatXmpCoordinate(0, "latitude"), "0,0.0000N");
});

test("minutes that round up to 60 carry into the degrees", () => {
  assert.equal(formatXmpCoordinate(10.99999999, "latitude"), "11,0.0000N");
});

test("out-of-range and non-numeric coordinates are rejected", () => {
  assert.throws(() => formatXmpCoordinate(90.5, "latitude"), /latitude/);
  assert.throws(() => formatXmpCoordinate(-181, "longitude"), /longitude/);
  assert.throws(() => formatXmpCoordinate(Number.NaN, "latitude"), /latitude/);
  assert.throws(() => formatXmpCoordinate("abc", "longitude"), /longitude/);
  assert.throws(
    () =>
      buildSidecarDocument({
        dateValue: "2000-01-01",
        description: "",
        tags: [],
        location: { latitude: 100, longitude: 0, name: "x" },
      }),
    /latitude/,
  );
});

test("formatted coordinates parse back to the same position", () => {
  for (const [value, axis] of [
    [41.8781, "latitude"],
    [-33.8688, "latitude"],
    [-87.6298, "longitude"],
    [151.2093, "longitude"],
  ]) {
    const parsed = parseXmpCoordinate(formatXmpCoordinate(value, axis));
    assert.ok(Math.abs(parsed - value) < 0.00001, `${value} -> ${parsed}`);
  }
  assert.equal(parseXmpCoordinate("garbage"), null);
  assert.equal(parseXmpCoordinate("12,61.0000N"), null);
});

test("the sidecar carries the GPS fields, version and the place name", () => {
  const xml = buildSidecarDocument({
    dateValue: "1990-05-06",
    description: "Graduation",
    tags: ["School"],
    location: { latitude: 41.8781, longitude: -87.6298, name: "Lincoln & Co" },
  });
  assert.match(xml, /<exif:GPSVersionID>2\.3\.0\.0<\/exif:GPSVersionID>/);
  assert.match(xml, /<exif:GPSLatitude>41,52\.6860N<\/exif:GPSLatitude>/);
  assert.match(xml, /<exif:GPSLongitude>87,37\.7880W<\/exif:GPSLongitude>/);
  assert.match(xml, /Lincoln &amp; Co/);
  assert.deepEqual(readLocationFromXmp(xml), {
    latitude: 41.8781,
    longitude: -87.6298,
    name: "Lincoln & Co",
  });
});

test("a sidecar without a location reads back as none", () => {
  const xml = buildSidecarDocument({
    dateValue: "1990-05-06",
    description: "",
    tags: [],
  });
  assert.equal(readLocationFromXmp(xml), null);
  assert.doesNotMatch(xml, /GPS/);
});

test("writing keeps the place unless told otherwise and never loses other metadata", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sidecar-loc-"));
  const imagePath = path.join(directory, "photo_a.jpg");
  await fs.writeFile(imagePath, "");
  const read = async () =>
    String(await fs.readFile(`${imagePath}.xmp`, "utf8").catch(() => ""));
  try {
    const place = { latitude: 41.8781, longitude: -87.6298, name: "Chicago" };
    await writeSidecarFile(imagePath, "1990-05-06", "Desc", ["A", "B"], place);
    let xml = await read();
    assert.deepEqual(readLocationFromXmp(xml), place);

    // Omitting the location (as tag or date edits do) keeps the saved place.
    await writeSidecarFile(imagePath, "1991-01-02", "Desc", ["A", "B", "C"]);
    xml = await read();
    assert.deepEqual(readLocationFromXmp(xml), place);
    assert.match(xml, /1991-01-02/);
    assert.match(xml, /<rdf:li>C<\/rdf:li>/);

    // null clears it, leaving date, description and tags intact.
    await writeSidecarFile(imagePath, "1991-01-02", "Desc", ["A"], null);
    xml = await read();
    assert.equal(readLocationFromXmp(xml), null);
    assert.match(xml, /Desc/);
    assert.match(xml, /<rdf:li>A<\/rdf:li>/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
