import multer, { Field, FileFilterCallback } from "multer";
import { Request, Response, NextFunction } from "express";
import {
  uploadFile,
  UploadableFile,
  deleteFile,
  extractS3Key,
  isS3Configured,
} from "../../utils/s3Upload.js";

export interface UploadedFiles {
  [fieldname: string]: Express.Multer.File[];
}

export interface UploadedFilesResult {
  [fieldname: string]: string; // URL
  [fieldnameKey: `${string}Key`]: string; // Key for cleanup
}

export interface RequestWithFiles extends Request {
  files?: UploadedFiles | Express.Multer.File[];
  uploadedFiles?: UploadedFilesResult;
  uploadErrors?: Array<{ field: string; error: string }>;
}

// Default configuration
const DEFAULT_UPLOAD_CONFIG = {
  maxFileSize: 5 * 1024 * 1024, // 5MB
  allowedMimeTypes: [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/pdf",
    "text/plain",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  maxFiles: 5,
};

/**
 * Enhanced file handling middleware with validation
 */
export const handleMultipleFiles = (
  fileFields: string[],
  options: {
    maxFileSize?: number;
    allowedMimeTypes?: string[];
    maxFilesPerField?: number;
  } = {}
) => {
  // Check if S3 is configured
  if (!isS3Configured()) {
    return (req: Request, res: Response, next: NextFunction) => {
      res.status(500).json({
        success: false,
        message: "File upload is not configured. S3 credentials are missing.",
      });
    };
  }

  const config = { ...DEFAULT_UPLOAD_CONFIG, ...options };

  const fields: Field[] = fileFields.map((field) => ({
    name: field,
    maxCount: options.maxFilesPerField || 1,
  }));

  const multerOptions: multer.Options = {
    storage: multer.memoryStorage(),
    limits: {
      fileSize: config.maxFileSize,
      files: fileFields.length * (options.maxFilesPerField || 1),
    },
    fileFilter: (
      req: RequestWithFiles,
      file: Express.Multer.File,
      cb: FileFilterCallback
    ) => {
      const allowedTypes = config.allowedMimeTypes;

      if (allowedTypes.length > 0 && !allowedTypes.includes(file.mimetype)) {
        if (!req.uploadErrors) req.uploadErrors = [];
        req.uploadErrors.push({
          field: file.fieldname,
          error: `File type ${
            file.mimetype
          } is not allowed. Allowed types: ${allowedTypes.join(", ")}`,
        });
        return cb(new Error(`Invalid file type: ${file.mimetype}`));
      }

      cb(null, true);
    },
  };

  return multer(multerOptions).fields(fields);
};

/**
 * File processing middleware
 */
export const processFileUploads = async (
  req: RequestWithFiles,
  res: Response,
  next: NextFunction
): Promise<void> => {
  if (!req.files || Object.keys(req.files).length === 0) {
    return next();
  }

  try {
    req.uploadedFiles = {};
    const uploadPromises: Promise<void>[] = [];

    const filesToProcess = Array.isArray(req.files)
      ? { files: req.files }
      : req.files;

    for (const [field, files] of Object.entries(filesToProcess)) {
      if (files && files.length > 0) {
        for (const file of files) {
          const uploadPromise = (async () => {
            try {
              const uploadableFile: UploadableFile = {
                originalname: file.originalname,
                buffer: file.buffer,
                mimetype: file.mimetype,
                size: file.size,
              };

              const { url, key } = await uploadFile(uploadableFile);
              req.uploadedFiles![field] = url;
              req.uploadedFiles![`${field}Key` as const] = key;
            } catch (error) {
              if (!req.uploadErrors) req.uploadErrors = [];
              req.uploadErrors.push({
                field,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          })();
          uploadPromises.push(uploadPromise);
        }
      }
    }

    await Promise.all(uploadPromises);
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Middleware to handle upload errors gracefully
 */
export const handleUploadErrors = (
  req: RequestWithFiles,
  res: Response,
  next: NextFunction
): void => {
  if (req.uploadErrors && req.uploadErrors.length > 0) {
    res.status(400).json({
      success: false,
      message: "File upload errors occurred",
      errors: req.uploadErrors,
      uploadedFiles: req.uploadedFiles,
    });
    return;
  }
  next();
};

/**
 * Middleware to validate required files
 */
export const validateRequiredFiles = (requiredFields: string[]) => {
  return (req: RequestWithFiles, res: Response, next: NextFunction): void => {
    const missingFields = requiredFields.filter(
      (field) => !req.uploadedFiles?.[field]
    );

    if (missingFields.length > 0) {
      res.status(400).json({
        success: false,
        message: "Required files are missing",
        missingFields,
      });
      return;
    }
    next();
  };
};

/**
 * Cleanup middleware - deletes uploaded files if request fails
 */
export const cleanupUploadedFiles = async (
  req: RequestWithFiles,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const originalSend = res.send;
  const uploadedFiles = req.uploadedFiles;

  res.send = function (body: any): Response {
    // If response indicates failure, cleanup uploaded files
    if (res.statusCode >= 400 && uploadedFiles) {
      setTimeout(async () => {
        try {
          for (const [key, value] of Object.entries(uploadedFiles)) {
            if (key.endsWith("Key") && typeof value === "string") {
              await deleteFile(value).catch(console.error);
            }
          }
        } catch (error) {
          console.error("Error during upload cleanup:", error);
        }
      }, 0);
    }
    return originalSend.call(this, body);
  };

  next();
};

// Re-export for backward compatibility
export { extractS3Key };
