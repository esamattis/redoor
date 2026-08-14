---
name: generate-logo-assets
description: Use when changing Redoor logo SVGs, manifest icons, logo192.png, logo512.png, favicon.ico, or when asked to regenerate application icon assets.
---

# Generate Logo Assets

Keep `ui/public/logo-dark.svg` as the source of truth for raster application icons. Do not edit `logo192.png`, `logo512.png`, or `favicon.ico` manually.

## Regenerate Assets

1. Confirm GraphicsMagick is available with `mise exec -- gm version`.
2. Make the intended SVG edits before generating raster files.
3. Run `mise exec -- pn generate-icons` from the repository root.
4. Keep all generated files in `ui/public`.

The generator creates:

- `logo192.png` for the web application manifest and Apple touch icon.
- `logo512.png` for the web application manifest.
- `favicon.ico` with 16, 32, 48, and 64 pixel PNG frames rasterized by GraphicsMagick and packaged by the script.

## Verify Outputs

1. Run `mise exec -- gm identify ui/public/logo192.png ui/public/logo512.png ui/public/favicon.ico`.
2. Confirm the PNG dimensions are exactly 192x192 and 512x512.
3. Confirm the ICO lists 16x16, 32x32, 48x48, and 64x64 frames.
4. Use Playwright screenshot rendering when visual changes need comparison against a supplied reference.
5. Check `ui/public/manifest.json` and `ui/index.html` before changing names or adding generated sizes so every generated asset has an application consumer.

Do not run the full test suite solely for regenerated image assets unless the user requests it or related application code also changed.
