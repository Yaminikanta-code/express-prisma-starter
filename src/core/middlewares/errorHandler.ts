import { Request, Response, NextFunction } from "express";
import { logger } from "../../utils/logger.js";

// Define error types for better type safety
interface ValidationErrorDetail {
  path: string;
  message: string;
  code: string;
}

interface ErrorResponse {
  error: string;
  message?: string;
  details?: ValidationErrorDetail[];
  stack?: string;
}

/**
 * Centralized error handler middleware.
 * Formats errors consistently and logs them.
 */
export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): Response => {
  // Log the error for debugging
  logger.error(err.stack || err.message);

  // Handle Zod validation errors (thrown by BaseModel/BaseController)
  if (err.message.startsWith("[")) {
    try {
      const details: ValidationErrorDetail[] = JSON.parse(err.message);
      return res.status(400).json({
        error: "Validation failed",
        details,
      } as ErrorResponse);
    } catch (parseError) {
      logger.error("Failed to parse validation error:", parseError);
      return res.status(400).json({
        error: "Validation failed",
        message: err.message,
      } as ErrorResponse);
    }
  }

  // Handle custom errors (e.g., ValidationError, DatabaseError)
  switch (err.name) {
    case "ValidationError":
      return res.status(400).json({
        error: "Validation failed",
        message: err.message,
      } as ErrorResponse);

    case "DatabaseError":
    case "RawQueryError":
      return res.status(400).json({
        error: "Database operation failed",
        message: err.message,
      } as ErrorResponse);

    case "NotFoundError":
      return res.status(404).json({
        error: "Not found",
        message: err.message,
      } as ErrorResponse);

    default:
      // Handle generic errors (e.g., Prisma errors, unhandled exceptions)
      const statusCode =
        "statusCode" in err && typeof err.statusCode === "number"
          ? err.statusCode
          : 500;
      const message =
        statusCode === 500 ? "Internal Server Error" : err.message;

      return res.status(statusCode).json({
        error: message,
        ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
      } as ErrorResponse);
  }
};

/**
 * 404 Not Found handler.
 */
export const notFoundHandler = (req: Request, res: Response): Response => {
  return res.status(404).json({
    error: "Not Found",
    message: `Route ${req.originalUrl} does not exist.`,
  } as ErrorResponse);
};
