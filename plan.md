# Plan

## Completed

- Replaced the starter React app with a desktop-style image review workflow.
- Added Electron main-process file scanning and metadata APIs.
- Implemented front/back pairing logic for *_a / *_b files.
- Added the dual-panel viewer and metadata form.
- Persist metadata by creating or updating the matching `.xmp` sidecar file instead of writing to the original image.
- Verified the project builds cleanly and the app can load paired image sets and read existing XMP values.

## Current focus

- Validate the desktop app runs in a live session against a real paired directory.
- Confirm the A-file `.xmp` is treated as the source of truth for date, description, and location fields.
- Check XMP sidecar output against Immich-style expectations and adjust tag names if needed.

## Next steps

1. Start the Electron app in development mode.
2. Load a test directory containing paired image files and `.xmp` sidecars.
3. Verify date/description/location values hydrate from the A-file sidecar.
4. Confirm edits auto-save into the `.xmp` sidecar without a manual Save click.
5. Validate left/right arrow navigation and the paired B-image display while editing.
