import assert from "node:assert/strict";
import test, { after } from "node:test";
import { addTagsToPairs, mergeTags, shutdownCore } from "./core.js";

after(() => shutdownCore());

test("merging adds new tags, never removes, and skips duplicates ignoring case", () => {
  assert.deepEqual(
    mergeTags(["Family", "Zoo"], ["zoo", "Family/Parents", " "]),
    ["Family", "Zoo", "Family/Parents"],
  );
});

test("every pair keeps its date and description and gains the union of tags", async () => {
  const saved = [];
  const result = await addTagsToPairs(
    [
      { frontPath: "/p/a_a.jpg", backPath: "/p/a_b.jpg" },
      { frontPath: "/p/b_a.jpg", backPath: null },
    ],
    ["Beach", "family"],
    {
      readMetadata: async (filePath) => ({
        date: filePath.includes("a_a") ? "1990-01-02" : "1985-05-06",
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
  assert.deepEqual(saved[0].tags, ["Family", "Beach"]);
  assert.equal(saved[0].date, "1990-01-02");
  assert.equal(saved[1].description, "about /p/b_a.jpg");
  assert.equal(saved[0].frontRotation, undefined);
});

test("a failing pair is reported and the rest are still tagged", async () => {
  const result = await addTagsToPairs(
    [
      { frontPath: "/p/bad_a.jpg", backPath: null },
      { frontPath: "/p/good_a.jpg", backPath: null },
      { frontPath: "/p/worse_a.jpg", backPath: null },
    ],
    ["Beach"],
    {
      readMetadata: async () => ({ date: "", description: "", tags: [] }),
      save: async ({ frontPath }) => {
        if (frontPath.includes("bad")) {
          throw new Error("disk full");
        }
        if (frontPath.includes("worse")) {
          return { ok: false, results: [{ ok: false, error: "locked" }] };
        }
        return { ok: true, results: [] };
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.updatedPairs, 1);
  assert.deepEqual(result.failedFrontPaths, [
    "/p/bad_a.jpg",
    "/p/worse_a.jpg",
  ]);
  assert.deepEqual(result.errors, [
    "bad_a.jpg: disk full",
    "worse_a.jpg: locked",
  ]);
});

test("adding no tags is rejected before anything is written", async () => {
  await assert.rejects(addTagsToPairs([], [" "]), /at least one tag/);
});
