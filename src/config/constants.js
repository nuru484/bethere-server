export const BCRYPT_SALT_ROUNDS = 10;

// Session token lifetimes - the SINGLE definition. The auth service signs
// JWTs with the string/day forms; the cookie manager uses the derived ms
// values. Cookie lifetime must match token lifetime: a cookie that outlives
// its token sends dead credentials (spurious 401s), one that dies earlier
// drops a still-valid session. Change these together, here only.
export const TOKEN_LIFETIMES = {
  ACCESS_EXPIRY: "30m",
  ACCESS_MAX_AGE_MS: 30 * 60 * 1000,
  REFRESH_EXPIRY_DAYS: 7,
  REFRESH_MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000,
  PENDING_2FA_EXPIRY: "5m",
  PENDING_2FA_MAX_AGE_MS: 5 * 60 * 1000,
};

export const HTTP_STATUS_CODES = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_SERVER_ERROR: 500,
};

// The current biometric-consent policy version. Bump when the consent notice
// materially changes so stored consents below this version force re-consent.
export const BIOMETRIC_CONSENT_VERSION = "2026-07-v1";

// Liveness capture + verification tuning. Actions are the randomized
// challenge steps; the client prompts the user through them and the server
// re-proves each from the uploaded frames.
export const LIVENESS = {
  // Actions the server may draw a challenge from. Each maps to a check the
  // face engine can prove from landmarks/expressions.
  ACTIONS: ["TURN_LEFT", "TURN_RIGHT", "BLINK", "SMILE"],
  // How many actions make up one challenge (drawn without repetition).
  ACTIONS_PER_CHALLENGE: 3,
  // Challenge lifetime. This is the dominant term in the venue-code upload
  // acceptance window (UPLOAD_SKEW_WINDOWS in attendance.service.js is derived
  // from it): at 120s a scanned code stays valid for ~5 minutes at upload -
  // long enough to photograph the QR, relay it off-site, and check in from
  // anywhere. 60s keeps the honest flow comfortable (three prompted
  // actions + a multi-frame burst on a slow phone) while collapsing that
  // window to ~3 minutes. Do not raise it without re-checking the derived
  // upload skew.
  CHALLENGE_TTL_MS: 60 * 1000,
  // Frame bounds for one BATCH capture upload (the legacy single-shot flow that
  // proves all actions from one burst).
  MIN_FRAMES: 6,
  MAX_FRAMES: 16,
  // Frame bounds for ONE STEP of the step-by-step flow: a dense burst capturing
  // a single action. Fewer frames than a batch (one action, not three) but
  // sampled fast enough to catch a ~200ms blink.
  MIN_STEP_FRAMES: 4,
  MAX_STEP_FRAMES: 20,
  // Step-by-step performance: the identity descriptor (the heavy face-recognition
  // net) is computed on only every Nth frame of a step burst - the action
  // signals (yaw/ear/happy) still come from every frame, so this cuts per-step
  // ML time sharply without weakening the action proof.
  STEP_DESCRIPTOR_STRIDE: 3,
  // At least this many frames in a step must carry an identity descriptor for
  // the identity checks to be meaningful.
  MIN_STEP_ID_FRAMES: 2,
  // Lifetime of a step-by-step challenge. The user performs each action, waits
  // for the server to verify it, then does the next - so the whole flow takes
  // longer than a single batch upload. Presence (the venue code) is re-proven at
  // the FINAL commit with a skew window sized to this, and the challenge is
  // single-use, so the wider window does not let a code be relayed and reused.
  STEP_CHALLENGE_TTL_MS: 5 * 60 * 1000,
  // Head-yaw magnitude (from estimateYaw, ~degrees) that counts as a deliberate
  // turn. The proxy under-reads moderate turns (both cheek landmarks foreshorten
  // as the head rotates), and a user turning to a laptop webcam held at arm's
  // length rarely produces a large asymmetry, so a bar of 18 rejects honest
  // turns. 12 (asymmetry ~0.13) still needs a clear, deliberate turn - a
  // forward face sits near 0 - while accepting the moderate turns real users
  // actually make.
  YAW_TURN_DEGREES: 9,
  // In the step-by-step flow a turn is captured in isolation (forward -> turned),
  // so the yaw only has to SPAN this much to prove movement - a smaller bar than
  // the peak, because the strongly-turned frames are often dropped by the face
  // detector (a profile is harder to detect) and never reach here.
  YAW_STEP_RANGE: 6,
  // Blink is detected RELATIVE to each user's own open-eye baseline, not a fixed
  // EAR, because open-eye EAR varies widely by face shape, glasses, and camera
  // angle (narrow eyes / a downward-tilted webcam can sit at 0.22 where a fixed
  // 0.285 reopen bar could never be cleared, failing blink for that person on
  // every challenge). A frame under baseline x CLOSE_RATIO is the closed low
  // point; a later frame back over baseline x REOPEN_RATIO is the reopen. A
  // photo cannot fake this: a blink is a transition, not a holdable state.
  BLINK_CLOSE_RATIO: 0.72,
  BLINK_REOPEN_RATIO: 0.82,
  // Step-by-step blink is proven by a DIP below the user's own open-eye
  // baseline. Real webcam output showed the 68-point landmark EAR swings only
  // modestly on closure (open ~0.30, a genuine blink reaching ~0.25 - a ~16%
  // dip - not the ~0.12 an ideal closed eye would read), so the bar is a ~12%
  // dip. A static photo re-detected yields a CONSTANT EAR (0% dip), so it still
  // cannot pass; only an actual eye movement produces the dip.
  BLINK_STEP_DIP_RATIO: 0.88,
  // Absolute floor used only when the burst has no plausibly-open baseline (e.g.
  // degenerate landmarks): a frame under this reads as closed regardless.
  EYE_CLOSED_EAR: 0.19,
  // Expression-net probability above this reads as a smile. Real webcam output
  // showed the net scoring genuine smiles lower than its ideal 0.8+, so the bar
  // is 0.35 - still well clear of a neutral face (~0.05) but accepting the
  // subtler smiles the net actually reports.
  SMILE_PROBABILITY: 0.35,
  // A captured-vs-enrolled distance at/under this is a replayed template, not
  // a live face - a real second capture is never a perfect duplicate.
  REPLAY_MIN_DISTANCE: 0.02,
  // A frame farther than this from the enrolled template is a clearly
  // DIFFERENT face (a mid-sequence swap), not just a poor match. Must sit
  // above the match threshold: two people's descriptors are typically ~1.0+
  // apart, the same person's well under the 0.6 match line.
  CONTINUITY_MAX_DISTANCE: 1.0,
  // A live capture MOVES. Beyond proving each action fired once, the challenged
  // signals must show real RANGE across the burst, so a held photo (a fixed
  // grin, a head frozen at an angle) fails even if a single frame clears a
  // threshold. These are the min (max - min) spreads required when the
  // corresponding action is part of the challenge.
  //
  // The SMILE range gate is OFF (0): a user told to smile smiles through the
  // whole short burst, so happy never spans a range - it is indistinguishable
  // from a photo by range alone, and a range gate there rejects honest
  // smiles. Anti-photo strength does not rest on it: every possible challenge
  // draw (3 of TURN_LEFT/TURN_RIGHT/BLINK/SMILE) still contains a BLINK or a
  // two-turn reversal, each a transition no still can fake, and the SMILE
  // itself is still proven per-frame (happy >= SMILE_PROBABILITY) in
  // challenge order.
  SMILE_MIN_RANGE: 0,
  EAR_MIN_RANGE: 0.04,
  // At least this fraction of frames must be mutually distinct (not near-
  // identical), so an attacker cannot pad two real frames with a pile of
  // stills to squeak under the majority-duplicate check.
  MIN_DISTINCT_RATIO: 0.6,
};

// Rotating venue code (proof of on-site presence). Codes are stateless keyed
// hashes of the event secret + the current time window, so nothing polls or
// writes the database to rotate them - the venue display fetches a batch and
// cycles locally, and validation just recomputes the current window's code.
export const VENUE_CODE = {
  // Rotation period. Short enough that a screenshotted code is stale fast.
  PERIOD_MS: 30 * 1000,
  // Windows either side of "now" still accepted, absorbing clock skew between
  // the venue display and the server (each window is one PERIOD_MS).
  SKEW_WINDOWS: 1,
  // Hex characters of the HMAC kept as the code (64 bits: unguessable in a
  // 30s window, still small enough to render as a crisp QR).
  CODE_HEX_LENGTH: 16,
  // How many upcoming codes the display fetches per batch (10 min at 30s).
  BATCH_SIZE: 20,
};

// How long retained evidence frames live before the retention job purges them.
export const EVIDENCE_RETENTION_DAYS = 30;
// How many expired evidence rows one retention sweep processes per batch, and
// the per-run ceiling - each row costs Cloudinary round-trips, so a backlog
// is drained across sweeps instead of in one unbounded run.
export const EVIDENCE_PURGE_BATCH = 200;
export const EVIDENCE_PURGE_MAX_PER_RUN = 2000;
// Dormant enrolled templates are purged after this many days without a
// check-in (biometric data minimization).
export const TEMPLATE_DORMANT_DAYS = 365;
// Append-only bookkeeping still needs a horizon: audit entries and RESOLVED
// anomaly flags older than this are trimmed by the retention sweep.
export const AUDIT_LOG_RETENTION_DAYS = 180;
export const ANOMALY_RESOLVED_RETENTION_DAYS = 180;

// Check-ins within this window after the session opens count PRESENT; later
// ones count LATE.
export const ATTENDANCE_LATE_GRACE_MS = 60 * 60 * 1000;

// Session finalization (absence marking + auto check-out).
export const SESSION_FINALIZER = {
  // How long after the session's end time the finalizer waits before closing
  // the books, so a check-out racing the deadline is never overwritten.
  GRACE_MS: 30 * 60 * 1000,
  // Only sessions whose day is within this lookback get ABSENT rows and auto
  // check-outs. Older sessions (e.g. history predating this feature) are
  // stamped finalized WITHOUT fabricating retroactive absence data.
  LOOKBACK_DAYS: 7,
  // Sweep cadence (BullMQ repeatable cron pattern): every 10 minutes.
  CRON_PATTERN: "*/10 * * * *",
};

// A recurring event's occurrence must finish before the next one starts. With
// recurrenceInterval < durationDays the next occurrence's first day is a day
// the current occurrence already owns a Session row for, so session
// generation stalls on it permanently. Shared by the request validator and
// the service's merged-value check.
export const RECURRENCE_INTERVAL_MESSAGE =
  "recurrenceInterval must be at least durationDays, so each occurrence ends before the next one starts.";
