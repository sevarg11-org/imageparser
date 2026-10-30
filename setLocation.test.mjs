import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  countPairsWithLocation,
  setLocationForPairs,
  shutdownCore,
} from "./core.js";

after(() => shutdownCore());

const place = { latitude: 41.8781, longitude: -87.6298, name: "Chicago" };

test("the place is applied to every pair and date, description and tags are kept", async () => {
  const saved = [];
  const result = await setLocationForPairs(
    [
      { frontPath: "/p/a_a.jpg", backPath: "/p/a_b.jpg" },
      { frontPath: "/p/b_a.jpg", backPath: null },
    ],
    place,
    {
      readMetadata: async (filePath) => ({
        date: "1990-01-02",
        description: `about ${filePath}`,
        tags: ["Family"],
      }),
      save: async (metadata) => {
        saved.push(metadata);
        return { ok: true, results: [] };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.updatedPairs, 2);
  for (const metadata of saved) {
    assert.deepEqual(metadata.location, place);
    assert.equal(metadata.date, "1990-01-02");
    assert.deepEqual(metadata.tags, ["Family"]);
  }
  assert.equal(saved[0].description, "about /p/a_a.jpg");
});

test("a failing pair is reported and the others still get the place", async () => {
  const result = await setLocationForPairs(
    [
      { frontPath: "/p/bad_a.jpg", backPath: null },
      { frontPath: "/p/good_a.jpg", backPath: null },
    ],
    place,
    {
      readMetadata: async () => ({ date: "", description: "", tags: [] }),
      save: async ({ frontPath }) => {
        if (frontPath.includes("bad")) {
          throw new Error("disk full");
        }
        return { ok: true, results: [] };
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.updatedPairs, 1);
  assert.deepEqual(result.failedFrontPaths, ["/p/bad_a.jpg"]);
  assert.deepEqual(result.errors, ["bad_a.jpg: disk full"]);
});

test("a missing or out-of-range place is rejected before anything is written", async () => {
  await assert.rejects(setLocationForPairs([], null), /Choose a place/);
  await assert.rejects(
    setLocationForPairs([], { latitude: 95, longitude: 0, name: "x" }),
    /latitude/,
  );
});

test("pairs that already have a location are counted for the confirmation", async () => {
  const count = await countPairsWithLocation(
    [
      { frontPath: "/p/a.jpg", backPath: null },
      { frontPath: "/p/b.jpg", backPath: null },
      { frontPath: "/p/c.jpg", backPath: null },
    ],
    {
      readMetadata: async (filePath) => {
        if (filePath.includes("c")) {
          throw new Error("unreadable");
        }
        return { location: filePath.includes("a") ? place : null };
      },
    },
  );
  assert.equal(count, 1);
});
