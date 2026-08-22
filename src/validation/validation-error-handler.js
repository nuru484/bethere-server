// src/validation/validation-error-handler.js
import { validationResult } from "express-validator";
import { ValidationError as CustomValidationError } from "../middleware/error-handler.js";

/**
 * Middleware to check validation results and pass errors to error handler
 */

function isStandardValidationError(error) {
  return "path" in error;
}

function isLegacyValidationError(error) {
  return "param" in error;
}

export const validateRequest = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    const formattedErrors = errors.array().map((error) => {
      if (isStandardValidationError(error)) {
        return { field: error.path, message: error.msg };
      }
      if (isLegacyValidationError(error)) {
        return { field: error.param, message: error.msg };
      }
      return { field: "unknown", message: error.msg };
    });

    const validationError = new CustomValidationError("Validation Error", {
      layer: "Request Validation",
      code: "VALIDATION_ERROR",
      context: { errors: formattedErrors },
    });

    return next(validationError);
  }

  next();
};

/**
 * Middleware factory: validators + the shared result check. One name only,
 * so every route wires validation the same way.
 */
export const validationMiddleware = {
  create: (validators) => [...validators, validateRequest],
};
