import winston from "winston";
import morgan from "morgan";
import fs from "fs";
import path from "path";

// Ensure logs directory exists
const logsDir = path.join(process.cwd(), "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

interface Logger {
  info: (...args: any[]) => void;
  error: (...args: any[]) => void;
  debug: (...args: any[]) => void;
  warn: (...args: any[]) => void;
}

// Environment-specific log levels
const logLevel =
  process.env.LOG_LEVEL ||
  (process.env.NODE_ENV === "development" ? "debug" : "info");

// Create Winston logger instance
const winstonLogger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
    new winston.transports.File({
      filename: path.join(logsDir, "error.log"),
      level: "error",
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(logsDir, "combined.log"),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
  ],
  // Exception handling
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join(logsDir, "exceptions.log"),
      maxsize: 5242880,
      maxFiles: 5,
    }),
  ],
  rejectionHandlers: [
    new winston.transports.File({
      filename: path.join(logsDir, "rejections.log"),
      maxsize: 5242880,
      maxFiles: 5,
    }),
  ],
});

// Create Morgan middleware for HTTP logging
export const httpLogger = morgan("combined", {
  stream: {
    write: (message: string) => {
      winstonLogger.info(message.trim());
    },
  },
});

// Helper function to format arguments for Winston
const formatArgsForWinston = (args: any[]): string => {
  return args
    .map((arg) =>
      typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg)
    )
    .join(" ");
};

export const logger: Logger = {
  info: (...args) => {
    console.log(`[INFO][${new Date().toISOString()}]`, ...args);
    winstonLogger.info(formatArgsForWinston(args));
  },
  error: (...args) => {
    console.error(`[ERROR][${new Date().toISOString()}]`, ...args);
    winstonLogger.error(formatArgsForWinston(args));
  },
  debug: (...args) => {
    if (process.env.NODE_ENV === "development" || logLevel === "debug") {
      console.debug(`[DEBUG][${new Date().toISOString()}]`, ...args);
      winstonLogger.debug(formatArgsForWinston(args));
    }
  },
  warn: (...args) => {
    console.warn(`[WARN][${new Date().toISOString()}]`, ...args);
    winstonLogger.warn(formatArgsForWinston(args));
  },
};

// Export Winston logger for direct access if needed
export { winstonLogger };
