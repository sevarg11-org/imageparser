import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

/**
 * Collects the local modules a module imports, following them transitively.
 * @param {string} entry - The module to start from (relative to the repository root).
 * @returns {Promise<Set<string>>} The module paths, including the entry.
 */
const collectLocalModules = async (entry) => {
  const modules = new Set();
  const pending = [entry];
  while (pending.length) {
    const modulePath = path.normalize(pending.pop());
    if (modules.has(modulePath)) {
      continue;
    }
    modules.add(modulePath);
    const source = await fs.readFile(modulePath, "utf8");
    for (const [, specifier] of source.matchAll(/from\s+"(\.\/[^"]+)"/g)) {
      pending.push(path.join(path.dirname(modulePath), specifier));
    }
  }
  return modules;
};

test("the production image copies every local module the web server imports", async () => {
  const dockerfile = await fs.readFile("Dockerfile", "utf8");
  const copied = new Set(
    dockerfile
      .split(/\r?\n/)
      .filter((line) => /^COPY\s/.test(line) && !line.includes("--from="))
      .flatMap((line) => line.trim().split(/\s+/).slice(1, -1))
      .map((file) => path.normalize(file)),
  );

  for (const modulePath of await collectLocalModules("server.js")) {
    assert.ok(
      copied.has(modulePath),
      `Dockerfile does not copy ${modulePath}, which the web server imports.`,
    );
  }
});
