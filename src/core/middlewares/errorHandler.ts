import { Request, Response, NextFunction } from "express";
import { logger } from "../../utils/logger.js";

interface ValidationError {
  path: string;
  message: string;
  code: string;
}

interface ErrorResponse {
  error: string;
  message?: string;
  details?: ValidationError[];
  field?: string;
  stack?: string;
}

interface PrismaConflictError extends Error {
  code: "P2002";
  meta?: {
    target?: string[];
  };
}

interface PrismaValidationError extends Error {
  name: "PrismaClientValidationError";
}

export const errorHandler = (
  err: Error | PrismaConflictError | PrismaValidationError,
  req: Request,
  res: Response,
  next: NextFunction
): Response => {
  logger.error(err.stack || err.message);

  // Handle Zod validation errors
  if (err.message.startsWith("[")) {
    try {
      const details: ValidationError[] = JSON.parse(err.message);
      return res.status(400).json({
        error: "Validation failed",
        details,
      } as ErrorResponse);
    } catch (parseError) {
      logger.error("Failed to parse error message:", parseError);
    }
  }

  // Handle Prisma unique constraint violations
  if ("code" in err && err.code === "P2002") {
    const field = err.meta?.target?.[0] || "field";
    return res.status(409).json({
      error: "Duplicate field",
      message: `${field} already exists`,
      field,
    } as ErrorResponse);
  }

  // Handle Prisma validation errors
  if (err.name === "PrismaClientValidationError") {
    return res.status(400).json({
      error: "Validation failed",
      message: err.message.split("\n").slice(-1)[0].trim(),
    } as ErrorResponse);
  }

  // Handle all other errors
  const statusCode =
    "statusCode" in err && typeof err.statusCode === "number"
      ? err.statusCode
      : 500;
  const message = statusCode === 500 ? "Internal Server Error" : err.message;

  const response: ErrorResponse = {
    error: message,
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  };

  return res.status(statusCode).json(response);
};

export const notFoundHandler = (req: Request, res: Response): Response => {
  return res.status(404).json({
    error: "Not Found",
    message: `Path ${req.originalUrl} not found`,
  } as ErrorResponse);
};
