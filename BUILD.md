# Build instructions (for AMO review)

Requirements: Node.js 18+ and npm.

```
npm install
npm run build
```

This runs `build.mjs`, which bundles the sources in `src/` with esbuild
(no minification) and writes the unpacked extension to:

- `dist/firefox/` — the Firefox package (matches the uploaded zip)
- `dist/chrome/`  — the Chrome package

The uploaded zip is the contents of `dist/firefox/` (sourcemaps excluded).
Icons are generated from `icons/base.svg` plus the 文A glyph via ImageMagick;
the committed PNGs in `icons/` are the result and are what the build ships.
