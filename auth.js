import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import * as oidc from "openid-client";
import { normalizeFolderGrants } from "./pathAccess.js";

const maxUsernameLength = 128;

/**
 * Derives a purpose-specific 32-byte key from the server's master key.
 * Keeps session cookies and login state cryptographically separate from stored settings.
 * @param {Buffer} masterKey - The server's 32-byte master key.
 * @param {string} purpose - A short label naming what the key protects.
 * @returns {Buffer} The derived key.
 */
const deriveKey = (masterKey, purpose) =>
  Buffer.from(
    hkdfSync(
      "sha256",
      masterKey,
      Buffer.alloc(0),
      `imageparser:${purpose}`,
      32,
    ),
  );

/**
 * Creates an AES-256-GCM codec that seals JSON payloads into cookie-safe strings.
 * Every payload carries an `expiresAt` timestamp; expired or tampered values open as null.
 * @param {Buffer} key - A 32-byte key dedicated to this codec.
 * @returns {{seal: (payload: Object) => string, open: (value: string, now?: number) => Object|null}} The codec.
 */
const createSealedCodec = (key) =>
  Object.freeze({
    seal: (payload) => {
      if (typeof payload?.expiresAt !== "number") {
        throw new Error("Sealed payloads must include an expiresAt timestamp.");
      }
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(payload), "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
        "base64url",
      );
    },
    open: (value, now = Date.now()) => {
      try {
        const sealed = Buffer.from(String(value ?? ""), "base64url");
        if (sealed.length <= 28) {
          return null;
        }
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          sealed.subarray(0, 12),
        );
        decipher.setAuthTag(sealed.subarray(12, 28));
        const payload = JSON.parse(
          Buffer.concat([
            decipher.update(sealed.subarray(28)),
            decipher.final(),
          ]).toString("utf8"),
        );
        return typeof payload?.expiresAt === "number" && payload.expiresAt > now
          ? payload
          : null;
      } catch {
        return null;
      }
    },
  });

/**
 * Parses a Cookie request header. The first occurrence of a name wins.
 * @param {string} [header] - The raw Cookie header.
 * @returns {Map<string, string>} Cookie names mapped to their raw values.
 */
const parseCookies = (header = "") => {
  const cookies = new Map();
  for (const part of String(header).split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }
    const name = part.slice(0, separatorIndex).trim();
    if (name && !cookies.has(name)) {
      cookies.set(name, part.slice(separatorIndex + 1).trim());
    }
  }
  return cookies;
};

/**
 * Serializes an HttpOnly, SameSite=Lax cookie scoped to the whole site.
 * Lax is required so the login cookie survives the top-level redirect back from the identity provider.
 * @param {string} name - The cookie name.
 * @param {string} value - The cookie value; must already be cookie-safe (base64url).
 * @param {{maxAgeSeconds: number, secure: boolean}} options - Lifetime, and whether to add Secure.
 * @returns {string} The Set-Cookie header value.
 */
const serializeCookie = (name, value, { maxAgeSeconds, secure }) =>
  [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ].join("; ");

/**
 * Returns the cookie names for the current transport.
 * The __Host- prefix is only valid with Secure cookies, so it is used only behind HTTPS.
 * @param {boolean} secure - Whether the public URL uses HTTPS.
 * @returns {{session: string, login: string}} The session and login-state cookie names.
 */
const getCookieNames = (secure) =>
  secure
    ? {
        session: "__Host-imageparser_session",
        login: "__Host-imageparser_login",
      }
    : { session: "imageparser_session", login: "imageparser_login" };

/**
 * Derives a filesystem-safe, stable identifier for a user from their OIDC subject.
 * Usernames are never used in paths because they can be renamed and may contain path characters.
 * @param {string} subject - The OIDC `sub` claim.
 * @returns {string} A 64-character lowercase hex identifier.
 */
const createUserKey = (subject) =>
  createHash("sha256").update(String(subject), "utf8").digest("hex");

/**
 * Builds the session's user context from identity provider claims.
 * @param {Object} claims - Merged ID token and userinfo claims.
 * A user is an administrator when they belong to the admin group, or when the admin claim is exactly
 * true (a boolean, or the string "true" for attributes entered as text).
 * @param {{foldersClaim: string, adminGroup: string, adminClaim?: string}} options - The folder claim, admin group, and admin claim names.
 * @returns {{userKey: string, username: string, isAdmin: boolean, folders: string[]}} The user context.
 * @throws {Error} If the claims have no subject.
 */
const buildUserContext = (
  claims,
  { foldersClaim, adminGroup, adminClaim = "" },
) => {
  const subject = typeof claims?.sub === "string" ? claims.sub : "";
  if (!subject) {
    throw new Error("The identity provider did not return a user subject.");
  }

  const groups = Array.isArray(claims.groups)
    ? claims.groups.filter((group) => typeof group === "string")
    : [];
  const username = [claims.preferred_username, claims.email, subject].find(
    (value) => typeof value === "string" && value.trim(),
  );
  const adminClaimValue = adminClaim ? claims[adminClaim] : undefined;

  return {
    userKey: createUserKey(subject),
    username: username.trim().slice(0, maxUsernameLength),
    isAdmin:
      (Boolean(adminGroup) && groups.includes(adminGroup)) ||
      adminClaimValue === true ||
      (typeof adminClaimValue === "string" &&
        adminClaimValue.trim().toLowerCase() === "true"),
    folders: normalizeFolderGrants(claims[foldersClaim]),
  };
};

/**
 * Creates an OpenID Connect client for the authorization code flow with PKCE.
 * Discovery runs lazily and is retried on the next login if the identity provider was unreachable.
 * ID token signatures are verified against the provider's JWKS, so the provider must sign with an
 * asymmetric key (for example RS256); symmetric HS256 tokens are rejected.
 * @param {{issuerUrl: string, clientId: string, clientSecret: string, redirectUri: string, scopes: string, allowInsecureRequests?: boolean}} config - Client settings.
 * @returns {Object} Methods to start a login, finish it from the callback, and build a logout URL.
 */
const createOidcClient = ({
  issuerUrl,
  clientId,
  clientSecret,
  redirectUri,
  scopes,
  allowInsecureRequests = false,
}) => {
  let configurationPromise = null;

  const getConfiguration = () => {
    configurationPromise ??= oidc
      .discovery(new URL(issuerUrl), clientId, clientSecret, undefined, {
        execute: [
          // openid-client otherwise relies on TLS alone for ID tokens from the token endpoint.
          oidc.enableNonRepudiationChecks,
          ...(allowInsecureRequests ? [oidc.allowInsecureRequests] : []),
        ],
        timeout: 15,
      })
      .catch((error) => {
        configurationPromise = null;
        throw error;
      });
    return configurationPromise;
  };

  return Object.freeze({
    /**
     * Builds the identity provider authorization URL and the checks to verify on callback.
     * @returns {Promise<{url: URL, checks: {codeVerifier: string, state: string, nonce: string}}>} The redirect target and login checks.
     */
    startLogin: async () => {
      const configuration = await getConfiguration();
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const url = oidc.buildAuthorizationUrl(configuration, {
        redirect_uri: redirectUri,
        scope: scopes,
        code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: "S256",
        state,
        nonce,
      });
      return { url, checks: { codeVerifier, state, nonce } };
    },
    /**
     * Exchanges the authorization code and returns validated ID token and userinfo claims.
     * The callback query is applied to the configured redirect URI, because the request's own
     * host is the internal address when the server runs behind a reverse proxy.
     * @param {URLSearchParams} callbackParams - The callback request's query parameters.
     * @param {{codeVerifier: string, state: string, nonce: string}} checks - The checks saved by startLogin.
     * @returns {Promise<Object>} The merged claims; userinfo values override ID token values.
     */
    finishLogin: async (callbackParams, checks) => {
      const configuration = await getConfiguration();
      const callbackUrl = new URL(redirectUri);
      callbackUrl.search = callbackParams.toString();
      const tokens = await oidc.authorizationCodeGrant(
        configuration,
        callbackUrl,
        {
          pkceCodeVerifier: checks.codeVerifier,
          expectedState: checks.state,
          expectedNonce: checks.nonce,
          idTokenExpected: true,
        },
      );
      const idTokenClaims = tokens.claims();
      const userInfo = await oidc.fetchUserInfo(
        configuration,
        tokens.access_token,
        idTokenClaims.sub,
      );
      return { ...idTokenClaims, ...userInfo };
    },
    /**
     * Builds the identity provider's RP-initiated logout URL, when it advertises one.
     * @returns {Promise<URL|null>} The end-session URL, or null if unsupported.
     */
    buildLogoutUrl: async () => {
      const configuration = await getConfiguration();
      return configuration.serverMetadata().end_session_endpoint
        ? oidc.buildEndSessionUrl(configuration, { client_id: clientId })
        : null;
    },
  });
};

export {
  buildUserContext,
  createOidcClient,
  createSealedCodec,
  createUserKey,
  deriveKey,
  getCookieNames,
  parseCookies,
  serializeCookie,
};
