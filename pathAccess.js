import fs from "node:fs/promises";
import path from "node:path";

/**
 * Maximum number of folder grants accepted from an identity provider claim.
 * Keeps the session cookie well under browser size limits.
 */
const maxFolderGrants = 50;

/**
 * Checks if a canonical path equals or is a descendant of a directory.
 * Uses a separator boundary so "/data/family-secret" is not inside "/data/family".
 * @param {string} candidatePath - The canonical path to check.
 * @param {string} directory - The canonical directory that must contain it.
 * @returns {boolean} True if the path is the directory or inside it.
 */
const isInsideDirectory = (candidatePath, directory) =>
  candidatePath === directory ||
  candidatePath.startsWith(
    directory.endsWith(path.sep) ? directory : directory + path.sep,
  );

/**
 * Checks if a canonical path is inside any of the allowed folders.
 * @param {string} realPath - The canonical path to check.
 * @param {string[]} allowedRoots - Canonical folders the user may access, including their children.
 * @returns {boolean} True if the path is within at least one allowed folder.
 */
const isPathAllowed = (realPath, allowedRoots) =>
  allowedRoots.some((allowedRoot) => isInsideDirectory(realPath, allowedRoot));

/**
 * Normalizes one folder grant from an identity provider claim.
 * Grants are relative to the shared root; traversal segments and empty values are rejected.
 * @param {unknown} value - The raw claim entry.
 * @returns {string|null} The grant as forward-slash separated segments, or null if invalid.
 */
const normalizeFolderGrant = (value) => {
  if (typeof value !== "string" || value.includes("\0")) {
    return null;
  }

  const trimmed = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    return null;
  }

  const segments = trimmed.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    return null;
  }

  return segments.join("/");
};

/**
 * Normalizes a folder claim into a de-duplicated, bounded list of grants.
 * @param {unknown} claimValue - The claim value: an array of folder names or a single folder name.
 * @returns {string[]} The valid folder grants.
 */
const normalizeFolderGrants = (claimValue) => {
  const entries = Array.isArray(claimValue)
    ? claimValue
    : claimValue === undefined || claimValue === null
      ? []
      : [claimValue];
  return [...new Set(entries.map(normalizeFolderGrant).filter(Boolean))].slice(
    0,
    maxFolderGrants,
  );
};

/**
 * Resolves folder grants to canonical directories inside the shared root.
 * Symlinks are resolved, so a grant pointing outside the root is dropped. Missing folders,
 * non-directories, and grants nested inside another grant are dropped as well.
 * @param {string} rootDirectory - The canonical shared root directory.
 * @param {string[]} folders - Folder grants relative to the root.
 * @returns {Promise<string[]>} Canonical allowed folders, shortest first.
 */
const resolveAllowedRoots = async (rootDirectory, folders) => {
  const resolvedRoots = [];
  for (const folder of folders) {
    const grant = normalizeFolderGrant(folder);
    if (!grant) {
      continue;
    }

    try {
      const realPath = await fs.realpath(
        path.join(rootDirectory, ...grant.split("/")),
      );
      if (
        isInsideDirectory(realPath, rootDirectory) &&
        (await fs.stat(realPath)).isDirectory()
      ) {
        resolvedRoots.push(realPath);
      }
    } catch {
      // A granted folder that does not exist (yet) simply grants nothing.
    }
  }

  const uniqueRoots = [...new Set(resolvedRoots)].sort(
    (left, right) => left.length - right.length,
  );
  return uniqueRoots.filter(
    (candidate, index) =>
      !uniqueRoots
        .slice(0, index)
        .some((other) => isInsideDirectory(candidate, other)),
  );
};

export {
  isInsideDirectory,
  isPathAllowed,
  maxFolderGrants,
  normalizeFolderGrant,
  normalizeFolderGrants,
  resolveAllowedRoots,
};
