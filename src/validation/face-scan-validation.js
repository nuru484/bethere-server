import { body } from "express-validator";

/**
 * Enrollment is multipart: the frames arrive as files (bounds-checked in the
 * controller against LIVENESS.MIN_FRAMES/MAX_FRAMES) and only these two
 * scalars travel in the body.
 *
 * There is deliberately no `faceScan` field: a 128-float template computed in
 * the browser and posted here would leave the server blind to the face at the
 * point identity is established, making a template built from a photo of
 * someone else indistinguishable from a real enrollment. The template is
 * derived server-side from the uploaded frames instead.
 */
export const faceScanValidation = [
  body("challengeToken")
    .exists({ checkFalsy: true })
    .withMessage("A liveness challenge is required to enroll your face.")
    .isString()
    .withMessage("Invalid liveness challenge."),

  // Explicit biometric consent is mandatory to enroll (GDPR Art. 9 / BIPA).
  body("consent")
    .exists()
    .withMessage("Biometric consent is required to enroll your face.")
    .isBoolean()
    .withMessage("Consent must be true or false.")
    .toBoolean(),
];

/**
 * Step-by-step enrollment upload. Consent is captured on the first step (the
 * service enforces it there), so it is optional per-request here; only the step
 * token is always required.
 */
export const faceScanStepValidation = [
  body("challengeToken")
    .exists({ checkFalsy: true })
    .withMessage("A liveness challenge is required to enroll your face.")
    .isString()
    .withMessage("Invalid liveness challenge."),
  body("consent")
    .optional()
    .isBoolean()
    .withMessage("Consent must be true or false.")
    .toBoolean(),
];
