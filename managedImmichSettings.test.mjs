import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadImmichSettings, saveImmichSettings } from "./core.js";
import {
  applyManagedImmichSettings,
  getManagedImmichFields,
  listManagedFields,
  readManagedImmichConfig,
  toClientImmichSettings,
} from "./managedImmichSettings.js";

const savedSettings = {
  serverUrl: "https://saved.example.test",
  userApiKey: "saved-user-key",
  adminApiKey: "saved-admin-key",
  albumName: "Family",
  tags: "scans",
  pauseImmichJobs: true,
  concurrentTasks: 2,
};
const unmanaged = { serverUrl: "", adminApiKey: "" };
const managed = {
  serverUrl: "https://immich.example.test",
  adminApiKey: "env-admin-key",
};
const claimUser = { userKey: "u", immichApiKey: "claim-user-key" };
const plainUser = { userKey: "u" };

/** A reversible stand-in for the server's AES-GCM codec, so stored values can be inspected. */
const testCodec = Object.freeze({
  encrypt: (value) => `enc:${Buffer.from(value).toString("base64")}`,
  decrypt: (value) =>
    Buffer.from(value.slice("enc:".length), "base64").toString("utf8"),
});

test("reads no managed settings from an empty environment", async () => {
  assert.deepEqual(await readManagedImmichConfig({}), unmanaged);
});

test("reads the Immich URL and admin key from the environment", async () => {
  assert.deepEqual(
    await readManagedImmichConfig({
      IMMICH_URL: " https://immich.example.test/ ",
      IMMICH_ADMIN_API_KEY: " env-admin-key ",
    }),
    managed,
  );
});

test("rejects an Immich URL that is not HTTP or HTTPS", async () => {
  for (const value of ["immich.example.test", "ftp://immich.example.test"]) {
    await assert.rejects(
      readManagedImmichConfig({ IMMICH_URL: value }),
      /IMMICH_URL must be an absolute http/,
      value,
    );
  }
});

test("prefers the admin key file over the admin key variable", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "imageparser-managed-"),
  );
  try {
    const keyFile = path.join(directory, "admin-key");
    await fs.writeFile(keyFile, "file-admin-key\n");
    assert.equal(
      (
        await readManagedImmichConfig({
          IMMICH_ADMIN_API_KEY: "env-admin-key",
          IMMICH_ADMIN_API_KEY_FILE: keyFile,
        })
      ).adminApiKey,
      "file-admin-key",
    );

    await assert.rejects(
      readManagedImmichConfig({
        IMMICH_ADMIN_API_KEY_FILE: path.join(directory, "missing"),
      }),
      /IMMICH_ADMIN_API_KEY_FILE .* could not be read: ENOENT/,
    );
    await fs.writeFile(keyFile, "  \n");
    await assert.rejects(
      readManagedImmichConfig({ IMMICH_ADMIN_API_KEY_FILE: keyFile }),
      /is empty/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("reports which fields are managed for a user", () => {
  assert.deepEqual(getManagedImmichFields(unmanaged, plainUser), {
    serverUrl: false,
    userApiKey: false,
    adminApiKey: false,
  });
  assert.deepEqual(getManagedImmichFields(managed, claimUser), {
    serverUrl: true,
    userApiKey: true,
    adminApiKey: true,
  });
  assert.deepEqual(
    listManagedFields(getManagedImmichFields(managed, plainUser)),
    ["serverUrl", "adminApiKey"],
  );
});

test("managed values take precedence over saved and submitted values", () => {
  assert.deepEqual(
    applyManagedImmichSettings(savedSettings, managed, claimUser),
    {
      ...savedSettings,
      serverUrl: "https://immich.example.test",
      userApiKey: "claim-user-key",
      adminApiKey: "env-admin-key",
    },
  );
  assert.deepEqual(
    applyManagedImmichSettings(savedSettings, unmanaged, plainUser),
    savedSettings,
    "without managed values the user's own settings are used",
  );
  assert.equal(
    applyManagedImmichSettings(savedSettings, unmanaged, claimUser).serverUrl,
    savedSettings.serverUrl,
  );
});

test("never sends managed keys to the browser", () => {
  const client = toClientImmichSettings(savedSettings, managed, claimUser);
  assert.equal(client.serverUrl, "https://immich.example.test");
  assert.equal(client.userApiKey, "");
  assert.equal(client.adminApiKey, "");
  assert.equal(
    toClientImmichSettings(
      { ...savedSettings, pauseImmichJobs: false },
      managed,
      claimUser,
    ).pauseImmichJobs,
    true,
  );
  assert.deepEqual(client.managed, {
    serverUrl: true,
    userApiKey: true,
    adminApiKey: true,
  });
  assert.doesNotMatch(
    JSON.stringify(
      toClientImmichSettings(
        applyManagedImmichSettings(savedSettings, managed, claimUser),
        managed,
        claimUser,
      ),
    ),
    /claim-user-key|env-admin-key/,
  );

  const unmanagedClient = toClientImmichSettings(
    savedSettings,
    unmanaged,
    plainUser,
  );
  assert.equal(unmanagedClient.userApiKey, "saved-user-key");
  assert.equal(unmanagedClient.adminApiKey, "saved-admin-key");
});

test("saving never writes managed values, not even encrypted", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "imageparser-managed-"),
  );
  try {
    const effective = applyManagedImmichSettings(
      { ...savedSettings, userApiKey: "", adminApiKey: "" },
      managed,
      claimUser,
    );
    const result = await saveImmichSettings(directory, testCodec, effective, {
      managedFields: listManagedFields(
        getManagedImmichFields(managed, claimUser),
      ),
    });
    assert.equal(result.userApiKey, "claim-user-key");

    const stored = await fs.readFile(
      path.join(directory, "immich-settings.json"),
      "utf8",
    );
    assert.doesNotMatch(stored, /claim-user-key|env-admin-key|immich\.example/);
    for (const value of ["claim-user-key", "env-admin-key"]) {
      assert.ok(!stored.includes(testCodec.encrypt(value)));
    }
    const loaded = await loadImmichSettings(directory, testCodec);
    assert.equal(loaded.serverUrl, "");
    assert.equal(loaded.userApiKey, "");
    assert.equal(loaded.adminApiKey, "");
    assert.equal(loaded.albumName, "Family");

    await saveImmichSettings(directory, testCodec, savedSettings);
    assert.equal(
      (await loadImmichSettings(directory, testCodec)).userApiKey,
      "saved-user-key",
      "unmanaged keys are still saved",
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
