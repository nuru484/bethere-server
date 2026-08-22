// test/unit/evaluate.test.js
//
// The liveness DECISION, tested directly with fabricated per-frame signals so
// the security logic is covered without a camera, ML models, or a database.
import { describe, expect, it } from "vitest";
import { evaluateLiveness } from "../../src/services/liveness/evaluate.js";

const ENROLLED = Array.from({ length: 128 }, () => 0.1);
const near = (delta) => ENROLLED.map((v) => v + delta);
const FAR = ENROLLED.map((v) => v + 0.2); // ~2.26: a different face

// Real captures are never byte-identical, so every fabricated frame gets its
// own slight variation (still comfortably a match, still well clear of the
// exact-replay floor). A burst of identical descriptors is treated as a
// re-sent still, which is exercised deliberately below.
let frameSeq = 0;
const frame = (over = {}) => ({
  descriptor: near(0.04 + (frameSeq++ % 7) * 0.0005),
  yaw: 2,
  ear: 0.35,
  happy: 0.1,
  score: 0.9,
  ...over,
});

// A sequence that satisfies TURN + BLINK + SMILE for the enrolled person.
const goodFrames = () => [
  frame({ yaw: 25 }), // a turn
  frame({ ear: 0.1 }), // blink low point
  frame({ happy: 0.9 }), // smile + eyes open
  frame(),
  frame(),
  frame(),
];

const ACTIONS = ["TURN_LEFT", "BLINK", "SMILE"];

describe("evaluateLiveness", () => {
  it("passes a live, matching, action-satisfying sequence", () => {
    const v = evaluateLiveness(goodFrames(), ENROLLED, ACTIONS, 0.6);
    expect(v.passed).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(v.score).toBeGreaterThan(0);
  });

  it("blocks an exact replay of the enrolled template", () => {
    const frames = goodFrames().map((f) => ({ ...f, descriptor: ENROLLED }));
    const v = evaluateLiveness(frames, ENROLLED, ACTIONS, 0.6);
    expect(v.passed).toBe(false);
    expect(v.replaySuspected).toBe(true);
    expect(v.reasons).toContain("replay_suspected");
  });

  it("blocks a different person (identity mismatch)", () => {
    const frames = goodFrames().map((f) => ({ ...f, descriptor: FAR }));
    const v = evaluateLiveness(frames, ENROLLED, ACTIONS, 0.6);
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("identity_mismatch");
  });

  it("flags a mid-sequence face swap as discontinuity", () => {
    const frames = goodFrames();
    frames[3] = frame({ descriptor: FAR }); // one clearly different face
    const v = evaluateLiveness(frames, ENROLLED, ACTIONS, 0.6);
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("identity_discontinuity");
  });

  it("fails when a required action is not performed (no smile)", () => {
    const frames = goodFrames().map((f) => ({ ...f, happy: 0.1 }));
    const v = evaluateLiveness(frames, ENROLLED, ACTIONS, 0.6);
    expect(v.passed).toBe(false);
    expect(v.failedActions).toContain("SMILE");
    expect(v.reasons).toContain("action_not_satisfied");
  });

  it("requires two opposite turns when both are challenged", () => {
    // Only positive-yaw turns present; the second turn must reverse the first.
    const frames = goodFrames().map((f) => ({ ...f, yaw: 25, ear: 0.35, happy: 0.9 }));
    const v = evaluateLiveness(frames, ENROLLED, ["TURN_LEFT", "TURN_RIGHT"], 0.6);
    expect(v.passed).toBe(false);
    // The first turn is genuinely proven; only the reversal is missing.
    expect(v.failedActions).toEqual(expect.arrayContaining(["TURN_RIGHT"]));
    expect(v.reasons).toContain("action_not_satisfied");
  });

  it("rejects the right actions performed in the WRONG order", () => {
    // Every signal the challenge asks for is present somewhere in the burst,
    // just not in the challenged sequence. A set-wise check passes this, which
    // is what lets one fixed kit of stills satisfy any challenge draw.
    const frames = [
      frame({ happy: 0.9 }), // smiled first
      frame({ ear: 0.1 }), // then blinked
      frame(),
      frame({ yaw: 25 }), // turned last
      frame(),
      frame(),
    ];
    const v = evaluateLiveness(frames, ENROLLED, ACTIONS, 0.6);

    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("action_not_satisfied");
  });

  it("accepts the same actions when performed in the challenged order", () => {
    const frames = [
      frame({ yaw: 25 }),
      frame({ ear: 0.1 }),
      frame(),
      frame({ happy: 0.9 }),
      frame(),
      frame(),
    ];
    const v = evaluateLiveness(frames, ENROLLED, ACTIONS, 0.6);

    expect(v.passed).toBe(true);
    expect(v.reasons).toEqual([]);
  });

  it("is not derailed by an incidental glance in the very first frame", () => {
    // Frame 0 is grabbed the instant Start is tapped, before the user reacts,
    // so it often carries a real yaw. Latching the turn direction from it
    // inverts the expected signs and makes a GENUINE left-then-right pair
    // impossible to satisfy.
    const frames = [
      frame({ yaw: 22 }), // incidental glance, not the prompted turn
      frame({ yaw: -40 }), // the actual left turn
      frame({ yaw: -38 }),
      frame(),
      frame({ ear: 0.1 }), // blink
      frame(),
      frame({ yaw: 40 }), // the actual right turn
      frame({ yaw: 38 }),
    ];
    const v = evaluateLiveness(
      frames,
      ENROLLED,
      ["TURN_LEFT", "BLINK", "TURN_RIGHT"],
      0.6
    );

    expect(v.failedActions).toEqual([]);
    expect(v.passed).toBe(true);
  });

  it("still requires a real reversal, not two turns the same way", () => {
    const frames = [
      frame({ yaw: 30 }),
      frame({ yaw: 32 }),
      frame({ ear: 0.1 }),
      frame(),
      frame({ yaw: 35 }),
      frame({ yaw: 31 }),
    ];
    const v = evaluateLiveness(
      frames,
      ENROLLED,
      ["TURN_LEFT", "BLINK", "TURN_RIGHT"],
      0.6
    );

    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("action_not_satisfied");
  });

  it("rejects a burst that is mostly one repeated still", () => {
    const still = frame({ yaw: 25, ear: 0.1, happy: 0.9 });
    const frames = [still, { ...still }, { ...still }, { ...still }, frame(), frame()];
    const v = evaluateLiveness(frames, ENROLLED, ACTIONS, 0.6);

    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("duplicate_frames");
  });

  it("tolerates a single duplicated frame from a stalled camera", () => {
    const frames = goodFrames();
    frames[5] = { ...frames[4] }; // one repeat, the rest genuine
    const v = evaluateLiveness(frames, ENROLLED, ACTIONS, 0.6);

    expect(v.reasons).not.toContain("duplicate_frames");
  });

  it("rejects a held photo: the smile threshold is met but nothing moves", () => {
    // Every frame is smiling hard at a fixed angle - a photo, not a person.
    // Each action's threshold is technically satisfied on every frame, but the
    // signals never vary, so there is no live motion.
    const frames = Array.from({ length: 6 }, (_, i) => ({
      descriptor: near(0.04 + i * 0.0006), // distinct enough to not be "duplicate"
      yaw: 25,
      ear: 0.1,
      happy: 0.9,
      score: 0.9,
    }));
    const v = evaluateLiveness(frames, ENROLLED, ACTIONS, 0.6);
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("insufficient_motion");
  });

  it("rejects a burst padded with filler stills", () => {
    // Two real frames plus a pile of identical filler: only half the burst is
    // distinct, so the variation floor rejects it.
    const filler = frame({ yaw: 25, ear: 0.1, happy: 0.9 });
    const frames = [
      frame({ yaw: 25 }),
      frame({ happy: 0.9 }),
      filler,
      { ...filler },
      { ...filler },
      { ...filler },
    ];
    const v = evaluateLiveness(frames, ENROLLED, ACTIONS, 0.6);
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("insufficient_variation");
  });

  it("fails with too few usable frames", () => {
    const v = evaluateLiveness([frame(), frame()], ENROLLED, ACTIONS, 0.6);
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("insufficient_usable_frames");
  });

  // Real-user scenarios that fixed thresholds falsely reject. These are the
  // cases the calibrated, relative thresholds exist to pass.

  it("passes a genuine smile held through the whole burst", () => {
    // Told to smile, the user smiles from the first frame to the last, so the
    // happy signal never SPANS a wide range. A turn and a blink still supply the
    // live-motion proof, so the held smile must not sink the capture.
    const frames = [
      frame({ yaw: 18, happy: 0.85 }), // turn, already smiling
      frame({ ear: 0.12, happy: 0.86 }), // blink low point, still smiling
      frame({ happy: 0.9 }),
      frame({ happy: 0.88 }),
      frame({ happy: 0.87 }),
      frame({ happy: 0.86 }),
    ];
    const v = evaluateLiveness(frames, ENROLLED, ACTIONS, 0.6);
    expect(v.reasons).toEqual([]);
    expect(v.passed).toBe(true);
  });

  it("detects a blink for a narrow-eyed user whose open EAR never reaches 0.285", () => {
    // Open-eye EAR sits at ~0.24 (narrow eyes / tilted webcam), so a fixed
    // reopen bar of 0.285 is unreachable and blink fails on every attempt.
    // Relative detection reads the dip against this user's own 0.24 baseline.
    const frames = [
      frame({ ear: 0.24, yaw: 15 }), // open + a turn
      frame({ ear: 0.13 }), // blink low point (well under 0.24 baseline)
      frame({ ear: 0.24, happy: 0.9 }), // reopened + smile
      frame({ ear: 0.23 }),
      frame({ ear: 0.24 }),
      frame({ ear: 0.23 }),
    ];
    const v = evaluateLiveness(frames, ENROLLED, ACTIONS, 0.6);
    expect(v.failedActions).not.toContain("BLINK");
    expect(v.passed).toBe(true);
  });

  it("counts a moderate turn (yaw ~13) that the old 18-degree bar rejected", () => {
    const frames = [
      frame({ yaw: 1 }), // forward baseline
      frame({ yaw: 15 }), // a moderate but deliberate turn (old 18 bar rejected)
      frame({ ear: 0.1 }), // blink
      frame({ happy: 0.9 }), // smile
      frame({ yaw: 2 }),
      frame({ yaw: 1 }),
    ];
    const v = evaluateLiveness(frames, ENROLLED, ACTIONS, 0.6);
    expect(v.failedActions).not.toContain("TURN_LEFT");
    expect(v.passed).toBe(true);
  });

  it("still rejects a held photo of a smiling face at a fixed angle", () => {
    // The relaxations must not open the photo hole: nothing moves, so the blink
    // has no dip and the turn has no range. Distinct descriptors keep the
    // duplicate/variation checks from firing, so liveness alone must catch it.
    const frames = Array.from({ length: 6 }, (_, i) => ({
      descriptor: near(0.04 + i * 0.0006),
      yaw: 20,
      ear: 0.3,
      happy: 0.9,
      score: 0.9,
    }));
    const v = evaluateLiveness(frames, ENROLLED, ACTIONS, 0.6);
    expect(v.passed).toBe(false);
    // No EAR dip -> blink unprovable; no yaw range -> insufficient_motion.
    expect(v.reasons).toEqual(
      expect.arrayContaining(["action_not_satisfied", "insufficient_motion"])
    );
  });
});
