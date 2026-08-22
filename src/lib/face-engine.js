// src/lib/face-engine.js
//
// Server-side face analysis. This is the trust boundary: descriptors and
// liveness signals are computed HERE from raw uploaded frames, never taken on
// faith from the client. Uses @vladmandic/face-api on the pure-JS WASM tfjs
// backend - no native addon to compile, so it installs and deploys on any
// Node/platform (tfjs-node's prebuilt binaries lag new Node versions).
//
// Model weights are NOT in node_modules; they live under FACE_MODELS_PATH (the
// repo's ./models). Models + backend load once,
// lazily, so a process that never verifies a check-in never pays the cost.
import path from "node:path";
import { createRequire } from "node:module";
import * as tf from "@tensorflow/tfjs";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import * as faceapi from "@vladmandic/face-api/dist/face-api.node-wasm.js";
import { createCanvas, loadImage, Canvas, Image, ImageData } from "@napi-rs/canvas";
import ENV from "../config/env.js";
import logger from "../utils/logger.js";
import { LIVENESS } from "../config/constants.js";

const require = createRequire(import.meta.url);
const WASM_DIR =
  path.dirname(require.resolve("@tensorflow/tfjs-backend-wasm/package.json")) +
  path.sep +
  "dist" +
  path.sep;

// face-api constructs its working canvases with `new Canvas()` (no args) when
// cropping detected faces, which @napi-rs/canvas rejects. A subclass that
// defaults the dimensions (they are resized immediately after) bridges the two
// while staying `instanceof Canvas` for face-api's own type checks.
class CompatCanvas extends Canvas {
  constructor(width = 1, height = 1) {
    super(width, height);
  }
}

let backendReady = null;
let modelsReady = null;

/** Brings up the WASM backend + node canvas shims once. */
function ensureBackend() {
  if (backendReady) return backendReady;
  faceapi.env.monkeyPatch({ Canvas: CompatCanvas, Image, ImageData });
  setWasmPaths(WASM_DIR);
  backendReady = tf
    .setBackend("wasm")
    .then(() => tf.ready())
    .then(() => logger.info("Face engine backend ready (wasm)"));
  return backendReady;
}

/** Loads the four nets once. Concurrent callers await the same promise. */
export function loadFaceModels() {
  if (modelsReady) return modelsReady;
  const dir = ENV.FACE_MODELS_PATH;
  modelsReady = ensureBackend()
    .then(() =>
      Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromDisk(dir),
        faceapi.nets.faceLandmark68Net.loadFromDisk(dir),
        faceapi.nets.faceRecognitionNet.loadFromDisk(dir),
        faceapi.nets.faceExpressionNet.loadFromDisk(dir),
      ])
    )
    .then(() => logger.info("Face models loaded"))
    .catch((error) => {
      // Reset so a later call can retry rather than latch a rejected promise.
      modelsReady = null;
      throw error;
    });
  return modelsReady;
}

// scoreThreshold is deliberately low: during a TURN step the face is angled and
// the tiny detector's confidence drops, so a 0.5 bar silently drops exactly
// the turned frames the step needs (surfacing as insufficient_usable_frames).
// 0.3 keeps those usable while still rejecting non-faces.
const detectorOptions = () =>
  new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.3 });

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Eye-aspect-ratio for one eye (6 landmarks). Small when the eye is closed;
 * a blink is a dip in this value across the frame sequence.
 */
function eyeAspectRatio(p) {
  const vertical = dist(p[1], p[5]) + dist(p[2], p[4]);
  const horizontal = 2 * dist(p[0], p[3]);
  return horizontal === 0 ? 0 : vertical / horizontal;
}

/**
 * A crude but robust head-yaw proxy from the 68-point mesh: how far the nose
 * tip sits toward one cheek vs the other, normalized and scaled to ~degrees.
 * We use it only for MAGNITUDE and SIGN (turned vs forward, one way vs the
 * other); we deliberately do not map sign to absolute "left"/"right" because
 * front cameras mirror inconsistently. Positive vs negative just means "the
 * two turns went opposite ways", which is what proves head movement.
 */
function estimateYaw(points) {
  const noseTip = points[30];
  const leftCheek = points[0];
  const rightCheek = points[16];
  const distLeft = noseTip.x - leftCheek.x;
  const distRight = rightCheek.x - noseTip.x;
  const total = distLeft + distRight;
  if (total <= 0) return 0;
  const asymmetry = (distRight - distLeft) / total; // -1..1
  return asymmetry * 90;
}

/** Decodes an image buffer to a canvas face-api can read (jpeg/png/webp). */
async function bufferToCanvas(buffer) {
  const image = await loadImage(buffer);
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext("2d").drawImage(image, 0, 0);
  return canvas;
}

/**
 * Analyzes one frame buffer. Returns null when no single clear face is found
 * (a frame with zero or many faces is unusable, not an error). Otherwise
 * returns the geometric liveness signals, and the 128-float identity descriptor
 * when `withDescriptor` is set.
 *
 * The descriptor comes from the face-recognition net - by far the heaviest model
 * in the pipeline (~6MB vs <1MB for the others) - so skipping it on frames that
 * are only needed for the action signals (yaw/ear/happy) cuts per-frame cost
 * dramatically. Identity is still proven from the frames that DO carry one.
 */
export async function analyzeFrame(buffer, { withDescriptor = true } = {}) {
  await loadFaceModels();

  let canvas;
  try {
    canvas = await bufferToCanvas(buffer);
  } catch {
    return null; // Undecodable frame is treated as unusable, not fatal.
  }

  const base = faceapi
    .detectSingleFace(canvas, detectorOptions())
    .withFaceLandmarks()
    .withFaceExpressions();
  const detection = withDescriptor ? await base.withFaceDescriptor() : await base;

  if (!detection) return null;

  const points = detection.landmarks.positions;
  const leftEye = [36, 37, 38, 39, 40, 41].map((i) => points[i]);
  const rightEye = [42, 43, 44, 45, 46, 47].map((i) => points[i]);
  const ear = (eyeAspectRatio(leftEye) + eyeAspectRatio(rightEye)) / 2;

  return {
    descriptor: detection.descriptor ? Array.from(detection.descriptor) : null,
    yaw: estimateYaw(points),
    ear,
    happy: detection.expressions?.happy ?? 0,
    score: detection.detection.score,
  };
}

/**
 * Analyzes many frames, dropping unusable ones. Kept sequential on purpose:
 * concurrent WASM inference contends for the same threads and balloons peak
 * memory for no throughput gain on a check-in-sized batch.
 *
 * `descriptorStride` computes the (heavy) identity descriptor on only every Nth
 * frame - plus always the last one - so the action signals still come from every
 * frame while identity is sampled across the burst. Stride 1 (the default) keeps
 * the descriptor on every frame, matching the batch flow.
 */
export async function analyzeFrames(buffers, { descriptorStride = 1 } = {}) {
  const results = [];
  const last = buffers.length - 1;
  for (let i = 0; i < buffers.length; i++) {
    const withDescriptor =
      descriptorStride <= 1 || i % descriptorStride === 0 || i === last;
    const frame = await analyzeFrame(buffers[i], { withDescriptor });
    if (frame) results.push(frame);
  }
  return results;
}

export { LIVENESS };
