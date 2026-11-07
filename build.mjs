import * as esbuild from "esbuild";
import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const watch = process.argv.includes("--watch");
const root = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(root, "src");
const targets = ["chrome", "firefox"];

const entryPoints = {
  background: path.join(src, "background.js"),
  "content-main": path.join(src, "content-main.js"),
  "content-isolated": path.join(src, "content-isolated.js"),
  "youtube-main": path.join(src, "youtube-main.js"),
  "youtube-isolated": path.join(src, "youtube-isolated.js"),
  "popup/popup": path.join(src, "popup", "popup.js"),
  "quiz/quiz": path.join(src, "quiz", "quiz.js"),
};

// The quiz's local AI runs on onnxruntime-web. Its WASM engine must ship
// inside the extension: stores forbid loading executable code from the
// internet (only the model weights — data — are downloaded at runtime).
const ORT_DIST = path.join(root, "node_modules", "onnxruntime-web", "dist");
const ORT_FILES = ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"];

async function buildTarget(target) {
  const outdir = path.join(root, "dist", target);
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  const ctx = await esbuild.context({
    entryPoints,
    bundle: true,
    outdir,
    format: "iife",
    target: "es2022",
    sourcemap: true,
    logLevel: "info",
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }

  const manifest = JSON.parse(
    await readFile(path.join(src, `manifest.${target}.json`), "utf8")
  );
  await writeFile(
    path.join(outdir, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );

  await mkdir(path.join(outdir, "popup"), { recursive: true });
  await cp(
    path.join(src, "popup", "popup.html"),
    path.join(outdir, "popup", "popup.html")
  );
  await cp(
    path.join(src, "popup", "popup.css"),
    path.join(outdir, "popup", "popup.css")
  );
  await mkdir(path.join(outdir, "quiz"), { recursive: true });
  for (const f of ["quiz.html", "quiz.css"]) {
    await cp(path.join(src, "quiz", f), path.join(outdir, "quiz", f));
  }
  await mkdir(path.join(outdir, "ort"), { recursive: true });
  for (const f of ORT_FILES) {
    await cp(path.join(ORT_DIST, f), path.join(outdir, "ort", f));
  }

  await cp(path.join(root, "icons"), path.join(outdir, "icons"), {
    recursive: true,
    // Only ship the PNGs the extension actually references; skip source
    // art (SVG) so the published package stays clean.
    filter: (src) => !src.toLowerCase().endsWith(".svg"),
  });
}

for (const target of targets) {
  await buildTarget(target);
}

console.log(`Built extension bundles for: ${targets.join(", ")}`);
if (watch) {
  console.log("Watching for changes...");
}
