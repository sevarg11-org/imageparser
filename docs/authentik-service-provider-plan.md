# Image Parser: Authentik Service Provider (OIDC) & Per-User Folder Access

## 1. Summary

The web server (`server.js`) acts as an OpenID Connect relying party for an existing **Authentik** identity
provider. When `OIDC_ISSUER_URL` is set:

1. **Recursive folder authorization.** Each user's `imageparser_folders` claim lists folders relative to
   `IMAGEPARSER_ROOT`. A grant covers the folder and all of its children; everything else is hidden and forbidden.
   Admin users (members of `OIDC_ADMIN_GROUP`, or users whose `OIDC_ADMIN_CLAIM` is true) see the whole root.
2. **Per-user Immich settings.** Each user's Immich settings and API keys are stored encrypted in
   `/config/users/<userKey>/immich-settings.json`, where `userKey` is the SHA-256 hex of the OIDC `sub`. Upload
   progress is streamed only to that user, and uploads are serialized per user.

Without `OIDC_ISSUER_URL`, behavior is unchanged: optional HTTP Basic auth, or open local mode, with full access to
the root and one shared settings file. The Electron app is unaffected. While OIDC is on, `IMAGEPARSER_USERNAME` and
`IMAGEPARSER_PASSWORD` are ignored and kept only as backup credentials.

**Emergency bypass.** `OIDC_DISABLED=true` skips OIDC even when it is configured. The server then uses the
Basic backup credentials if set, otherwise open access, and logs a loud startup warning. Every user is a full admin
and uses the shared settings file; per-user settings stay on disk and return when the flag is removed.

## 2. Flow

```mermaid
sequenceDiagram
    autonumber
    actor User as Browser
    participant IP as Image Parser (RP)
    participant Auth as Authentik (IdP)

    User->>IP: GET / (no session)
    IP-->>User: 302 /auth/login
    User->>IP: GET /auth/login
    IP-->>User: Set-Cookie login state (state, nonce, PKCE verifier); 302 to /authorize
    User->>Auth: Authenticate
    Auth-->>User: 302 /auth/callback?code&state
    User->>IP: GET /auth/callback
    IP->>Auth: POST /token (code + code_verifier + client secret)
    Auth-->>IP: id_token (iss/aud/exp/nonce/signature verified) + access_token
    IP->>Auth: GET /userinfo (sub must match id_token)
    IP-->>User: Set-Cookie session (AES-256-GCM sealed); 302 to app
    User->>IP: GET /api/browse (session cookie)
    Note over IP: Re-resolve the user's grants with realpath and check the requested path
```

Implementation: `openid-client` v6 handles discovery (lazy, retried after failure), PKCE S256, `state`, `nonce`,
ID token claim validation (`iss`, `aud`, `exp`, `iat`, `nonce`), and userinfo. The token request's
`redirect_uri` is built from `OIDC_REDIRECT_URI`, not from the request host, because the server runs behind a
reverse proxy.

**Signature verification.** By default, `openid-client` does not verify the signature of an ID token received
directly from the token endpoint; it relies on TLS, which OIDC Core §3.1.3.7 permits. Image Parser also calls
`enableNonRepudiationChecks`, so signatures are verified against the provider's JWKS. That also covers an
issuer reached over plain HTTP with `OIDC_ALLOW_INSECURE_REQUESTS`. As a result, the provider must sign with an
asymmetric key: Authentik's HS256 tokens (issued when no signing key is selected) are rejected. Failures are logged
with the underlying reason (for example `JWT signature verification failed`).

## 3. Authentik configuration

1. **Scope mapping** (`imageparser` scope). Group attributes are not merged into `user.attributes`, so the
   expression unions the user's and their groups' lists:

   ```python
   def grants(attributes):
       value = attributes.get("imageparser_folders", [])
       return [value] if isinstance(value, str) else list(value)

   folders = grants(request.user.attributes)
   for group in request.user.ak_groups.all():
       folders.extend(grants(group.attributes))
   return {
       "imageparser_folders": sorted(set(folders)),
       "imageparser_admin": request.user.attributes.get("imageparser_admin") is True,
   }
   ```

2. **OAuth2/OpenID provider**: confidential client, strict redirect URI `https://<host>/auth/callback`, a
   **signing key** (required; see §2), and the `imageparser` mapping added under _Advanced protocol settings →
   Scopes_ (scopes requested: `openid profile email imageparser`). Keep the default subject mode, because `userKey`
   is derived from `sub`.

The step-by-step operator guide is [Authentik-Setup.md](Authentik-Setup.md). 3. **Admin access** (see every folder and the debug log), granted either way:

- membership of `OIDC_ADMIN_GROUP` (default `imageparser-admin`), from the `groups` claim the default `profile`
  scope already sends;
- a per-user `imageparser_admin: true` attribute, sent as the `OIDC_ADMIN_CLAIM` claim (default
  `imageparser_admin`). Only boolean `true` or the string `"true"` count.

There is no `"*"` folder grant.

## 4. Path confinement (`pathAccess.js`)

- **Claim validation** (`normalizeFolderGrant`): entries must be non-empty strings without `.`/`..`/empty segments
  or NUL; backslashes and surrounding slashes are normalized. Up to 50 unique grants are kept.
- **Resolution** (`resolveAllowedRoots`): each grant is `realpath`-resolved on **every request** and kept only if it
  is an existing directory inside the root. Symlink escapes are dropped, and grants nested in another grant are
  collapsed.
- **Check** (`isPathAllowed`): `realPath === allowed || realPath.startsWith(allowed + path.sep)`, so
  `/data/family-secret` does not match `/data/family`.
- **`resolvePathForUser(user, path)`** replaces `resolvePathInRoot` at every call site: `browse`, `image`,
  `read-directory`, `read-sidecar-metadata`, `save-metadata`, `preview-url`, `apply-image-rotations`, and
  `upload-to-immich`. A missing path outside the user's folders returns 403, not 404, so its existence isn't
  revealed.

### Browse contract

- A non-admin with several grants (or none) who requests no path gets a **virtual root**: `path: ""`,
  `selectable: false`, and one entry per grant. With exactly one grant, they start inside it.
- At an allowed folder, `parent` is `""` (back to the virtual root) or `null` (single grant / admin).
  `DirectoryBrowser` disables **Open this folder** for non-selectable listings.

## 5. Sessions and cookies (`auth.js`)

- Session payload `{ user: { userKey, username, isAdmin, folders }, expiresAt }`, sealed with AES-256-GCM using a
  key derived by HKDF from the master key (`IMAGEPARSER_SECRET_KEY` or `/config/secret.key`). The login-state
  cookie uses a separate derived key. The Immich settings codec keeps using the master key, so existing settings
  remain readable.
- Cookies are `HttpOnly; SameSite=Lax; Path=/`. `Secure` and the `__Host-` prefix are used when
  `OIDC_REDIRECT_URI` is HTTPS (the container itself only speaks HTTP). `Lax` is required for the login cookie to
  survive the redirect back from Authentik. Cross-site POSTs carry no cookie, and the API only accepts
  `application/json`.
- Lifetime `OIDC_SESSION_HOURS` (default 8). The cookie is stateless, so grant changes apply at the next sign-in.
  Sessions over ~3.8 KB are refused at sign-in.
- `/auth/logout` clears the cookie and redirects to Authentik's `end_session_endpoint`.

## 6. Request pipeline (`server.js`)

1. `/healthz` answers without credentials in every mode. This fixes the container `HEALTHCHECK`, which previously
   failed whenever Basic auth was enabled.
2. `GET /auth/login | /auth/callback | /auth/logout` (OIDC mode only). Sign-in failures render a small HTML page
   with a retry link and are logged server-side.
3. Authenticate: OIDC session → `request.user`, or Basic/open → a local admin user. Unauthenticated: API calls
   and non-GETs get `401` JSON. Page loads get `302` to `auth/login`. Basic mode keeps its `WWW-Authenticate`
   challenge.
4. Routes read `request.user`. `GET /api/me` returns `{ username, isAdmin, authMode }`. `/api/debug-log` is
   admin-only, and `/api/config` reports `debug: true` only to admins.

## 7. Immich

- Settings directory: `configDirectory` without OIDC, `configDirectory/users/<userKey>` (mode `0700`) with OIDC.
  `core.js` load/save already take a directory, so they are unchanged. The global file is not migrated.
- Uploads still use the settings in the request body. The browser loads them from the user's own file, so each
  upload runs with that user's credentials. `runImmichUpload` takes a `lockKey` (the user key), so users don't
  block each other.
- Progress SSE clients are grouped by user key, and output is sent only to the uploading user.

## 8. Frontend

- `webApi.ts`: a `401` without `WWW-Authenticate` redirects to `auth/login`. `fetchCurrentUser()` calls `api/me`
  (web only).
- `App.tsx`: when `authMode === "oidc"`, the header shows "Signed in as …" and a **Sign out** link.
- `DirectoryBrowser.tsx`: `selectable` / `parent: ""` handling as described in §4.

## 9. Configuration

| Variable                       | Default                            | Purpose                                         |
| ------------------------------ | ---------------------------------- | ----------------------------------------------- |
| `OIDC_ISSUER_URL`              | _(empty: disabled)_                | Issuer URL; enables OIDC                        |
| `OIDC_CLIENT_ID`               |                                    | Required with OIDC                              |
| `OIDC_CLIENT_SECRET`           |                                    | Required with OIDC; redacted from logs          |
| `OIDC_REDIRECT_URI`            |                                    | Required; public `…/auth/callback` URL          |
| `OIDC_SCOPES`                  | `openid profile email imageparser` | Requested scopes                                |
| `OIDC_ADMIN_GROUP`             | `imageparser-admin`                | Group granting the whole root                   |
| `OIDC_ADMIN_CLAIM`             | `imageparser_admin`                | Per-user claim granting the whole root          |
| `OIDC_FOLDERS_CLAIM`           | `imageparser_folders`              | Claim with folder grants                        |
| `OIDC_SESSION_HOURS`           | `8`                                | Session lifetime                                |
| `OIDC_ALLOW_INSECURE_REQUESTS` | `false`                            | Permit an HTTP issuer (trusted networks, tests) |
| `OIDC_DISABLED`                | `false`                            | Emergency bypass of OIDC (see §1)               |

An Authentik instance with a private CA needs `NODE_EXTRA_CA_CERTS` in the container.

## 10. Threat model

| Threat                                         | Defense                                                                                                                          |
| :--------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------- |
| Traversal (`../other`) in request paths        | `path.resolve` + `realpath`, then a prefix check against the user's re-resolved grants                                           |
| Traversal or absolute paths in claims          | `normalizeFolderGrant` rejects them; resolved grants must be inside the root                                                     |
| Symlink escape                                 | Both the requested path and the grants are `realpath`-resolved before the check                                                  |
| Prefix collision (`family-secret` vs `family`) | The `path.sep` boundary in the check                                                                                             |
| Username used as a path / renamed users        | Settings are keyed by `sha256(sub)`, validated as 64 hex characters before use                                                   |
| Cross-user Immich key or output leakage        | Per-user settings directory; per-user SSE fan-out; debug log admin-only                                                          |
| Cookie tampering or forgery                    | AES-256-GCM authenticated encryption with HKDF-separated keys; a tampered cookie means no session                                |
| Login CSRF / code injection                    | `state` + `nonce` + PKCE S256, held in a short-lived (10 min) sealed cookie                                                      |
| Forged ID token                                | Signature verified against the JWKS (`enableNonRepudiationChecks`), plus `iss`, `aud`, `exp`, `nonce`; userinfo `sub` must match |
| CSRF on API POSTs                              | `SameSite=Lax` session cookie + JSON-only request bodies                                                                         |

## 11. Tests

- `pathAccess.test.mjs`: grant validation, boundaries, nested grants, a symlink (junction) escape.
- `auth.test.mjs`: sealing, tamper/expiry/key separation, cookie attributes, user context, path-safe user keys.
- `oidcServer.test.mjs`: spawns `server.js` against an in-process mock IdP (RS256 JWKS, PKCE and client-secret
  checks). Covers the full sign-in, rejection of an ID token signed with an unpublished key, 401/302 handling, the virtual root, 403 on every file route, admin access,
  per-user Immich settings on disk, and RP-initiated logout.
