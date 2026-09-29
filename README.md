# Image Parser

## Windows install

Double-click `install.bat` (or run `install.bat /nopause` from a terminal). It will:

1. Install Node.js LTS and `immich-go` via `winget` if they are missing (Node 20.19+ / 22.12+ required).
2. Run `npm install` and `npm run build`.
3. Create an **Image Parser** shortcut on your desktop.

## Docker / TrueNAS (web version)

The container runs Image Parser as a web app. Open `http://<truenas-ip>:8080` in any browser, click the folder
button, and browse the mounted photo share. Metadata edits create or update the `.xmp` sidecars and write EXIF
dates and orientation straight into the files on the share. The desktop (Electron) app is unchanged.

1. In TrueNAS SCALE, create a stack (Apps → Discover → Install via YAML, or Dockge) from `docker-compose.yml`.
2. Set these values in the stack's `.env` file:

   | Variable                 | Example                      | Purpose                                            |
   | ------------------------ | ---------------------------- | -------------------------------------------------- |
   | `IMAGEPARSER_PHOTOS_DIR` | `/mnt/tank/photos/scans`     | Dataset exposed to the web UI (mounted at `/data`) |
   | `IMAGEPARSER_CONFIG_DIR` | `/mnt/tank/apps/imageparser` | Saved Immich settings + encryption key             |
   | `PUID` / `PGID`          | `568` / `568`                | Owner of the photo dataset (`ls -ln` to check)     |
   | `IMAGEPARSER_PORT`       | `8080`                       | Host port for the web UI                           |
   | `IMAGEPARSER_USERNAME`   | `admin`                      | Optional HTTP Basic auth user                      |
   | `IMAGEPARSER_PASSWORD`   | _(strong password)_          | Enables auth when set (recommended)                |

3. The container automatically assigns the config directory to `PUID`/`PGID` before dropping root privileges.
   Make sure that user can also write to the photo dataset; otherwise `.xmp` and EXIF updates will fail.

If upgrading from an earlier image that reports `EACCES` for `/config/secret.key`, pull and recreate the container:

```sh
docker compose pull
docker compose up -d --force-recreate
```

For the old image only, the immediate workaround is to give the configured user ownership of the config dataset:

```sh
chown -R 568:568 /mnt/tank/apps/imageparser
```

Replace both the ID values and path with your configured `PUID`, `PGID`, and `IMAGEPARSER_CONFIG_DIR`.

The web UI can only reach files under `/data`, and paths outside it are rejected. There is no HTTPS in the
container. Keep it on your LAN, or put it behind a reverse proxy with TLS if you expose it more widely.

To run the web server locally without Docker: `npm run build`, then
`IMAGEPARSER_ROOT=/path/to/photos IMAGEPARSER_CONFIG_DIR=./config npm run serve`.

## Automated checks

Unit tests use Node.js's built-in test runner, so no separate test framework dependency is needed. Add tests as
`*.test.mjs` files and run them locally with `npm test`.

The GitHub Actions CI workflow runs the tests, ESLint, and the production build whenever a pull request is opened,
updated, or reopened. To block merges when any check fails, require the **Test, lint, and build** status check in the
repository's branch protection rule or ruleset. CI installs dependencies with `npm install`; the project intentionally
does not track `package-lock.json`.

# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(["dist"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.node.json", "./tsconfig.app.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
]);
```

You can also install [eslint-plugin-react-x](https://npmx.dev/package/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://npmx.dev/package/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from "eslint-plugin-react-x";
import reactDom from "eslint-plugin-react-dom";

export default defineConfig([
  globalIgnores(["dist"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs["recommended-typescript"],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.node.json", "./tsconfig.app.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
]);
```
