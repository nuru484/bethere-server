// src/services/liveness/evaluate.js
//
// The liveness DECISION, kept pure and dependency-free (plain numbers in, a
// verdict out) so it is unit-testable without the ML engine, a camera, or a
// database. The engine (lib/face-engine.js) turns frames into the per-frame
// signals this consumes; swapping the engine (e.g. for AWS) does not touch
// this logic.
import { euclideanDistance } from "../../utils/face-match.js";
import { LIVENESS } from "../../config/constants.js";

/**
 * Two frames whose descriptors are identical to within floating-point noise are
 * the SAME IMAGE submitted twice. Distinct photographs of the same person never
 * land this close, so the threshold is deliberately tiny: it catches re-sent
 * stills without ever rejecting a genuine burst.
 */
const IDENTICAL_FRAME_DISTANCE = 1e-6;

function hasDuplicateFrames(frames) {
  const hasTwin = new Array(frames.length).fill(false);

  // Each unordered pair is compared once; a match marks both members.
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) {
      const distance = euclideanDistance(
        frames[i].descriptor,
        frames[j].descriptor
      );
      if (distance <= IDENTICAL_FRAME_DISTANCE) {
        hasTwin[i] = true;
        hasTwin[j] = true;
      }
    }
  }
  const withTwin = hasTwin.filter(Boolean).length;

  // Only a MAJORITY of repeated images is called replay. A camera that stalls
  // and emits one duplicate frame must not fail an otherwise genuine capture.
  return withTwin > frames.length / 2;
}

const isTurn = (action) => action === "TURN_LEFT" || action === "TURN_RIGHT";

/** Value at percentile p (0..1) of a numeric list, nearest-rank. */
function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round(p * (sorted.length - 1)))
  );
  return sorted[index];
}

/**
 * The user's own open-eye EAR baseline and the derived closed / reopened
 * thresholds for THIS burst. Open eyes dominate a capture, so a high percentile
 * of the per-frame EARs is a robust "eyes open" reference that self-calibrates
 * to the person and camera (narrow eyes, glasses, tilt) instead of a fixed EAR
 * that works for some faces and is unreachable for others.
 */
function blinkThresholds(frames) {
  const ears = frames.map((f) => f.ear ?? 0);
  const openBaseline = percentile(ears, 0.6);
  // A degenerate baseline (no plausibly-open frame) falls back to the absolute
  // floor so the closed test still means something.
  const usableBaseline = openBaseline > LIVENESS.EYE_CLOSED_EAR;
  const closed = usableBaseline
    ? openBaseline * LIVENESS.BLINK_CLOSE_RATIO
    : LIVENESS.EYE_CLOSED_EAR;
  const reopened = usableBaseline
    ? openBaseline * LIVENESS.BLINK_REOPEN_RATIO
    : LIVENESS.EYE_CLOSED_EAR * 1.2;
  return { closed, reopened };
}

/** Spread (max - min) of one per-frame signal across the burst. */
function signalRange(frames, key) {
  let min = Infinity;
  let max = -Infinity;
  for (const f of frames) {
    const v = f[key] ?? 0;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return max - min;
}

/**
 * Fraction of frames that are NOT a near-duplicate of an earlier frame. A live
 * burst is almost entirely novel frames; a padded one (a couple of real frames
 * plus filler stills) is not.
 */
function distinctRatio(frames) {
  let novel = 0;
  for (let i = 0; i < frames.length; i++) {
    const isDup = frames
      .slice(0, i)
      .some(
        (earlier) =>
          euclideanDistance(frames[i].descriptor, earlier.descriptor) <=
          IDENTICAL_FRAME_DISTANCE
      );
    if (!isDup) novel++;
  }
  return novel / frames.length;
}

/**
 * The "it actually moved" gate. Proving each action fired once (in order) is
 * necessary but not sufficient: a still photo held at an angle clears the turn
 * threshold on every frame yet never MOVES. So when an action is challenged,
 * the signal it drives must show real range, and the burst must be mostly
 * distinct frames. Returns the reasons to add (empty when the motion looks
 * live).
 *
 * NOTE ON SCOPE: this raises the bar against photo / static / padded replays.
 * It does NOT defeat a pre-recorded VIDEO of the real person - a video moves
 * too, and nothing in a client-uploaded frame proves the pixels came from a
 * live camera rather than a file. Closing that residual needs presentation-
 * attack detection (screen/replay/depth), which is exactly what a certified
 * liveness vendor slotted behind liveness-verifier.js provides.
 */
function motionReasons(frames, actions) {
  const reasons = [];
  const add = (reason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  if (actions.some(isTurn) && signalRange(frames, "yaw") < LIVENESS.YAW_TURN_DEGREES) {
    add("insufficient_motion");
  }
  if (actions.includes("SMILE") && signalRange(frames, "happy") < LIVENESS.SMILE_MIN_RANGE) {
    add("insufficient_motion");
  }
  if (actions.includes("BLINK") && signalRange(frames, "ear") < LIVENESS.EAR_MIN_RANGE) {
    add("insufficient_motion");
  }
  if (distinctRatio(frames) < LIVENESS.MIN_DISTINCT_RATIO) {
    add("insufficient_variation");
  }

  return reasons;
}

/**
 * Walks the burst in capture order and proves each action strictly after the
 * previous one. Returns the actions that could not be proven in sequence.
 *
 * A blink is a TRANSITION, not a state, so it needs a closed frame followed by
 * an open one. Turn direction is still not bound to the LEFT/RIGHT label
 * (front cameras mirror inconsistently), but a second turn must go the opposite
 * way from the first, which no single still can fake.
 */
function proveActionsInOrder(frames, actions) {
  const failed = [];
  let cursor = 0;
  const turnActions = actions.filter(isTurn);
  const isTurnFrame = (f) => Math.abs(f.yaw) >= LIVENESS.YAW_TURN_DEGREES;
  const { closed: earClosed, reopened: earReopened } = blinkThresholds(frames);

  for (const action of actions) {
    if (action === "BLINK") {
      let closedAt = -1;
      for (let i = cursor; i < frames.length; i++) {
        if (frames[i].ear < earClosed) {
          closedAt = i;
          break;
        }
      }
      let openedAt = -1;
      for (let i = closedAt + 1; closedAt !== -1 && i < frames.length; i++) {
        if (frames[i].ear > earReopened) {
          openedAt = i;
          break;
        }
      }
      if (openedAt === -1) {
        failed.push("BLINK");
      } else {
        // Advance past the CLOSURE (the distinctive event), not the recovery:
        // the frame where the eyes reopen can legitimately be the same frame
        // the next action starts in (reopening and smiling can coincide when
        // prompts run back to back). Order is still enforced.
        cursor = closedAt + 1;
      }
      continue;
    }

    if (action === "SMILE") {
      let at = -1;
      for (let i = cursor; i < frames.length; i++) {
        if (frames[i].happy >= LIVENESS.SMILE_PROBABILITY) {
          at = i;
          break;
        }
      }
      if (at === -1) failed.push("SMILE");
      else cursor = at + 1;
      continue;
    }

    if (isTurn(action)) {
      let at = -1;
      for (let i = cursor; i < frames.length; i++) {
        if (isTurnFrame(frames[i])) {
          at = i;
          break;
        }
      }
      if (at === -1) failed.push(action);
      else cursor = at + 1;
    }
  }

  // A PAIR of turns must go opposite ways somewhere in the burst - that is the
  // part no single still can fake. It is checked across the whole burst rather
  // than latched from the first qualifying frame: the very first frame is
  // grabbed the instant capture starts, before the user has reacted, so an
  // incidental glance would otherwise lock the direction and make a genuine
  // left-then-right impossible to satisfy.
  if (turnActions.length >= 2) {
    const turned = frames.filter(isTurnFrame);
    const reversed =
      turned.some((f) => f.yaw > 0) && turned.some((f) => f.yaw < 0);
    if (!reversed) failed.push(turnActions[turnActions.length - 1]);
  }

  return failed;
}

/** Sign of the most-turned frame in a burst (+1 one way, -1 the other). */
function stepTurnSign(frames) {
  let extreme = 0;
  for (const f of frames) {
    if (Math.abs(f.yaw ?? 0) > Math.abs(extreme)) extreme = f.yaw ?? 0;
  }
  return extreme >= 0 ? 1 : -1;
}

/**
 * Proves a SINGLE action from one dense per-step burst. Unlike the batch flow,
 * the frames here were captured specifically for this one action, so a blink is
 * sampled tightly enough to catch its ~200ms dip and a turn brackets forward ->
 * turned within the step. Returns true when the action is demonstrated.
 */
function proveSingleAction(frames, action) {
  if (action === "BLINK") {
    // A blink is a DIP below the user's own open-eye baseline. We only require
    // the dip to be present (not a reopen frame captured strictly after it),
    // because a blink at the end of the burst would otherwise be missed, and a
    // photo has no dip at all (constant EAR) so the dip alone is unfakeable.
    // The bar is tuned to real webcam output: the 68-point EAR swings only
    // modestly on closure, so an ideal-closed-eye threshold is unreachable.
    const ears = frames.map((f) => f.ear ?? 0);
    // 70th percentile as the open baseline - matches the earOpen the diagnostics
    // report, so the dip bar lines up with observed real output.
    const openBaseline = percentile(ears, 0.7);
    const dip =
      openBaseline > LIVENESS.EYE_CLOSED_EAR
        ? openBaseline * LIVENESS.BLINK_STEP_DIP_RATIO
        : LIVENESS.EYE_CLOSED_EAR;
    return Math.min(...ears) < dip;
  }

  if (action === "SMILE") {
    return frames.some((f) => (f.happy ?? 0) >= LIVENESS.SMILE_PROBABILITY);
  }

  if (isTurn(action)) {
    // A real turn sweeps forward -> turned, so a peak past the turn bar AND some
    // range prove movement; a held photo at an angle has one fixed yaw (range 0).
    // The range bar is smaller than the peak because the most-turned frames are
    // often dropped by the detector, leaving forward + partially-turned frames.
    const turned = frames.some(
      (f) => Math.abs(f.yaw ?? 0) >= LIVENESS.YAW_TURN_DEGREES
    );
    return turned && signalRange(frames, "yaw") >= LIVENESS.YAW_STEP_RANGE;
  }

  return false;
}

/**
 * PII-safe per-step signal aggregates (no descriptors), logged on a step failure
 * so real webcam output can be seen and the thresholds calibrated against it.
 */
function stepSignals(frames) {
  const round = (n) => Math.round(n * 1000) / 1000;
  const yaws = frames.map((f) => f.yaw ?? 0);
  const ears = frames.map((f) => f.ear ?? 0);
  const happies = frames.map((f) => f.happy ?? 0);
  return {
    frames: frames.length,
    yawMin: round(Math.min(...yaws)),
    yawMax: round(Math.max(...yaws)),
    yawRange: round(Math.max(...yaws) - Math.min(...yaws)),
    earMin: round(Math.min(...ears)),
    earOpen: round(percentile(ears, 0.7)),
    happyMax: round(Math.max(...happies)),
  };
}

/**
 * The step-by-step DECISION for ONE action. Pure like evaluateLiveness, but
 * scoped to a single action's dense capture, so the client can verify each step
 * before prompting the next.
 *
 * Identity is re-checked on every step: against the ENROLLED template for a
 * check-in (so no step can be a different person), and against the step-0
 * REFERENCE descriptor for enrollment (which has no template yet). A two-turn
 * challenge passes the FIRST turn's sign back in; the opposite turn must reverse
 * it. Returns the step verdict plus the medoid descriptor (accumulated across
 * steps to derive the enrollment template) and this step's turn sign.
 *
 * @returns { passed, reasons, descriptor, turnSign, matchDistance }
 */
export function evaluateAction(
  frames,
  action,
  { enrolled = null, reference = null, firstTurnSign = null, matchThreshold }
) {
  const reasons = [];
  const add = (reason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  if (frames.length < LIVENESS.MIN_STEP_FRAMES) {
    return {
      passed: false,
      reasons: ["insufficient_usable_frames"],
      descriptor: null,
      turnSign: null,
      matchDistance: null,
      // How many frames survived face detection - the diagnostic that matters
      // for this reason (the rest of the burst had 0 or >1 faces per frame).
      signals: { usableFrames: frames.length },
    };
  }

  // Identity is checked on the frames that carry a descriptor (the heavy net is
  // sampled across the burst, not run on every frame); the action signals below
  // use ALL frames. A step with too few descriptor frames cannot be trusted.
  const idFrames = frames.filter((f) => Array.isArray(f.descriptor));
  if (idFrames.length < LIVENESS.MIN_STEP_ID_FRAMES) {
    return {
      passed: false,
      reasons: ["insufficient_usable_frames"],
      descriptor: null,
      turnSign: null,
      matchDistance: null,
      signals: { usableFrames: frames.length, idFrames: idFrames.length },
    };
  }

  // --- Identity against the enrolled template (check-in only). ---
  let matchDistance = null;
  if (enrolled) {
    const distances = idFrames.map((f) =>
      euclideanDistance(f.descriptor, enrolled)
    );
    matchDistance = Math.min(...distances);
    if (matchDistance <= LIVENESS.REPLAY_MIN_DISTANCE) add("replay_suspected");
    if (distances.filter((d) => d <= matchThreshold).length / idFrames.length < 0.6) {
      add("identity_mismatch");
    }
    if (distances.some((d) => d > LIVENESS.CONTINUITY_MAX_DISTANCE)) {
      add("identity_discontinuity");
    }
  }

  // --- Identity against the step-0 reference (enrollment continuity). ---
  if (reference) {
    const distances = idFrames.map((f) =>
      euclideanDistance(f.descriptor, reference)
    );
    if (distances.filter((d) => d <= matchThreshold).length / idFrames.length < 0.6) {
      add("identity_mismatch");
    }
    if (distances.some((d) => d > LIVENESS.CONTINUITY_MAX_DISTANCE)) {
      add("identity_discontinuity");
    }
  }

  // --- One person WITHIN this step (no mid-step swap). ---
  const centre = idFrames[medoidIndex(idFrames)].descriptor;
  const clustered = idFrames.filter(
    (f) => euclideanDistance(f.descriptor, centre) <= matchThreshold
  ).length;
  if (clustered / idFrames.length < 0.6) add("inconsistent_identity");

  if (hasDuplicateFrames(idFrames)) add("duplicate_frames");
  if (distinctRatio(idFrames) < LIVENESS.MIN_DISTINCT_RATIO) {
    add("insufficient_variation");
  }

  // --- The action itself. ---
  if (!proveSingleAction(frames, action)) add("action_not_satisfied");

  let turnSign = null;
  if (isTurn(action)) {
    turnSign = stepTurnSign(frames);
    // A second turn must reverse the first - the part no still can fake.
    if (firstTurnSign !== null && turnSign === firstTurnSign) {
      add("action_not_satisfied");
    }
  }

  const passed = reasons.length === 0;
  return {
    passed,
    reasons,
    descriptor: passed ? centre : null,
    turnSign,
    matchDistance,
    signals: stepSignals(frames),
  };
}

/**
 * Derives the enrollment template from the per-step medoid descriptors gathered
 * across a completed step-by-step enrollment, and proves they are one
 * self-consistent person. Mirrors evaluateEnrollment's clustering guarantee for
 * the stepwise flow.
 *
 * @returns { passed, reasons, descriptor }
 */
export function finalizeEnrollment(stepDescriptors, matchThreshold) {
  if (!Array.isArray(stepDescriptors) || stepDescriptors.length === 0) {
    return { passed: false, reasons: ["insufficient_usable_frames"], descriptor: null };
  }
  const asFrames = stepDescriptors.map((descriptor) => ({ descriptor }));
  const centre = stepDescriptors[medoidIndex(asFrames)];
  const clustered = stepDescriptors.filter(
    (d) => euclideanDistance(d, centre) <= matchThreshold
  ).length;
  if (clustered / stepDescriptors.length < 0.8) {
    return { passed: false, reasons: ["inconsistent_identity"], descriptor: null };
  }
  return { passed: true, reasons: [], descriptor: centre };
}

/** Index of the frame closest to all the others - the most representative
 * capture in the burst, and a real observed descriptor rather than an average
 * of poses. */
function medoidIndex(frames) {
  let best = 0;
  let bestTotal = Infinity;

  for (let i = 0; i < frames.length; i++) {
    let total = 0;
    for (let j = 0; j < frames.length; j++) {
      if (i === j) continue;
      total += euclideanDistance(frames[i].descriptor, frames[j].descriptor);
    }
    if (total < bestTotal) {
      bestTotal = total;
      best = i;
    }
  }

  return best;
}

/**
 * The ENROLLMENT decision. There is no stored template to compare against yet,
 * so instead of proving "this is the enrolled person" it proves the capture is
 * a live, self-consistent person performing the challenge, and then DERIVES the
 * template from the frames.
 *
 * This is where the trust boundary sits: a descriptor computed in the browser
 * and posted as JSON would mean the server never sees a face at the moment
 * identity is established, and anyone could enroll a template built from a
 * photograph of someone else.
 *
 * @returns { passed, reasons, failedActions, descriptor }
 */
export function evaluateEnrollment(frames, actions, matchThreshold) {
  const reasons = [];

  if (frames.length < LIVENESS.MIN_FRAMES) {
    return {
      passed: false,
      reasons: ["insufficient_usable_frames"],
      failedActions: actions,
      descriptor: null,
    };
  }

  const failedActions = proveActionsInOrder(frames, actions);
  if (failedActions.length > 0) reasons.push("action_not_satisfied");

  if (hasDuplicateFrames(frames)) reasons.push("duplicate_frames");

  // The capture must exhibit live motion, not a held pose.
  reasons.push(...motionReasons(frames, actions));

  // One person throughout: the burst must cluster around its own medoid, so a
  // mid-capture swap cannot blend two faces into a single enrolled template.
  const centre = frames[medoidIndex(frames)].descriptor;
  const clustered = frames.filter(
    (f) => euclideanDistance(f.descriptor, centre) <= matchThreshold
  ).length;
  if (clustered / frames.length < 0.8) reasons.push("inconsistent_identity");

  const passed = reasons.length === 0;

  return {
    passed,
    reasons,
    failedActions: [...new Set(failedActions)],
    descriptor: passed ? centre : null,
  };
}

/**
 * @param {Array<{descriptor:number[],yaw:number,ear:number,happy:number,score:number}>} frames
 * @param {number[]} enrolled - the enrolled 128-float descriptor
 * @param {string[]} actions - the challenge action codes to prove
 * @param {number} matchThreshold - max euclidean distance for an identity match
 * @returns verdict { passed, score, matchDistance, reasons, failedActions, replaySuspected }
 */
export function evaluateLiveness(frames, enrolled, actions, matchThreshold) {
  const reasons = [];
  const failedActions = [];

  if (frames.length < LIVENESS.MIN_FRAMES) {
    return {
      passed: false,
      score: 0,
      matchDistance: null,
      reasons: ["insufficient_usable_frames"],
      failedActions: actions,
      replaySuspected: false,
    };
  }

  // --- Identity: distance of every usable frame to the enrolled template. ---
  const distances = frames.map((f) => euclideanDistance(f.descriptor, enrolled));
  const matchDistance = Math.min(...distances);

  // A perfect (near-zero) match is not a live capture - it is the stored
  // template replayed back. Real second captures always vary a little.
  const replaySuspected = matchDistance <= LIVENESS.REPLAY_MIN_DISTANCE;
  if (replaySuspected) reasons.push("replay_suspected");

  const matchingFrames = distances.filter((d) => d <= matchThreshold).length;
  // Most frames must be the enrolled person, not one lucky frame in a crowd.
  if (matchingFrames / frames.length < 0.6) {
    reasons.push("identity_mismatch");
  }
  // A frame that is a clearly different face mid-sequence means a swap.
  if (distances.some((d) => d > LIVENESS.CONTINUITY_MAX_DISTANCE)) {
    reasons.push("identity_discontinuity");
  }

  // --- Active liveness: prove each requested action IN ORDER. ---
  //
  // Frames arrive in capture order and the client prompts the actions one at a
  // time, so action N must be proven in a frame strictly after action N-1 was
  // proven. Checking the burst as an unordered set (any frame with a closed
  // eye, any frame smiling, ...) would let a fixed handful of stills satisfy
  // EVERY possible challenge draw, making the randomized challenge decorative.
  // Requiring the sequence is what gives the randomization teeth.
  failedActions.push(...proveActionsInOrder(frames, actions));

  if (failedActions.length > 0) reasons.push("action_not_satisfied");

  // Re-submitted stills betray themselves: a live burst never contains two
  // essentially identical frames (same face, same pose, same expression).
  if (hasDuplicateFrames(frames)) reasons.push("duplicate_frames");

  // The challenged signals must actually MOVE (a held photo does not), and the
  // burst must be mostly distinct frames.
  reasons.push(...motionReasons(frames, actions));

  const passed = reasons.length === 0;

  // Confidence: identity margin below threshold blended with the share of
  // actions satisfied and mean detection score. Only meaningful when passed.
  const satisfiedRatio =
    (actions.length - new Set(failedActions).size) / Math.max(actions.length, 1);
  const identityMargin = Math.max(
    0,
    Math.min(1, (matchThreshold - matchDistance) / matchThreshold)
  );
  const meanScore =
    frames.reduce((sum, f) => sum + (f.score ?? 0), 0) / frames.length;
  const score = passed
    ? Number(
        (0.5 * identityMargin + 0.35 * satisfiedRatio + 0.15 * meanScore).toFixed(
          3
        )
      )
    : 0;

  return {
    passed,
    score,
    matchDistance,
    reasons,
    failedActions: [...new Set(failedActions)],
    replaySuspected,
  };
}
