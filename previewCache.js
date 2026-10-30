import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Bumped whenever the rendered preview format changes, so stale cache entries are never served.
 * @type {number}
 */
export const previewFormatVersion = 1;

/**
 * The default upper bound for the preview cache on disk.
 * @type {number}
 */
export const defaultPreviewCacheMaxBytes = 1024 * 1024 * 1024;

/**
 * Builds a short version string that changes whenever a file's contents may have changed.
 * The change time is included because pixel rotation restores the original modification time.
 * @param {{size: number, mtimeMs: number, ctimeMs: number}} stats - The file's stats.
 * @returns {string} The version string.
 */
export const buildImageVersion = (stats) =>
  [stats.size, Math.floor(stats.mtimeMs), Math.floor(stats.ctimeMs)]
    .map((value) => value.toString(36))
    .join("-");

/**
 * Builds the cache key for a preview of one version of an image.
 * @param {string} filePath - The resolved path of the source image.
 * @param {{size: number, mtimeMs: number, ctimeMs: number}} stats - The source image's stats.
 * @param {number} rotation - The normalized rotation applied to the preview.
 * @returns {string} A hex SHA-256 key that is safe to use as a file name.
 */
export const buildPreviewCacheKey = (filePath, stats, rotation) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        previewFormatVersion,
        path.resolve(filePath),
        buildImageVersion(stats),
        Number(rotation) || 0,
      ]),
    )
    .digest("hex");

/**
 * Builds the cache key for a grid thumbnail of one version of an image.
 * Thumbnails share the preview cache, so the key is tagged to never match a preview key.
 * @param {string} filePath - The resolved path of the source image.
 * @param {{size: number, mtimeMs: number, ctimeMs: number}} stats - The source image's stats.
 * @param {number} rotation - The normalized rotation applied to the thumbnail.
 * @param {number} size - The thumbnail's long-edge size in pixels.
 * @returns {string} A hex SHA-256 key that is safe to use as a file name.
 */
export const buildThumbnailCacheKey = (filePath, stats, rotation, size) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        previewFormatVersion,
        "thumbnail",
        path.resolve(filePath),
        buildImageVersion(stats),
        Number(rotation) || 0,
        Number(size) || 0,
      ]),
    )
    .digest("hex");

/**
 * Creates a size-capped preview cache stored as files in one directory.
 * Entries are evicted least recently used first; a cache hit refreshes the entry's modification time.
 * Cache failures never break previews: reads that fail are misses and writes that fail are skipped.
 * @param {{directory: string, maxBytes?: number}} options - The cache directory and its size cap.
 * @returns {{get: (key: string) => Promise<Buffer|null>, put: (key: string, buffer: Buffer) => Promise<void>, prune: () => Promise<void>, directory: string}}
 */
export const createPreviewCache = ({
  directory,
  maxBytes = defaultPreviewCacheMaxBytes,
}) => {
  const cacheDirectory = path.resolve(directory);
  const createdAt = Date.now();
  let knownBytes = null;
  let pruning = null;

  const entryPath = (key) => {
    if (!/^[0-9a-f]{64}$/.test(key)) {
      throw new Error("Invalid preview cache key.");
    }
    return path.join(cacheDirectory, `${key}.webp`);
  };

  const readNames = async () => {
    try {
      return await fs.readdir(cacheDirectory);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  };

  /**
   * Removes temporary files left by writes that were interrupted before this cache was created.
   * Newer temporary files may belong to writes still in progress, so they are kept.
   * @param {string[]} names - The file names in the cache directory.
   */
  const removeOrphanedTemporaryFiles = (names) =>
    Promise.all(
      names
        .filter((name) => /^\.[0-9a-f]{64}\.[0-9a-f-]{36}\.tmp$/.test(name))
        .map(async (name) => {
          const filePath = path.join(cacheDirectory, name);
          try {
            const stats = await fs.stat(filePath);
            if (stats.mtimeMs < createdAt) {
              await fs.rm(filePath, { force: true });
            }
          } catch {
            // A missing or locked file is left for the next prune.
          }
        }),
    );

  const listEntries = async (names) => {
    const entries = await Promise.all(
      names
        .filter((name) => /^[0-9a-f]{64}\.webp$/.test(name))
        .map(async (name) => {
          const filePath = path.join(cacheDirectory, name);
          try {
            const stats = await fs.stat(filePath);
            return { filePath, size: stats.size, usedAt: stats.mtimeMs };
          } catch {
            return null;
          }
        }),
    );
    return entries.filter(Boolean);
  };

  /**
   * Removes orphaned temporary files and the least recently used entries until the cache is at
   * most 80% of its cap.
   */
  const prune = () => {
    pruning ??= (async () => {
      try {
        const names = await readNames();
        await removeOrphanedTemporaryFiles(names);
        const entries = await listEntries(names);
        let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
        if (totalBytes > maxBytes) {
          const targetBytes = maxBytes * 0.8;
          entries.sort((left, right) => left.usedAt - right.usedAt);
          for (const entry of entries) {
            if (totalBytes <= targetBytes) {
              break;
            }
            await fs.rm(entry.filePath, { force: true }).catch(() => {});
            totalBytes -= entry.size;
          }
        }
        knownBytes = totalBytes;
      } finally {
        pruning = null;
      }
    })();
    return pruning;
  };

  const get = async (key) => {
    const filePath = entryPath(key);
    try {
      const buffer = await fs.readFile(filePath);
      const now = new Date();
      await fs.utimes(filePath, now, now).catch(() => {});
      return buffer;
    } catch {
      return null;
    }
  };

  const put = async (key, buffer) => {
    const filePath = entryPath(key);
    const temporaryPath = path.join(
      cacheDirectory,
      `.${key}.${randomUUID()}.tmp`,
    );
    try {
      await fs.mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
      await fs.writeFile(temporaryPath, buffer, { mode: 0o600 });
      await fs.rename(temporaryPath, filePath);
    } catch {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      return;
    }

    if (knownBytes === null) {
      await prune().catch(() => {});
      return;
    }
    knownBytes += buffer.length;
    if (knownBytes > maxBytes) {
      await prune().catch(() => {});
    }
  };

  return { get, put, prune, directory: cacheDirectory };
};
