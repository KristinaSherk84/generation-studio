/**
 * 68-point face landmark detection via @vladmandic/face-api.
 *
 * Why this lib: it's the Node.js port of face-api.js, returning the exact
 * same 68 landmark indices as dlib's shape_predictor_68_face_landmarks.dat
 * model — same regions, same point ordering. The bundled weights are
 * MIT-licensed (vs. dlib's iBUG-trained model which excludes commercial
 * use), so safe to ship in a paid product.
 *
 * Landmark indices (matches dlib's 68-point scheme):
 *   [0..16]  jawline (left ear → chin → right ear, 17 points)
 *   [17..21] right eyebrow (subject's right) — 5 points
 *   [22..26] left eyebrow — 5 points
 *   [27..30] nose bridge — 4 vertical points
 *   [31..35] nose bottom + nostrils — 5 points
 *   [36..41] right eye outline — 6 points
 *   [42..47] left eye outline — 6 points
 *   [48..59] outer mouth — 12 points
 *   [60..67] inner mouth — 8 points
 *
 * Model files must be present at MODEL_DIR. They get there via the npm
 * postinstall script in scripts/download-face-api-models.mjs.
 */

// 2026-05-14: switched from ESM imports to createRequire after a week of
// chasing Node ESM/CJS interop errors. Full history of failed attempts:
//
//   1. import "@vladmandic/face-api" (default Node entry)
//      → required @tensorflow/tfjs-node which pushed function over 250MB
//
//   2. import * as faceapi from "@vladmandic/face-api/dist/face-api.esm-nobundle.mjs"
//      + import * as tf from "@tensorflow/tfjs"
//      → "Failed to load ES module: tfjs/dist/index.js"
//
//   3. + postinstall patch @tensorflow/tfjs* to "type": "module"
//      → module loaded but ESM export surface broken: tf.setBackend,
//        tf.ready, tf.getBackend, tf.tensor3d all undefined. Pre-filter
//        silently disabled on every cold start, ran with raw references
//        for entire lifetime of feature.
//
//   4. switched to import * as tf from "@tensorflow/tfjs-core"
//      → same problem one layer deeper; tfjs-core ESM surface also
//        empty after the package.json patch
//
// Insight: Node's "type": "module" forces ESM parsing on CJS-shaped dist
// files. The resulting namespace has no named exports because CJS's
// `Object.defineProperty(exports, ...)` calls don't generate ESM
// bindings. Every path that depends on ESM resolution of @tensorflow/*
// from Vercel's serverless sandbox runs into this.
//
// Current approach: don't resolve @tensorflow/* as ESM at all. face-api
// ships a UMD bundle at dist/face-api.js that has tfjs-core + the CPU
// backend baked in and exposes the tf instance via `faceapi.tf`. Load
// it via `createRequire` (Node's bridge for using CJS from ESM) and we
// never trigger Node's ESM resolution for tfjs. No patches needed.
import { createRequire } from "node:module";
const requireCjs = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const faceapi: any = requireCjs("@vladmandic/face-api/dist/face-api.js");
// face-api exposes its bundled tfjs instance here so callers can run
// tensor ops + manage backends without a separate tfjs install.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tf: any = faceapi.tf;

import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

export type Point = { x: number; y: number };

export type Landmarks = {
  /** Exactly 68 (x, y) coordinates in pixel space of the input image. */
  points: Point[];
  /** Detected gender. Used to pick the smoothing intensity tier. */
  gender: "male" | "female";
  /** Confidence score [0..1] for the gender detection. */
  genderProbability: number;
  /** Face bounding box in pixel space (for sanity checks). */
  faceBox: { x: number; y: number; width: number; height: number };
};

/**
 * Where face-api looks for its model JSON+weight files. Computed
 * relative to this source file (which Vercel will bundle into the same
 * directory tree), with process.cwd() as a fallback for local dev where
 * import.meta might not resolve to the source-tree path.
 *
 * Vercel needs `includeFiles: "api/lib/skin/models/**"` in vercel.json
 * to actually copy the model files into the function deployment — the
 * default node-file-trace bundler doesn't pick up runtime-loaded files.
 */
const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const MODEL_DIR_PRIMARY = path.join(SOURCE_DIR, "models");
const MODEL_DIR_FALLBACK = path.join(
  process.cwd(),
  "api",
  "lib",
  "skin",
  "models",
);

async function resolveModelDir(): Promise<string | null> {
  // Try the source-relative path first (works on Vercel + most local setups)
  try {
    await fs.access(
      path.join(MODEL_DIR_PRIMARY, "face_landmark_68_model-weights_manifest.json"),
    );
    return MODEL_DIR_PRIMARY;
  } catch {
    // Fall through to cwd-relative
  }
  try {
    await fs.access(
      path.join(
        MODEL_DIR_FALLBACK,
        "face_landmark_68_model-weights_manifest.json",
      ),
    );
    return MODEL_DIR_FALLBACK;
  } catch {
    return null;
  }
}

let modelsLoaded = false;
let modelLoadPromise: Promise<void> | null = null;
let cachedModelDir: string | null = null;

/**
 * Load the three face-api models we use, exactly once per Vercel function
 * cold start. Subsequent calls in the same warm function reuse the cached
 * weights — no repeated disk reads.
 */
async function ensureModelsLoaded(modelDir: string): Promise<void> {
  if (modelsLoaded) return;
  if (modelLoadPromise) return modelLoadPromise;

  modelLoadPromise = (async () => {
    // face-api.js was originally a browser library; in Node we have to
    // wire the TFJS backend manually before loading models. We use
    // @tensorflow/tfjs (the browser bundle, which also works in Node)
    // to keep the function bundle small — tfjs-node would pull ~30MB
    // of native bindings we don't need for our throughput.
    console.log("[skin] initializing TFJS CPU backend...");
    await tf.setBackend("cpu");
    await tf.ready();
    console.log(`[skin] TFJS ready (backend: ${tf.getBackend()}); loading face-api models from ${modelDir}`);

    await Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromDisk(modelDir),
      faceapi.nets.faceLandmark68Net.loadFromDisk(modelDir),
      faceapi.nets.ageGenderNet.loadFromDisk(modelDir),
    ]);
    modelsLoaded = true;
    console.log("[skin] face-api models loaded successfully");
  })();

  try {
    await modelLoadPromise;
  } catch (err) {
    // Reset so the next caller can retry rather than getting the same
    // failed promise forever.
    modelLoadPromise = null;
    throw err;
  }
}

/**
 * Detect 68-point landmarks and gender on a single face in `imageBytes`.
 * Returns null if no face is found, the model files are missing, or the
 * library throws an unexpected error. The caller should fall back to
 * "no smoothing" in that case rather than failing the whole generation.
 */
export async function detectLandmarks(
  imageBytes: Buffer,
): Promise<Landmarks | null> {
  try {
    if (!cachedModelDir) {
      cachedModelDir = await resolveModelDir();
      if (!cachedModelDir) {
        console.warn(
          `[skin] face-api model files NOT FOUND in either ${MODEL_DIR_PRIMARY} or ${MODEL_DIR_FALLBACK} — pre-filter disabled. Did the postinstall script run? Did vercel.json includeFiles work?`,
        );
        return null;
      }
      console.log(`[skin] using face-api model dir: ${cachedModelDir}`);
    }
    await ensureModelsLoaded(cachedModelDir);

    // face-api expects an HTMLImageElement-like object, OR raw RGB pixel
    // data. We use Sharp to decode the bytes into a known-good RGB raw
    // buffer at a sensible size, then hand the pixels to TFJS directly.
    const FACE_API_INPUT_MAX = 640; // longest side of input to face-api
    const decoded = await sharp(imageBytes)
      .rotate() // honor EXIF orientation
      .resize(FACE_API_INPUT_MAX, FACE_API_INPUT_MAX, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data: pixels, info } = decoded;
    const w = info.width;
    const h = info.height;

    // Build a TFJS tensor [height, width, channels=3] from the raw RGB
    // buffer. tf.tensor3d expects Uint8Array → it will normalize to
    // float32 internally as the model needs.
    const tensor = tf.tensor3d(new Uint8Array(pixels), [h, w, 3], "int32");

    // ssdMobilenetv1 is the face detector. Default options work fine for
    // a single-face portrait reference photo.
    const result = await faceapi
      .detectSingleFace(
        tensor as unknown as faceapi.TNetInput,
        new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }),
      )
      .withFaceLandmarks()
      .withAgeAndGender();

    tensor.dispose();

    if (!result) {
      console.warn("[skin] detectLandmarks: no face found in reference photo");
      return null;
    }

    const points = result.landmarks.positions.map((p) => ({ x: p.x, y: p.y }));
    if (points.length !== 68) {
      console.warn(
        `[detectLandmarks] unexpected landmark count: ${points.length}`,
      );
      return null;
    }

    // We need landmarks in the coordinate space of the ORIGINAL image
    // (not the downscaled-for-detection image), since the caller will
    // build a mask at full resolution and apply it to the original.
    // Scale all landmark x/y by the inverse of Sharp's resize factor.
    const origMeta = await sharp(imageBytes).rotate().metadata();
    const origW = origMeta.width ?? w;
    const origH = origMeta.height ?? h;
    const sx = origW / w;
    const sy = origH / h;
    const scaledPoints = points.map((p) => ({ x: p.x * sx, y: p.y * sy }));

    const box = result.detection.box;
    return {
      points: scaledPoints,
      gender: result.gender === "male" ? "male" : "female",
      genderProbability: result.genderProbability,
      faceBox: {
        x: box.x * sx,
        y: box.y * sy,
        width: box.width * sx,
        height: box.height * sy,
      },
    };
  } catch (err) {
    console.warn(
      "[detectLandmarks] failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
