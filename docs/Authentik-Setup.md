# Authentik Setup for Image Parser

This guide configures [Authentik](https://goauthentik.io/) as the sign-in provider for the Image Parser web server.
When you're done:

- Users sign in with their Authentik account (including MFA, if your flows require it).
- Each user sees only the folders you grant them, plus everything inside those folders.
- Admin users see the whole photo share.
- Each user keeps their own Immich server URL, album, and API keys.

Menu names below match current Authentik releases. Older versions may label a few items slightly differently.

---

## Before you start

You need:

1. **A public HTTPS address for Image Parser**, for example `https://photos.example.com`, served by a reverse proxy
   (Traefik, Nginx Proxy Manager, Caddy, …) in front of the container's port `8080`. Users must always open Image
   Parser at this address. Sign-in cookies are tied to the host name, so sign-in fails if users browse to
   `http://<truenas-ip>:8080` instead.
2. **Network access from the container to Authentik.** The Image Parser server talks to Authentik directly to
   exchange the sign-in code, fetch signing keys, and read user details. The URL you configure must work from
   inside the container, not just from your browser.
3. **The folder layout of your photo share.** Folder grants are paths relative to the share mounted at `/data`.
   For example, `/mnt/tank/photos/family` on the host becomes `family` when `/mnt/tank/photos` is mounted.
4. **Admin access to Authentik.**

Placeholders used below:

| Placeholder                  | Meaning                                              |
| ---------------------------- | ---------------------------------------------------- |
| `https://photos.example.com` | Public Image Parser address                          |
| `https://auth.example.com`   | Authentik address                                    |
| `image-parser`               | Application slug (it becomes part of the issuer URL) |

---

## Step 1: Create the scope mapping

The scope mapping sends two pieces of information to Image Parser: the user's folder grants (merged from the user
and all their groups) and whether the user is an admin.

1. Go to **Customization → Property Mappings → Create**.
2. Choose **Scope Mapping** (some versions call it _OAuth2/OpenID Scope Mapping_).
3. Fill in:

   | Field       | Value                                   |
   | ----------- | --------------------------------------- |
   | Name        | `Image Parser`                          |
   | Scope name  | `imageparser`                           |
   | Description | `Image Parser folders and admin access` |

4. **Expression:**

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

5. Save.

> Authentik does **not** merge group attributes into `user.attributes`, so the expression combines them itself.
> Without that, folders granted to a group would be ignored.

**Check:** open the mapping and use **Test** with a user. The result should look like
`{"imageparser_folders": ["family"], "imageparser_admin": false}`.

---

## Step 2: Create the OAuth2/OpenID provider

1. Go to **Applications → Providers → Create → OAuth2/OpenID Provider**.
2. Fill in:

   | Field                     | Value                                                                                        |
   | ------------------------- | -------------------------------------------------------------------------------------------- |
   | Name                      | `Image Parser`                                                                               |
   | Authorization flow        | `default-provider-authorization-implicit-consent` (no consent screen) or `…explicit-consent` |
   | Invalidation flow         | `default-provider-invalidation-flow` (runs when a user clicks **Sign out**)                  |
   | **Client type**           | **Confidential**                                                                             |
   | Client ID / Client Secret | Leave the generated values; **copy both** for step 6                                         |
   | **Redirect URIs/Origins** | Mode **Strict**, URL `https://photos.example.com/auth/callback`                              |
   | **Signing Key**           | **Required.** Choose a certificate, e.g. `authentik Self-signed Certificate`                 |

3. Under **Advanced protocol settings**:

   | Field                      | Value                                                                                                       |
   | -------------------------- | ----------------------------------------------------------------------------------------------------------- |
   | **Scopes**                 | Keep `authentik default OAuth Mapping: OpenID 'openid'`, `'email'`, and `'profile'`; **add `Image Parser`** |
   | **Subject mode**           | Keep the default, **Based on the User's hashed ID**                                                         |
   | Include claims in id_token | Either setting works (Image Parser also reads the userinfo endpoint)                                        |
   | Issuer mode                | Keep the default, **Each provider has a different issuer, based on the application slug**                   |

4. Save.

Why these settings matter:

- **Signing Key:** Image Parser verifies the signature of every ID token against the keys Authentik publishes.
  Without a signing key, Authentik signs tokens with the client secret (HS256), and Image Parser refuses them.
  The server log then shows `unsupported JWS algorithm`.
- **Profile scope:** sends the `groups` claim, which is used for the admin group.
- **Subject mode:** each user's Immich settings are stored under a hash of the subject (`sub`). Changing the subject
  mode later gives every user a new subject, and their saved Immich settings appear to vanish (the old files are
  still on disk).
- **Redirect URI:** it must match `OIDC_REDIRECT_URI` exactly, including `https` and with no trailing slash.

---

## Step 3: Create the application and choose who may sign in

1. Go to **Applications → Applications → Create** (or use **Create with Provider**, which combines steps 2 and 3).
2. Fill in:

   | Field      | Value                         |
   | ---------- | ----------------------------- |
   | Name       | `Image Parser`                |
   | Slug       | `image-parser`                |
   | Provider   | `Image Parser` (from step 2)  |
   | Launch URL | `https://photos.example.com/` |

3. Save, then open the application's **Policy / Group / User Bindings** tab and bind the groups or users allowed to
   sign in (for example a `photo-users` group).

> If an application has no bindings, **every** Authentik user can sign in. Users without folder grants see "No
> folders are shared with your account", but they could still save Immich settings, so add bindings.

**Find the issuer URL:** open the provider from step 2. The overview shows **OpenID Configuration Issuer**, for
example `https://auth.example.com/application/o/image-parser/`. Copy it **exactly, including the trailing `/`**.

---

## Step 4: Set up admin users (optional)

Admins see every folder in the share, including folders granted to other users, and can read the server debug log
when `IMAGEPARSER_DEBUG` is on. You can make someone an admin either way.

**Option A: admin group (recommended for more than one admin)**

1. Go to **Directory → Groups → Create**, name it `imageparser-admin`, and save.
2. Add the admin users to the group (**Users** tab → **Add existing user**).

To use a different group name, set `OIDC_ADMIN_GROUP` to it.

**Option B: per-user attribute**

1. Go to **Directory → Users**, edit the user, and add this to **Attributes**:

   ```yaml
   imageparser_admin: true
   ```

The value must be the YAML boolean `true`. `"yes"`, `1`, and `on` do **not** count.

---

## Step 5: Grant folders

Add an `imageparser_folders` attribute to users, groups, or both (**Directory → Users** or **Directory → Groups** →
edit → **Attributes**):

```yaml
imageparser_folders:
  - family
  - scans/2023
```

Rules:

- Paths are relative to the photo share root (`/data` in the container). Don't start with `/data`.
- A grant includes all subfolders: `family` also gives access to `family/2020/christmas`.
- Grants are exact names on a folder boundary: `family` does **not** grant `family-secret`.
- A user's folders are the combination of their own grants and all their groups' grants.
- A single folder can be written as a plain string: `imageparser_folders: family`.
- Invalid entries (`..`, `./x`, empty strings) are ignored, as are folders that don't exist on disk and symlinks
  that point outside the share. If you create a granted folder after the user has signed in, it can take up to 30
  seconds to appear (grants are cached briefly for speed).
- Up to 50 folders per user. Grant a parent folder rather than many siblings.

What users see in the folder browser:

| Grants          | Starting view                                    |
| --------------- | ------------------------------------------------ |
| One folder      | Opens inside that folder                         |
| Several folders | A **Your folders** list with one entry per grant |
| None            | "No folders are shared with your account."       |
| Admin           | The whole share                                  |

> Folder and admin changes apply the **next time the user signs in**, or when their session expires
> (`OIDC_SESSION_HOURS`, default 8 hours). Ask users to **Sign out** and back in to pick up changes immediately.

---

## Step 6: Configure Image Parser

In the stack's `.env` file (Dockge: the **.env** editor), set:

```env
OIDC_ISSUER_URL=https://auth.example.com/application/o/image-parser/
OIDC_CLIENT_ID=<client ID from step 2>
OIDC_CLIENT_SECRET=<client secret from step 2>
OIDC_REDIRECT_URI=https://photos.example.com/auth/callback

# Recommended: backup credentials for emergency access (ignored while sign-in works).
IMAGEPARSER_USERNAME=admin
IMAGEPARSER_PASSWORD=<long random password>
```

Optional settings (defaults shown):

| Variable                       | Default                            | Purpose                                                          |
| ------------------------------ | ---------------------------------- | ---------------------------------------------------------------- |
| `OIDC_SCOPES`                  | `openid profile email imageparser` | Scopes to request. Must include the scope name from step 1       |
| `OIDC_ADMIN_GROUP`             | `imageparser-admin`                | Admin group name (step 4, option A)                              |
| `OIDC_ADMIN_CLAIM`             | `imageparser_admin`                | Admin claim name (step 4, option B)                              |
| `OIDC_FOLDERS_CLAIM`           | `imageparser_folders`              | Folder claim name (step 5)                                       |
| `OIDC_SESSION_HOURS`           | `8`                                | How long a sign-in lasts                                         |
| `OIDC_ALLOW_INSECURE_REQUESTS` | `false`                            | Set `true` only if Authentik is plain `http://` on a trusted LAN |
| `OIDC_DISABLED`                | `false`                            | Emergency bypass (see [below](#emergency-access))                |

If Authentik uses a certificate from a private CA, mount the CA certificate into the container and set
`NODE_EXTRA_CA_CERTS` to its path inside the container (for example `/config/ca.crt`).

Redeploy the stack.

---

## Step 7: Verify

1. **Container can reach Authentik.** From the TrueNAS shell (replace the container name and issuer):

   ```sh
   docker exec imageparser node -e "fetch('https://auth.example.com/application/o/image-parser/.well-known/openid-configuration').then(r=>r.json()).then(c=>console.log(c.issuer, c.id_token_signing_alg_values_supported))"
   ```

   Expected output: the issuer URL exactly as in `OIDC_ISSUER_URL`, followed by `[ 'RS256' ]` (or another
   asymmetric algorithm). If it prints `HS256`, add a signing key (step 2).

2. **Startup log** shows `OpenID Connect sign-in is enabled (issuer: …)`, with **no** warning that
   `OIDC_REDIRECT_URI does not use HTTPS`.
3. **Sign in.** Open `https://photos.example.com`. You're redirected to Authentik, and after signing in you return
   to Image Parser with **Signed in as \<username\>** in the header.
4. **Folders.** Click **Load directory**. A regular user sees only their granted folders; an admin sees the whole
   share.
5. **Immich isolation.** Save Immich settings as one user, then sign in as another user. The second user's settings
   start empty.
6. **Sign out** returns you to Authentik's signed-out page. Opening Image Parser again asks you to sign in.

---

## Day-to-day administration

| Task                         | What to do                                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a user                   | Add them to a bound group (step 3) and grant folders to them or a group (step 5)                                                                                 |
| Change a user's folders      | Edit the attribute; it applies at their next sign-in                                                                                                             |
| Remove a user's access       | Remove them from the application's bindings. An existing session stays valid until it expires (up to `OIDC_SESSION_HOURS`)                                       |
| Sign everyone out right away | Change `IMAGEPARSER_SECRET_KEY` (or delete `/config/secret.key`) and redeploy. **This also makes saved Immich API keys unreadable**, so users must re-enter them |
| Make someone an admin        | Add them to `imageparser-admin`, or set `imageparser_admin: true` (step 4)                                                                                       |

Each user's Immich settings are stored encrypted in `/config/users/<id>/immich-settings.json`, where `<id>` is a
hash of their Authentik ID. The shared `/config/immich-settings.json` from before single sign-on is not migrated.

---

## Emergency access

If Authentik is down or misconfigured and you need Image Parser anyway:

1. Set `OIDC_DISABLED=true` in the stack's `.env` and redeploy. Leave the other `OIDC_*` settings as they are.
2. Then:
   - If `IMAGEPARSER_USERNAME`/`IMAGEPARSER_PASSWORD` are set, the browser asks for those backup credentials.
   - If they are not set, **authentication is turned off completely**: anyone who can reach the server has full
     access to all photos and the saved Immich keys. The startup log warns `AUTHENTICATION IS OFF`.
3. While the bypass is on, everyone is an admin and uses the shared `/config/immich-settings.json`. Personal Immich
   settings are kept on disk.
4. When Authentik is back, remove `OIDC_DISABLED` (or set it to `false`) and redeploy.

---

## Troubleshooting

Sign-in errors show a short "Sign-in failed" page in the browser. The specific reason is in the container log,
on a line starting with `OpenID Connect sign-in failed:`.

| Symptom / log message                                                                  | Cause and fix                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unsupported JWS algorithm` or `unexpected JWT "alg" header parameter`                 | The provider has no signing key, so tokens are HS256. Select a **Signing Key** (step 2), then restart the container so it re-reads the provider's configuration                                                       |
| `JWT signature verification failed` or `no applicable keys found`                      | The token wasn't signed by a key Authentik currently publishes. If you just changed the provider's signing key, restart the container                                                                                 |
| Authentik shows **Redirect URI Error**                                                 | `OIDC_REDIRECT_URI` doesn't match the provider's redirect URI exactly (scheme, host, path, trailing slash)                                                                                                            |
| Opening Image Parser shows a JSON error; the log has `Request failed: GET /auth/login` | Discovery failed. With `"issuer" property does not match the expected value`, `OIDC_ISSUER_URL` differs from the provider's issuer (often the trailing `/`). Otherwise the container can't reach Authentik (step 7.1) |
| `unable to verify the first certificate` / `self-signed certificate`                   | Authentik uses a private CA. Set `NODE_EXTRA_CA_CERTS` (step 6)                                                                                                                                                       |
| `only requests to HTTPS are allowed`                                                   | The issuer is `http://`. Use HTTPS, or set `OIDC_ALLOW_INSECURE_REQUESTS=true` on a trusted LAN                                                                                                                       |
| "The sign-in attempt expired or was started in another browser"                        | The user opened Image Parser on a different host than the redirect URI (e.g. the IP address), cookies are blocked, or more than 10 minutes passed on the Authentik page. Use the public HTTPS address                 |
| "No folders are shared with your account"                                              | No `imageparser_folders` attribute; the **Image Parser** scope isn't added to the provider (step 2.3); `OIDC_SCOPES` is missing `imageparser`; or the folder doesn't exist under `/data`                              |
| An admin only sees their own folders                                                   | Check the group name matches `OIDC_ADMIN_GROUP`, the `profile` scope is still on the provider, the attribute is boolean `true`, and the user has signed in again                                                      |
| "Your account has too many shared folders…"                                            | More grants than fit in a session cookie. Grant parent folders instead of many subfolders                                                                                                                             |
| A user's Immich settings disappeared                                                   | The provider's subject mode or the Authentik user changed, so the user has a new ID. Re-enter the settings                                                                                                            |
| Log warns `OIDC_REDIRECT_URI does not use HTTPS`                                       | Cookies are sent without `Secure`. Use an `https://` redirect URI behind your reverse proxy                                                                                                                           |

To test the scope mapping's output for a specific user, use **Test** on the property mapping (step 1). To see the
full server log in the browser, set `IMAGEPARSER_DEBUG=true` and sign in as an admin. Turn it off again afterwards.

---

## Reference: claims Image Parser reads

| Claim                 | Source                       | Used for                                                     |
| --------------------- | ---------------------------- | ------------------------------------------------------------ |
| `sub`                 | `openid` scope               | Stable user ID; hashed to locate the user's Immich settings  |
| `preferred_username`  | `profile` scope              | Name shown in the header (falls back to `email`, then `sub`) |
| `groups`              | `profile` scope              | Admin group membership                                       |
| `imageparser_folders` | `imageparser` scope (step 1) | Folder grants                                                |
| `imageparser_admin`   | `imageparser` scope (step 1) | Per-user admin flag                                          |

For the security design behind this setup, see [authentik-service-provider-plan.md](authentik-service-provider-plan.md).
