// src/middleware/error-handler.js
import logger from "../utils/logger.js";
import { captureError } from "../lib/sentry.js";
import ENV from "../config/env.js";
import { sanitizeErrorData } from "../utils/sensitive-data.js";
import { handlePrismaError, isPrismaError } from "./prisma-error-handler.js";

export { sanitizeErrorData };

/**
 * Error severity levels for better logging and monitoring
 */
export const ErrorSeverity = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical",
};

/**
 * Enhanced CustomError class with additional context for better debugging
 */
export class CustomError extends Error {
  constructor(status, message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.layer = options.layer || "unknown";
    this.severity = options.severity || ErrorSeverity.MEDIUM;
    this.timestamp = new Date();
    this.code = options.code;
    this.context = options.context;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Type guard to check if an error is a CustomError
 */
const isCustomError = (error) => {
  return error instanceof CustomError;
};

/**
 * Generate a unique error ID for tracking
 */
const generateErrorId = () => {
  return `err_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .substring(2, 9)}`;
};

/**
 * Error handler middleware
 */
export const errorHandler = (error, req, res, _next) => {
  const isProduction = ENV.NODE_ENV === "production";
  const errorId = generateErrorId();

  // Convert Prisma errors first
  let processedError = error;
  if (isPrismaError(error)) {
    processedError = handlePrismaError(error);
  }

  // Multer limit violations (file too large, too many files) are client
  // errors; unmapped they surface as 500s.
  if (processedError?.name === "MulterError") {
    const message =
      processedError.code === "LIMIT_FILE_SIZE"
        ? "Uploaded file is too large."
        : processedError.code === "LIMIT_FILE_COUNT" ||
            processedError.code === "LIMIT_UNEXPECTED_FILE"
          ? "Too many files uploaded."
          : "Invalid file upload.";
    processedError = new BadRequestError(message, { code: "UPLOAD_ERROR" });
  }

  const sanitizedBody = sanitizeErrorData(req.body);

  // Default values
  let status = 500;
  let severity = ErrorSeverity.HIGH;
  let layer = "unknown";
  let code;
  let context;

  if (isCustomError(processedError)) {
    status = processedError.status;
    severity = processedError.severity;
    layer = processedError.layer;
    code = processedError.code;
    context = processedError.context;
  }

  // Only genuine failures reach the tracker - expected 4xx noise stays out.
  if (status >= 500 || severity === ErrorSeverity.HIGH) {
    captureError(processedError, {
      errorId,
      method: req.method,
      path: req.path,
      status,
    });
  }

  // Logging details
  const logDetails = {
    errorId,
    requestId: req.requestId,
    message: processedError.message,
    path: req.path,
    method: req.method,
    ip: req.ip,
    body: sanitizedBody,
    params: req.params,
    query: sanitizeErrorData(req.query),
    severity,
    stack: !isProduction ? processedError.stack : undefined,
    timestamp: new Date().toISOString(),
    layer,
    code,
    context,
  };

  // Log appropriately
  switch (severity) {
    case ErrorSeverity.CRITICAL:
    case ErrorSeverity.HIGH:
      logger.error(logDetails);
      break;
    case ErrorSeverity.MEDIUM:
      logger.warn(logDetails);
      break;
    case ErrorSeverity.LOW:
      logger.info(logDetails);
      break;
    default:
      logger.error(logDetails);
  }

  // Response
  const errorResponse = {
    status: "error",
    message:
      isProduction && status === 500
        ? "Internal Server Error"
        : processedError.message || "Internal Server Error",
    // Always returned so a user can quote it for support; it maps to the
    // access log and the error log for this exact request.
    requestId: req.requestId,
  };

  // The machine-readable code is part of the API contract and MUST survive in
  // production: the client refreshes its session on TOKEN_EXPIRED but logs out
  // on INVALID_TOKEN. Stripping it here leaves the browser unable to tell the
  // two apart, so no session is ever refreshed in production. It classifies the
  // failure and carries no sensitive detail (unlike stack/errorId/context).
  if (code) errorResponse.code = code;

  if (context && code === "VALIDATION_ERROR") {
    errorResponse.details = context;
  }

  if (!isProduction) {
    errorResponse.errorId = errorId;
    if (context && !errorResponse.details) errorResponse.details = context;
  }

  res.status(status).json(errorResponse);
};

/**
 * Wrapper for async route handlers
 */
export const asyncHandler = (fn) => {
  return (req, res, next) => {
    return Promise.resolve(fn(req, res, next)).catch(next);
  };
};


export class NotFoundError extends CustomError {
  constructor(message = "Resource not found", options = {}) {
    super(404, message, { ...options, severity: ErrorSeverity.LOW });
  }
}

export class UnauthorizedError extends CustomError {
  constructor(message = "Unauthorized access", options = {}) {
    super(401, message, { ...options, severity: ErrorSeverity.MEDIUM });
  }
}

export class ForbiddenError extends CustomError {
  constructor(
    message = "Access forbidden, you are not allowed to access this resource",
    options = {}
  ) {
    super(403, message, { ...options, severity: ErrorSeverity.MEDIUM });
  }
}

export class ValidationError extends CustomError {
  constructor(message = "Validation failed", options = {}) {
    super(400, message, { ...options, severity: ErrorSeverity.LOW });
  }
}

export class InternalServerError extends CustomError {
  constructor(message = "Internal server error", options = {}) {
    super(500, message, { ...options, severity: ErrorSeverity.HIGH });
  }
}

export class ConflictError extends CustomError {
  constructor(message = "Conflict detected", options = {}) {
    super(409, message, { ...options, severity: ErrorSeverity.MEDIUM });
  }
}

export class BadRequestError extends CustomError {
  constructor(message = "Bad request", options = {}) {
    super(400, message, { ...options, severity: ErrorSeverity.LOW });
  }
}

export class MethodNotAllowedError extends CustomError {
  constructor(message = "Method not allowed", options = {}) {
    super(405, message, { ...options, severity: ErrorSeverity.MEDIUM });
  }
}

export class TooManyRequestsError extends CustomError {
  constructor(message = "Too many requests", options = {}) {
    super(429, message, { ...options, severity: ErrorSeverity.MEDIUM });
  }
}

export class TokenExpiredError extends CustomError {
  constructor(message = "Authentication token expired", options = {}) {
    super(401, message, { ...options, severity: ErrorSeverity.MEDIUM });
  }
}
