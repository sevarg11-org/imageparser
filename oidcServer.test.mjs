import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientId = "imageparser-test";
const clientSecret = "test-client-secret";

const base64url = (value) =>
  Buffer.from(
    typeof value === "string" ? value : JSON.stringify(value),
  ).toString("base64url");

/**
 * Starts a minimal OpenID Connect provider that checks PKCE and client credentials,
 * and signs ID tokens with an RS256 key published at its JWKS endpoint.
 */
const startMockProvider = async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid: "k1",
    alg: "RS256",
    use: "sig",
  };
  const pendingCodes = new Map();
  const accessTokens = new Map();
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const issuer = `http://127.0.0.1:${server.address().port}`;

  // A key the JWKS does not publish, used to forge ID token signatures.
  const { privateKey: forgedKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });

  const signIdToken = (claims, { forged = false } = {}) => {
    const input = `${base64url({ alg: "RS256", kid: "k1", typ: "JWT" })}.${base64url(claims)}`;
    return `${input}.${sign("sha256", Buffer.from(input), forged ? forgedKey : privateKey).toString("base64url")}`;
  };

  const sendJson = (response, statusCode, payload) => {
    response.writeHead(statusCode, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
  };

  server.on("request", async (request, response) => {
    const url = new URL(request.url, issuer);
    if (url.pathname === "/.well-known/openid-configuration") {
      sendJson(response, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        end_session_endpoint: `${issuer}/end-session`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: [
          "client_secret_basic",
          "client_secret_post",
        ],
      });
      return;
    }
    if (url.pathname === "/jwks") {
      sendJson(response, 200, { keys: [jwk] });
      return;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      // Authentik accepts client_secret_basic and client_secret_post; so does the mock.
      const isClientAuthenticated =
        request.headers.authorization ===
          `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}` ||
        (form.get("client_id") === clientId &&
          form.get("client_secret") === clientSecret);
      const pending = pendingCodes.get(form.get("code"));
      pendingCodes.delete(form.get("code"));
      const challenge = createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url");
      if (
        !isClientAuthenticated ||
        !pending ||
        pending.challenge !== challenge ||
        form.get("redirect_uri") !== pending.redirectUri
      ) {
        sendJson(response, 400, { error: "invalid_grant" });
        return;
      }
      const accessToken = randomBytes(16).toString("hex");
      accessTokens.set(accessToken, pending.claims);
      const now = Math.floor(Date.now() / 1000);
      sendJson(response, 200, {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 300,
        id_token: signIdToken(
          {
            iss: issuer,
            aud: clientId,
            sub: pending.claims.sub,
            nonce: pending.nonce,
            iat: now,
            exp: now + 300,
          },
          { forged: pending.forgeSignature },
        ),
      });
      return;
    }
    if (url.pathname === "/userinfo") {
      const claims = accessTokens.get(
        String(request.headers.authorization ?? "").replace(/^Bearer /, ""),
      );
      if (!claims) {
        sendJson(response, 401, { error: "invalid_token" });
        return;
      }
      sendJson(response, 200, claims);
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  });

  return {
    issuer,
    server,
    /** Records an authorization the way the provider would after the user signs in. */
    authorize: (authorizationUrl, claims, { forgeSignature = false } = {}) => {
      const code = randomBytes(16).toString("hex");
      pendingCodes.set(code, {
        claims,
        forgeSignature,
        challenge: authorizationUrl.searchParams.get("code_challenge"),
        nonce: authorizationUrl.searchParams.get("nonce"),
        redirectUri: authorizationUrl.searchParams.get("redirect_uri"),
      });
      return code;
    },
  };
};

const getFreePort = async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
};

let workspace;
let root;
let configDirectory;
let provider;
let serverOutput = () => "";
let appUrl;

/** Collects name=value pairs from a response's Set-Cookie headers. */
const readSetCookies = (response) =>
  Object.fromEntries(
    response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0].split("="))
      .map(([name, ...value]) => [name, value.join("=")]),
  );

const request = (pathname, { cookie, ...init } = {}) =>
  fetch(new URL(pathname, appUrl), {
    redirect: "manual",
    ...init,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...init.headers },
  });

/** Runs the browser sign-in flow up to the callback and returns the callback response. */
const attemptSignIn = async (claims, authorizeOptions) => {
  const login = await request("auth/login");
  assert.equal(login.status, 302);
  const authorizationUrl = new URL(login.headers.get("location"));
  assert.equal(authorizationUrl.origin, provider.issuer);
  assert.equal(
    authorizationUrl.searchParams.get("code_challenge_method"),
    "S256",
  );
  assert.ok(authorizationUrl.searchParams.get("nonce"));
  const loginCookie = Object.entries(readSetCookies(login))
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");

  const code = provider.authorize(authorizationUrl, claims, authorizeOptions);
  return request(
    `auth/callback?${new URLSearchParams({ code, state: authorizationUrl.searchParams.get("state") })}`,
    { cookie: loginCookie },
  );
};

/** Runs the full browser sign-in flow and returns the session cookie header value. */
const signIn = async (claims) => {
  const callback = await attemptSignIn(claims);
  assert.equal(
    callback.status,
    302,
    `Sign-in failed. Server log:\n${serverOutput()}`,
  );
  assert.equal(callback.headers.get("location"), appUrl);
  const session = readSetCookies(callback).imageparser_session;
  assert.ok(session, "the callback sets a session cookie");
  return `imageparser_session=${session}`;
};

const getJson = async (pathname, cookie) => {
  const response = await request(pathname, { cookie });
  return { status: response.status, body: await response.json() };
};

const postJson = async (pathname, cookie, body) => {
  const response = await request(pathname, {
    cookie,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

const alice = {
  sub: "alice-subject",
  preferred_username: "alice",
  groups: ["family"],
  imageparser_folders: ["family", "scans/2023"],
};
const bob = {
  sub: "bob-subject",
  preferred_username: "bob",
  groups: [],
  imageparser_folders: ["vacations"],
};
const admin = {
  sub: "admin-subject",
  preferred_username: "root",
  groups: ["imageparser-admin"],
  imageparser_folders: [],
};
const attributeAdmin = {
  sub: "attribute-admin-subject",
  preferred_username: "carol",
  groups: [],
  imageparser_folders: ["family"],
  imageparser_admin: true,
};
const backupBasicAuth = `Basic ${Buffer.from("backup:backup-password").toString("base64")}`;
const startedServers = [];

/**
 * Starts server.js with the shared test folders and waits until it answers health checks.
 * @param {Object} env - Extra environment variables.
 * @returns {Promise<{url: string, output: () => string}>} The server's base URL and log.
 */
const startServer = async (env) => {
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}/`;
  let output = "";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      IMAGEPARSER_ROOT: root,
      IMAGEPARSER_CONFIG_DIR: configDirectory,
      IMAGEPARSER_USERNAME: "",
      IMAGEPARSER_PASSWORD: "",
      IMAGEPARSER_SECRET_KEY: "",
      IMAGEPARSER_DEBUG: "true",
      OIDC_DISABLED: "",
      ...(typeof env === "function" ? env(url) : env),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  startedServers.push(child);
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`The server exited early:\n${output}`);
    }
    try {
      if ((await fetch(new URL("healthz", url))).ok) {
        return { url, output: () => output };
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`The server did not start:\n${output}`);
};

before(async () => {
  workspace = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "imageparser-oidc-")),
  );
  root = path.join(workspace, "data");
  configDirectory = path.join(workspace, "config");
  for (const folder of [
    "family/2020",
    "family-secret",
    "scans/2023",
    "scans/2024",
    "vacations",
  ]) {
    await fs.mkdir(path.join(root, folder), { recursive: true });
  }
  await fs.writeFile(path.join(root, "family-secret", "hidden.jpg"), "x");

  provider = await startMockProvider();
  // Backup Basic credentials are configured but must be ignored while OIDC sign-in is on.
  const server = await startServer((url) => ({
    IMAGEPARSER_USERNAME: "backup",
    IMAGEPARSER_PASSWORD: "backup-password",
    OIDC_ISSUER_URL: provider.issuer,
    OIDC_CLIENT_ID: clientId,
    OIDC_CLIENT_SECRET: clientSecret,
    OIDC_REDIRECT_URI: `${url}auth/callback`,
    OIDC_ALLOW_INSECURE_REQUESTS: "true",
  }));
  appUrl = server.url;
  serverOutput = server.output;
});

after(async () => {
  for (const child of startedServers) {
    child.kill();
  }
  await new Promise((resolve) => provider?.server.close(resolve));
  await fs.rm(workspace, { recursive: true, force: true });
});

test("health checks need no session", async () => {
  assert.equal((await request("healthz")).status, 200);
});

test("unauthenticated requests are rejected or sent to sign in", async () => {
  const api = await getJson("api/me");
  assert.equal(api.status, 401);
  assert.equal(api.body.error, "Sign in to continue.");

  const page = await request("");
  assert.equal(page.status, 302);
  assert.equal(page.headers.get("location"), `${appUrl}auth/login`);

  assert.equal(
    (await getJson("api/me", "imageparser_session=forged")).status,
    401,
  );
});

test("a callback without the login cookie is refused", async () => {
  const login = await request("auth/login");
  const state = new URL(login.headers.get("location")).searchParams.get(
    "state",
  );
  const callback = await request(`auth/callback?code=x&state=${state}`);
  assert.equal(callback.status, 400);
  assert.match(
    await callback.text(),
    /expired or was started in another browser/,
  );
});

test("an ID token with a forged signature is refused", async () => {
  const callback = await attemptSignIn(alice, { forgeSignature: true });
  assert.equal(callback.status, 400);
  assert.equal(readSetCookies(callback).imageparser_session, undefined);
  assert.match(serverOutput(), /JWT signature verification failed/);
});

test("signs in and reports the current user", async () => {
  const cookie = await signIn(alice);
  const me = await getJson("api/me", cookie);
  assert.deepEqual(me.body, {
    username: "alice",
    isAdmin: false,
    authMode: "oidc",
  });
});

test("a user browses only their shared folders and their children", async () => {
  const cookie = await signIn(alice);

  const virtualRoot = await getJson("api/browse", cookie);
  assert.equal(virtualRoot.status, 200);
  assert.equal(virtualRoot.body.selectable, false);
  assert.deepEqual(
    virtualRoot.body.directories.map((directory) => directory.name),
    ["family", "scans/2023"],
  );

  const family = await getJson(
    `api/browse?${new URLSearchParams({ path: path.join(root, "family") })}`,
    cookie,
  );
  assert.equal(family.status, 200);
  assert.equal(family.body.parent, "");
  assert.deepEqual(
    family.body.directories.map((d) => d.name),
    ["2020"],
  );

  const child = await getJson(
    `api/browse?${new URLSearchParams({ path: path.join(root, "family", "2020") })}`,
    cookie,
  );
  assert.equal(child.status, 200);
  assert.equal(child.body.parent, path.join(root, "family"));

  for (const forbidden of [
    root,
    path.join(root, "family-secret"),
    path.join(root, "scans"),
    path.join(root, "family", "..", "vacations"),
    path.join(root, "does-not-exist"),
  ]) {
    const response = await getJson(
      `api/browse?${new URLSearchParams({ path: forbidden })}`,
      cookie,
    );
    assert.equal(response.status, 403, forbidden);
  }
});

test("file routes enforce the user's folders", async () => {
  const cookie = await signIn(alice);
  const hidden = path.join(root, "family-secret", "hidden.jpg");

  const image = await request(
    `api/image?${new URLSearchParams({ path: hidden })}`,
    {
      cookie,
    },
  );
  assert.equal(image.status, 403);
  for (const [route, body] of [
    ["api/read-sidecar-metadata", { filePath: hidden }],
    ["api/preview-url", { filePath: hidden, rotation: 0 }],
    ["api/read-directory", { directoryPath: path.join(root, "family-secret") }],
    ["api/save-metadata", { frontPath: hidden, backPath: null }],
    [
      "api/upload-to-immich",
      { settings: {}, directoryPath: path.join(root, "vacations") },
    ],
  ]) {
    assert.equal((await postJson(route, cookie, body)).status, 403, route);
  }
});

test("a user with one shared folder starts inside it", async () => {
  const cookie = await signIn(bob);
  const listing = await getJson("api/browse", cookie);
  assert.equal(listing.body.path, path.join(root, "vacations"));
  assert.equal(listing.body.parent, null);
});

test("administrators reach the whole root and the debug log", async () => {
  const cookie = await signIn(admin);
  const listing = await getJson("api/browse", cookie);
  assert.equal(listing.body.path, root);
  assert.equal(listing.body.parent, null);
  assert.equal((await getJson("api/config", cookie)).body.debug, true);

  const userCookie = await signIn(alice);
  assert.equal((await getJson("api/config", userCookie)).body.debug, false);
  const debugLog = await request("api/debug-log", { cookie: userCookie });
  assert.equal(debugLog.status, 403);
});

test("Immich settings are stored per user", async () => {
  const aliceCookie = await signIn(alice);
  const bobCookie = await signIn(bob);
  const saved = await postJson("api/immich-settings", aliceCookie, {
    serverUrl: "https://immich.example.test",
    userApiKey: "alice-key",
    albumName: "Family",
    tags: "",
    pauseImmichJobs: true,
    concurrentTasks: 2,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  assert.equal(
    (await getJson("api/immich-settings", aliceCookie)).body.userApiKey,
    "alice-key",
  );
  const bobSettings = await getJson("api/immich-settings", bobCookie);
  assert.equal(bobSettings.body.userApiKey, "");
  assert.equal(bobSettings.body.serverUrl, "");

  const users = await fs.readdir(path.join(configDirectory, "users"));
  assert.equal(users.length, 1);
  assert.match(users[0], /^[0-9a-f]{64}$/);
  const stored = await fs.readFile(
    path.join(configDirectory, "users", users[0], "immich-settings.json"),
    "utf8",
  );
  assert.doesNotMatch(stored, /alice-key/);
});

test("sign-out clears the session and ends the provider session", async () => {
  const cookie = await signIn(alice);
  const logout = await request("auth/logout", { cookie });
  assert.equal(logout.status, 302);
  const location = new URL(logout.headers.get("location"));
  assert.equal(
    `${location.origin}${location.pathname}`,
    `${provider.issuer}/end-session`,
  );
  assert.equal(readSetCookies(logout).imageparser_session, "");
});

test("a user with the admin attribute sees every folder", async () => {
  const cookie = await signIn(attributeAdmin);
  assert.equal((await getJson("api/me", cookie)).body.isAdmin, true);
  assert.equal((await getJson("api/browse", cookie)).body.path, root);
  const secret = await getJson(
    `api/browse?${new URLSearchParams({ path: path.join(root, "family-secret") })}`,
    cookie,
  );
  assert.equal(secret.status, 200);
});

test("backup Basic credentials are ignored while OIDC sign-in is on", async () => {
  const response = await request("api/me", {
    headers: { Authorization: backupBasicAuth },
  });
  assert.equal(response.status, 401);
});

test("OIDC_DISABLED falls back to the backup Basic credentials", async () => {
  const fallback = await startServer({
    IMAGEPARSER_USERNAME: "backup",
    IMAGEPARSER_PASSWORD: "backup-password",
    OIDC_ISSUER_URL: provider.issuer,
    OIDC_CLIENT_ID: clientId,
    OIDC_CLIENT_SECRET: clientSecret,
    OIDC_REDIRECT_URI: "http://127.0.0.1:1/auth/callback",
    OIDC_DISABLED: "true",
  });
  const fetchFallback = (pathname, init) =>
    fetch(new URL(pathname, fallback.url), { redirect: "manual", ...init });

  const challenge = await fetchFallback("api/me");
  assert.equal(challenge.status, 401);
  assert.match(challenge.headers.get("www-authenticate"), /^Basic /);
  assert.equal((await fetchFallback("auth/login")).status, 401);

  const me = await fetchFallback("api/me", {
    headers: { Authorization: backupBasicAuth },
  });
  assert.deepEqual(await me.json(), {
    username: "backup",
    isAdmin: true,
    authMode: "basic",
  });
  assert.match(
    fallback.output(),
    /OIDC_DISABLED is set: identity provider sign-in is bypassed/,
  );
});

test("OIDC_DISABLED without backup credentials opens access and warns", async () => {
  const open = await startServer({
    OIDC_ISSUER_URL: provider.issuer,
    OIDC_DISABLED: "true",
  });
  const me = await fetch(new URL("api/me", open.url));
  assert.equal(me.status, 200);
  assert.equal((await me.json()).authMode, "none");
  assert.match(open.output(), /AUTHENTICATION IS OFF/);
});
