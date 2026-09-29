# Image Parser Agent Guide

## Project overview

Image Parser is a desktop and web application for reviewing paired images, editing metadata, and uploading image
folders to Immich.

- **Frontend:** React 19 and TypeScript in `src/`, built with Vite.
- **Desktop app:** Electron entry point in `main.js`, with the secure renderer bridge in `preload.js`.
- **Web app:** Node's built-in HTTP server in `server.js`, serving the Vite output from `dist/`.
- **Shared image logic:** `core.js` handles image discovery, pairing, previews, XMP/EXIF metadata, Immich uploads,
  and serialized image operations.
- **Container:** `Dockerfile`, `docker-entrypoint.sh`, and `docker-compose.yml` package and run the web version.

Read `README.md` for end-user installation and TrueNAS deployment instructions before changing deployment behavior.

## Repository map

| Path                                  | Responsibility                                                   |
| ------------------------------------- | ---------------------------------------------------------------- |
| `src/App.tsx`                         | Main React workflow and application state                        |
| `src/DirectoryBrowser.tsx`            | Folder selection dialog                                          |
| `src/*.css`                           | Frontend styling                                                 |
| `core.js`                             | Shared filesystem, metadata, preview, and Immich operations      |
| `main.js`                             | Electron lifecycle, windows, dialogs, and IPC handlers           |
| `preload.js`                          | Allowlisted Electron APIs exposed to the renderer                |
| `server.js`                           | HTTP API, path confinement, auth, static files, and SSE progress |
| `imageFileQueue.js`                   | Serializes image file operations                                 |
| `*.test.mjs`                          | Node built-in unit tests                                         |
| `Dockerfile` / `docker-entrypoint.sh` | Production web image and volume/user setup                       |
| `.github/workflows/ci.yml`            | Pull-request test, lint, and build checks                        |
| `.github/workflows/publish.yml`       | Publishes the container image from `master`                      |

## Development commands

Run commands from the repository root after installing Node.js and dependencies with `npm install`.

```text
npm run dev       Start Vite and Electron together
npm start         Start Electron against the existing build
npm run serve     Start the web server
npm run build     Type-check and build the Vite frontend
npm test          Run Node's built-in test runner
npm run lint      Run ESLint
npm run prettier  Format supported source and metadata files
```

For the web server, set `IMAGEPARSER_ROOT` to the photo directory and
`IMAGEPARSER_CONFIG_DIR` to a writable configuration directory. The server defaults to port `8080`.

## Change guidance

- Keep filesystem and metadata behavior in `core.js` so Electron and web paths remain consistent.
- Keep Electron-specific capabilities behind `preload.js`; do not enable renderer Node integration or expose
  unrestricted IPC.
- Treat all web request paths as untrusted. Preserve realpath-based confinement under `IMAGEPARSER_ROOT`, including
  symlink checks, and do not add routes that can read or write outside the configured root.
- Preserve the web server's request-size limits, response error handling, and optional HTTP Basic authentication.
- Never log or persist Immich API keys in plaintext. Use the existing Electron secure-storage path or the web
  server's encrypted config mechanism.
- Use `spawn` with argument arrays and `shell: false` for external commands. Do not construct shell commands from
  user-controlled paths or settings.
- Keep image file operations serialized through the existing queue to avoid competing EXIF/XMP writes and preview
  reads.
- Preserve the `_a`/`_b` pairing convention and the rule that the A-file sidecar is the metadata source of truth.
- Prefer existing React state and component patterns. Keep user-visible errors explicit and accessible.
- Use TypeScript types for frontend data contracts; avoid weakening types with broad casts.
- Do not edit generated `dist/` output or commit `node_modules/`. `package-lock.json` is intentionally not tracked.

## Testing and validation

For code changes, run the smallest applicable checks, then run the full CI-equivalent set when behavior crosses
frontend, shared core, or server boundaries:

```text
npm test
npm run lint
npm run build
```

Add unit tests as `*.test.mjs` files using `node:test` and `node:assert/strict`. Tests should not depend on real
photo shares, credentials, or network services. Use the existing `.smoke-test/` fixtures for manual image workflow
checks.

When changing Docker or server behavior, also verify the container starts with the documented volume and environment
variables and that `/healthz` responds successfully. Do not expose the web server beyond a trusted network without
TLS and authentication.

## Commit and pull-request expectations

Use conventional commit messages; `commitlint.config.js` enforces the conventional format and a 160-character
header limit. Pull requests must keep `npm test`, `npm run lint`, and `npm run build` passing. Describe changes to
metadata writes, path handling, credentials, Docker configuration, or user-visible behavior in the pull request.
