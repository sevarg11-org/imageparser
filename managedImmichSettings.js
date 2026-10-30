import fs from "node:fs/promises";

/**
 * Reads the server-wide Immich settings an administrator sets in the environment (web server only).
 * IMMICH_ADMIN_API_KEY_FILE, for Docker or TrueNAS secrets, takes precedence over IMMICH_ADMIN_API_KEY.
 * @param {Object} env - The environment, usually process.env.
 * @param {{readFile?: Function}} [options] - Overrides the file reader, for tests.
 * @returns {Promise<{serverUrl: string, adminApiKey: string}>} The managed values; empty strings when unset.
 * @throws {Error} If IMMICH_URL is not an HTTP(S) URL, or the admin key file cannot be read or is empty.
 */
const readManagedImmichConfig = async (
  env,
  { readFile = fs.readFile } = {},
) => {
  const serverUrl = String(env.IMMICH_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (
    serverUrl &&
    !(
      URL.canParse(serverUrl) &&
      ["http:", "https:"].includes(new URL(serverUrl).protocol)
    )
  ) {
    throw new Error(
      "IMMICH_URL must be an absolute http:// or https:// URL, for example https://photos.example.com.",
    );
  }

  let adminApiKey = String(env.IMMICH_ADMIN_API_KEY ?? "").trim();
  const adminApiKeyFile = String(env.IMMICH_ADMIN_API_KEY_FILE ?? "").trim();
  if (adminApiKeyFile) {
    try {
      adminApiKey = String(await readFile(adminApiKeyFile, "utf8")).trim();
    } catch (error) {
      throw new Error(
        `IMMICH_ADMIN_API_KEY_FILE (${adminApiKeyFile}) could not be read: ${error?.code ?? error?.message}.`,
      );
    }
    if (!adminApiKey) {
      throw new Error(
        `IMMICH_ADMIN_API_KEY_FILE (${adminApiKeyFile}) is empty.`,
      );
    }
  }

  return Object.freeze({ serverUrl, adminApiKey });
};

/**
 * Reports which Immich settings the server provides for a user instead of the user's saved values.
 * @param {{serverUrl: string, adminApiKey: string}} config - The managed environment settings.
 * @param {{immichApiKey?: string}} user - The request's user context; the key comes from the sign-in session.
 * @returns {{serverUrl: boolean, userApiKey: boolean, adminApiKey: boolean}} The managed fields.
 */
const getManagedImmichFields = (config, user) => ({
  serverUrl: Boolean(config.serverUrl),
  userApiKey: Boolean(user?.immichApiKey),
  adminApiKey: Boolean(config.adminApiKey),
});

/**
 * Lists the managed field names, for saving settings without them.
 * @param {{serverUrl: boolean, userApiKey: boolean, adminApiKey: boolean}} managed - The managed fields.
 * @returns {string[]} The names of the managed fields.
 */
const listManagedFields = (managed) =>
  Object.keys(managed).filter((field) => managed[field]);

/**
 * Replaces a user's Immich settings with the managed values, in this precedence order:
 * IMMICH_URL over the saved URL, the sign-in key over the saved key, IMMICH_ADMIN_API_KEY over the saved admin key.
 * Managed values sent by the browser are never trusted.
 * @param {Object} settings - The user's settings, from their form or settings file.
 * @param {{serverUrl: string, adminApiKey: string}} config - The managed environment settings.
 * @param {{immichApiKey?: string}} user - The request's user context.
 * @returns {Object} The settings to validate, save, or upload with.
 */
const applyManagedImmichSettings = (settings, config, user) => {
  const managed = getManagedImmichFields(config, user);
  return {
    ...settings,
    ...(managed.serverUrl ? { serverUrl: config.serverUrl } : {}),
    ...(managed.userApiKey ? { userApiKey: user.immichApiKey } : {}),
    ...(managed.adminApiKey ? { adminApiKey: config.adminApiKey } : {}),
  };
};

/**
 * Prepares Immich settings for the browser: managed keys are blanked, the managed URL (not a secret) is shown,
 * and `managed` flags tell the settings panel which fields to hide or lock.
 * @param {Object} settings - The user's settings.
 * @param {{serverUrl: string, adminApiKey: string}} config - The managed environment settings.
 * @param {{immichApiKey?: string}} user - The request's user context.
 * @returns {Object} The settings without managed secrets, plus the managed flags.
 */
const toClientImmichSettings = (settings, config, user) => {
  const managed = getManagedImmichFields(config, user);
  return {
    ...settings,
    serverUrl: managed.serverUrl ? config.serverUrl : settings.serverUrl,
    userApiKey: managed.userApiKey ? "" : settings.userApiKey,
    adminApiKey: managed.adminApiKey ? "" : settings.adminApiKey,
    // Uploads pause Immich jobs whenever an admin key is present, so a managed key always pauses them.
    pauseImmichJobs: managed.adminApiKey || settings.pauseImmichJobs,
    managed,
  };
};

export {
  applyManagedImmichSettings,
  getManagedImmichFields,
  listManagedFields,
  readManagedImmichConfig,
  toClientImmichSettings,
};
