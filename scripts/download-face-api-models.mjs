#!/usr/bin/env node
/**
 * Download @vladmandic/face-api model files into api/lib/skin/models/
 * so they're bundled into the Vercel function deployment.
 *
 * Runs as part of `npm install` via the "postinstall" script. Vercel runs
 * `npm install` during every build, so the models end up in the
 * deployment artifact and load from local disk at runtime — no slow
 * cold-start downloads, no CDN dependency.
 *
 * The files we need (from @vladmandic/face-api's GitHub releases):
 *   - ssd_mobilenetv1_model-weights_manifest.json + shards (face detector)
 *   - face_landmark_68_model-weights_manifest.json + shards (68 landmarks)
 *   - age_gender_model-weights_manifest.json + shards (gender classifier)
 *
 * Skip if files already exist — keeps local dev npm-install fast.
 */

import {
  mkdirSync,
  existsSync,
  createWriteStream,
  statSync,
  copyFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(__dirname);
const MODEL_DIR = join(REPO_ROOT, "api", "lib", "skin", "models");

// -------------------------------------------------------------------
// Patch face-api for Node ESM compatibility
// -------------------------------------------------------------------
// @vladmandic/face-api ships `dist/face-api.esm-nobundle.js` with ESM
// `import`/`export` syntax, BUT face-api's own package.json doesn't
// declare `"type": "module"`. Node uses the nearest package.json to
// decide how to interpret a .js file, so when we deep-import this file
// from our ESM code, Node falls back to CommonJS rules and throws
// "Cannot use import statement outside a module."
//
// Fix: create a .mjs sibling. Node always treats .mjs as ESM regardless
// of parent package.json. Vercel's bundler picks up the .mjs file at
// trace time because our import path references it.
const FACE_API_DIST = join(
  REPO_ROOT,
  "node_modules",
  "@vladmandic",
  "face-api",
  "dist",
);
const FACE_API_SRC = join(FACE_API_DIST, "face-api.esm-nobundle.js");
const FACE_API_MJS = join(FACE_API_DIST, "face-api.esm-nobundle.mjs");
if (existsSync(FACE_API_SRC) && !existsSync(FACE_API_MJS)) {
  try {
    copyFileSync(FACE_API_SRC, FACE_API_MJS);
    console.log(
      "face-api: patched dist/face-api.esm-nobundle.js → .mjs for Node ESM",
    );
  } catch (err) {
    console.warn(
      "face-api: failed to create .mjs sibling — skin pre-filter may fail at runtime:",
      err.message,
    );
  }
}

// -------------------------------------------------------------------
// Patch @tensorflow/tfjs* packages so Node treats their .js files as ESM
// -------------------------------------------------------------------
// face-api.esm-nobundle.mjs imports `from '@tensorflow/tfjs'` which Node
// resolves to .../tfjs/dist/index.js. That file uses ESM `import` syntax
// but the package's own package.json lacks `"type": "module"`, so Node
// falls back to CommonJS rules and throws "Failed to load the ES module."
//
// Fix: add `"type": "module"` to the package.json of each tfjs sub-package
// we depend on. This is the same nearest-package-json mechanism we used
// for face-api itself, just applied to one more layer down. Idempotent —
// re-reading and re-writing the same value is a no-op.
//
// The packages we patch are exactly the ones face-api.esm-nobundle.mjs
// imports. If face-api ever adds a new tfjs dependency we'll see another
// "Failed to load ES module" error pointing at it, and we can add it here.
import { readFileSync, writeFileSync } from "node:fs";

const TFJS_PACKAGES_TO_PATCH = [
  "@tensorflow/tfjs",
  "@tensorflow/tfjs-core",
  "@tensorflow/tfjs-backend-cpu",
  "@tensorflow/tfjs-backend-wasm",
  "@tensorflow/tfjs-converter",
  "@tensorflow/tfjs-layers",
  "@tensorflow/tfjs-data",
];

for (const pkgName of TFJS_PACKAGES_TO_PATCH) {
  const pkgJsonPath = join(REPO_ROOT, "node_modules", pkgName, "package.json");
  if (!existsSync(pkgJsonPath)) {
    // Package isn't actually installed (some are transitive deps and may
    // or may not be present). Skip silently.
    continue;
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    if (pkg.type === "module") {
      // Already patched — idempotent re-run
      continue;
    }
    pkg.type = "module";
    writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + "\n");
    console.log(`tfjs: patched ${pkgName}/package.json → "type": "module"`);
  } catch (err) {
    console.warn(
      `tfjs: failed to patch ${pkgName}/package.json — skin pre-filter may fail at runtime:`,
      err.message,
    );
  }
}

// vladmandic/face-api keeps the models in its npm package, so the raw
// GitHub URL is stable. Each model has a manifest.json + 1 or more
// binary "shard" files (typically *.bin).
const BASE = "https://raw.githubusercontent.com/vladmandic/face-api/master/model";

const FILES = [
  // SSD MobileNet v1 face detector
  "ssd_mobilenetv1_model-weights_manifest.json",
  "ssd_mobilenetv1_model.bin",
  // 68-point landmark detector
  "face_landmark_68_model-weights_manifest.json",
  "face_landmark_68_model.bin",
  // Age + gender classifier
  "age_gender_model-weights_manifest.json",
  "age_gender_model.bin",
];

mkdirSync(MODEL_DIR, { recursive: true });

let downloaded = 0;
let skipped = 0;
const failed = [];

for (const name of FILES) {
  const dest = join(MODEL_DIR, name);
  if (existsSync(dest)) {
    const size = statSync(dest).size;
    if (size > 0) {
      skipped++;
      continue;
    }
    // Empty file — re-download
  }

  const url = `${BASE}/${name}`;
  process.stdout.write(`Downloading ${name}... `);
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
    await pipeline(resp.body, createWriteStream(dest));
    const size = statSync(dest).size;
    console.log(`${(size / 1024).toFixed(1)} KB`);
    downloaded++;
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    failed.push({ name, err: err.message });
  }
}

console.log(
  `face-api models: ${downloaded} downloaded, ${skipped} cached, ${failed.length} failed`,
);

if (failed.length > 0) {
  // Don't crash the build — the skin pre-filter falls back gracefully
  // when model files are missing. But log loudly so it doesn't slip
  // through unnoticed.
  console.error("\n  ⚠️  Some face-api models failed to download.");
  console.error("  The Glam/Polished skin pre-filter will be DISABLED");
  console.error("  until these files are present. Generation still works.");
  for (const { name, err } of failed) {
    console.error(`    - ${name}: ${err}`);
  }
}
