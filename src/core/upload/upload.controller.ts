import { NextFunction, Request, Response } from "express";
import { UploadResponse, UploadResult } from "./upload.model.js";
import {
  handleMultipleFiles,
  processFileUploads,
  handleUploadErrors,
  cleanupUploadedFiles,
  RequestWithFiles,
} from "../middlewares/uploadMiddleware.js";
import {
  deleteFile,
  extractS3Key,
  getFileMetadata,
  fileExists,
  isS3Configured,
} from "../../utils/s3Upload.js";

export class UploadController {
  private config = {
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

  constructor(config?: Partial<typeof this.config>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
  }

  // Check if upload is configured
  private checkS3Configured(res: Response): boolean {
    if (!isS3Configured()) {
      res.status(500).json({
        success: false,
        message: "File upload is not configured. S3 credentials are missing.",
      });
      return false;
    }
    return true;
  }

  // Single file upload middleware chain
  getUploadMiddleware() {
    return [
      (req: Request, res: Response, next: NextFunction) => {
        if (!this.checkS3Configured(res)) return;
        return handleMultipleFiles(["file"], {
          maxFileSize: this.config.maxFileSize,
          allowedMimeTypes: this.config.allowedMimeTypes,
        })(req, res, next);
      },
      processFileUploads,
      handleUploadErrors,
      cleanupUploadedFiles,
    ];
  }

  // Batch upload middleware chain
  getBatchUploadMiddleware() {
    return [
      (req: Request, res: Response, next: NextFunction) => {
        if (!this.checkS3Configured(res)) return;
        return handleMultipleFiles(["files"], {
          maxFileSize: this.config.maxFileSize,
          allowedMimeTypes: this.config.allowedMimeTypes,
          maxFilesPerField: this.config.maxFiles,
        })(req, res, next);
      },
      processFileUploads,
      handleUploadErrors,
      cleanupUploadedFiles,
    ];
  }

  // Single file upload
  uploadSingle = async (
    req: RequestWithFiles,
    res: Response
  ): Promise<void> => {
    if (!this.checkS3Configured(res)) return;

    if (!req.uploadedFiles?.file) {
      const response: UploadResponse = {
        success: false,
        message: "No file provided or file upload failed",
      };
      res.status(400).json(response);
      return;
    }

    const response: UploadResponse = {
      success: true,
      message: "File uploaded successfully",
      data: {
        url: req.uploadedFiles.file,
        key: req.uploadedFiles.fileKey,
        originalName: req.file?.originalname || "unknown",
        mimetype: req.file?.mimetype || "application/octet-stream",
        size: req.file?.size || 0,
        uploadedAt: new Date().toISOString(),
      },
    };

    res.status(200).json(response);
  };

  // Batch file upload
  uploadBatch = async (req: RequestWithFiles, res: Response): Promise<void> => {
    if (!this.checkS3Configured(res)) return;

    if (!req.uploadedFiles) {
      const response: UploadResponse = {
        success: false,
        message: "No files provided",
      };
      res.status(400).json(response);
      return;
    }

    const uploadResults: UploadResult[] = [];
    const uploadedFiles = req.uploadedFiles;

    for (const [key, value] of Object.entries(uploadedFiles)) {
      if (!key.endsWith("Key") && !key.endsWith("Etag")) {
        const fileKey =
          uploadedFiles[`${key}Key` as keyof typeof uploadedFiles];
        const file: Express.Multer.File | undefined = Array.isArray(req.files)
          ? (req.files.find((f) => f.fieldname === key) as
              | Express.Multer.File
              | undefined)
          : Array.isArray(req.files?.[key])
          ? ((req.files?.[key] as Express.Multer.File[])[0] as
              | Express.Multer.File
              | undefined)
          : (req.files?.[key] as Express.Multer.File | undefined);

        if (fileKey && typeof fileKey === "string") {
          uploadResults.push({
            success: true,
            originalName: file?.originalname || "unknown",
            url: value as string,
            key: fileKey,
            mimetype: file?.mimetype || "application/octet-stream",
            size: file?.size || 0,
          });
        }
      }
    }

    const response: UploadResponse = {
      success: true,
      message: "Batch upload completed",
      results: uploadResults,
      total: uploadResults.length,
      successful: uploadResults.length,
      failed: 0,
    };

    res.status(200).json(response);
  };

  // Delete file by key
  deleteFileByKey = async (req: Request, res: Response): Promise<void> => {
    if (!this.checkS3Configured(res)) return;

    try {
      const { key } = req.params;

      if (!key) {
        const response: UploadResponse = {
          success: false,
          message: "File key is required",
        };
        res.status(400).json(response);
        return;
      }

      await deleteFile(key);

      const response: UploadResponse = {
        success: true,
        message: "File deleted successfully",
      };

      res.status(200).json(response);
    } catch (error: any) {
      const response: UploadResponse = {
        success: false,
        message: error.message,
      };
      res.status(500).json(response);
    }
  };

  // Delete file by URL
  deleteFileByUrl = async (req: Request, res: Response): Promise<void> => {
    if (!this.checkS3Configured(res)) return;

    try {
      const { url } = req.body;

      if (!url) {
        const response: UploadResponse = {
          success: false,
          message: "File URL is required",
        };
        res.status(400).json(response);
        return;
      }

      const key = extractS3Key(url);

      if (!key) {
        const response: UploadResponse = {
          success: false,
          message: "Invalid file URL",
        };
        res.status(400).json(response);
        return;
      }

      await deleteFile(key);

      const response: UploadResponse = {
        success: true,
        message: "File deleted successfully",
      };

      res.status(200).json(response);
    } catch (error: any) {
      const response: UploadResponse = {
        success: false,
        message: error.message,
      };
      res.status(500).json(response);
    }
  };

  // Get file metadata
  getFileMetadata = async (req: Request, res: Response): Promise<void> => {
    if (!this.checkS3Configured(res)) return;

    try {
      const { key } = req.params;

      if (!key) {
        const response: UploadResponse = {
          success: false,
          message: "File key is required",
        };
        res.status(400).json(response);
        return;
      }

      const metadata = await getFileMetadata(key);

      const response: UploadResponse = {
        success: true,
        message: "File metadata retrieved successfully",
        data: metadata,
      };

      res.status(200).json(response);
    } catch (error: any) {
      const response: UploadResponse = {
        success: false,
        message: error.message,
      };
      res.status(500).json(response);
    }
  };

  // Check if file exists
  checkFileExists = async (req: Request, res: Response): Promise<void> => {
    if (!this.checkS3Configured(res)) return;

    try {
      const { key } = req.params;

      if (!key) {
        const response: UploadResponse = {
          success: false,
          message: "File key is required",
        };
        res.status(400).json(response);
        return;
      }

      const exists = await fileExists(key);

      const response: UploadResponse = {
        success: true,
        message: exists ? "File exists" : "File does not exist",
        data: { exists },
      };

      res.status(200).json(response);
    } catch (error: any) {
      const response: UploadResponse = {
        success: false,
        message: error.message,
      };
      res.status(500).json(response);
    }
  };

  // Get current configuration
  getConfig = (req: Request, res: Response): void => {
    res.json({
      success: true,
      data: this.config,
      isS3Configured: isS3Configured(),
    });
  };

  // Update configuration (admin only)
  updateConfig = (req: Request, res: Response): void => {
    // Add authentication/authorization check here in production
    this.config = { ...this.config, ...req.body };

    res.json({
      success: true,
      message: "Configuration updated successfully",
      data: this.config,
    });
  };

  // Health check with S3 status
  healthCheck = (req: Request, res: Response): void => {
    res.json({
      success: true,
      message: "Upload service is healthy",
      timestamp: new Date().toISOString(),
      s3Configured: isS3Configured(),
    });
  };
}
