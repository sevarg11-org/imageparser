import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import {
  createAllowedRootsCache,
  isInsideDirectory,
  isPathAllowed,
  maxFolderGrants,
  normalizeFolderGrant,
  normalizeFolderGrants,
  resolveAllowedRoots,
} from "./pathAccess.js";

let workspace;
let root;

before(async () => {
  workspace = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "imageparser-path-access-")),
  );
  root = path.join(workspace, "data");
  for (const folder of [
    "family/2020",
    "family-secret",
    "scans/2023",
    "scans/2024",
  ]) {
    await fs.mkdir(path.join(root, folder), { recursive: true });
  }
  await fs.mkdir(path.join(workspace, "outside"));
  await fs.writeFile(path.join(root, "notes.txt"), "not a folder");
  // Junctions work on Windows without elevation; the type is ignored elsewhere.
  await fs.symlink(
    path.join(workspace, "outside"),
    path.join(root, "escape"),
    "junction",
  );
});

after(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

test("matches a folder and its descendants on a separator boundary", () => {
  const family = path.join("/data", "family");
  assert.equal(isInsideDirectory(family, family), true);
  assert.equal(isInsideDirectory(path.join(family, "2020"), family), true);
  assert.equal(
    isInsideDirectory(path.join("/data", "family-secret"), family),
    false,
  );
  assert.equal(isInsideDirectory(path.join("/data"), family), false);
});

test("allows a path inside any allowed folder", () => {
  const allowed = [path.join("/data", "family"), path.join("/data", "scans")];
  assert.equal(
    isPathAllowed(path.join("/data", "scans", "a.jpg"), allowed),
    true,
  );
  assert.equal(
    isPathAllowed(path.join("/data", "other", "a.jpg"), allowed),
    false,
  );
  assert.equal(isPathAllowed(path.join("/data", "family"), []), false);
});

test("rejects traversal, empty, and non-string folder grants", () => {
  for (const value of [
    "../etc",
    "family/../../etc",
    "./family",
    "family//2020",
    "",
    "   ",
    "/",
    "fam\0ily",
    42,
    null,
    { path: "family" },
  ]) {
    assert.equal(normalizeFolderGrant(value), null, JSON.stringify(value));
  }
});

test("normalizes separators and surrounding slashes in folder grants", () => {
  assert.equal(normalizeFolderGrant(" /scans/2023/ "), "scans/2023");
  assert.equal(normalizeFolderGrant("scans\\2023"), "scans/2023");
});

test("normalizes a folder claim into a bounded, unique list", () => {
  assert.deepEqual(normalizeFolderGrants("family"), ["family"]);
  assert.deepEqual(normalizeFolderGrants(undefined), []);
  assert.deepEqual(normalizeFolderGrants(["family", "/family/", "..", 7]), [
    "family",
  ]);
  const many = Array.from({ length: maxFolderGrants + 10 }, (_, i) => `f${i}`);
  assert.equal(normalizeFolderGrants(many).length, maxFolderGrants);
});

test("resolves grants to existing canonical folders inside the root", async () => {
  assert.deepEqual(
    await resolveAllowedRoots(root, ["scans/2023", "family", "missing"]),
    [path.join(root, "family"), path.join(root, "scans", "2023")],
  );
});

test("drops grants nested inside another grant", async () => {
  assert.deepEqual(
    await resolveAllowedRoots(root, ["scans/2024", "scans", "scans/2023"]),
    [path.join(root, "scans")],
  );
});

test("drops grants that escape the root through a symlink", async () => {
  assert.deepEqual(await resolveAllowedRoots(root, ["escape", "family"]), [
    path.join(root, "family"),
  ]);
});

test("drops grants that are files or traversal attempts", async () => {
  assert.deepEqual(
    await resolveAllowedRoots(root, ["notes.txt", "../outside"]),
    [],
  );
});

test("caches resolved grants until they expire", async () => {
  let clock = 0;
  const resolve = createAllowedRootsCache({ ttlMs: 1000, now: () => clock });
  const first = resolve(root, ["family"]);
  assert.equal(resolve(root, ["family"]), first, "shares one resolution");
  assert.deepEqual(await first, [path.join(root, "family")]);
  assert.notEqual(resolve(root, ["scans"]), first, "keys on the grants");

  clock = 1001;
  assert.notEqual(resolve(root, ["family"]), first, "re-resolves after expiry");
});

test("bounds the number of cached grant sets", async () => {
  const resolve = createAllowedRootsCache({ maxEntries: 2 });
  const family = resolve(root, ["family"]);
  resolve(root, ["scans"]);
  resolve(root, ["scans/2023"]);
  assert.notEqual(
    resolve(root, ["family"]),
    family,
    "the oldest entry was evicted",
  );
});

test("a cached grant replaced by an escaping symlink no longer matches", async () => {
  const swapRoot = path.join(workspace, "swap");
  const granted = path.join(swapRoot, "granted");
  await fs.mkdir(granted, { recursive: true });
  const resolve = createAllowedRootsCache();
  const roots = await resolve(swapRoot, ["granted"]);
  assert.deepEqual(roots, [granted]);

  await fs.rm(granted, { recursive: true });
  await fs.symlink(path.join(workspace, "outside"), granted, "junction");
  // The cache still holds the old canonical folder, but the requested path resolves outside it.
  const requested = await fs.realpath(granted);
  assert.equal(
    isPathAllowed(requested, await resolve(swapRoot, ["granted"])),
    false,
  );
});
