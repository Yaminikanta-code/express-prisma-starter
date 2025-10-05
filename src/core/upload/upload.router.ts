import express from "express";
import { UploadController } from "./upload.controller.js";

export class UploadRouter {
  public router: express.Router;
  private controller: UploadController;

  constructor(
    config?: Partial<{
      maxFileSize: number;
      allowedMimeTypes: string[];
      maxFiles: number;
    }>
  ) {
    this.router = express.Router();
    this.controller = new UploadController(config);
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Single file upload
    this.router.post(
      "/single",
      this.controller.getUploadMiddleware(),
      this.controller.uploadSingle
    );

    // Batch file upload
    this.router.post(
      "/batch",
      this.controller.getBatchUploadMiddleware(),
      this.controller.uploadBatch
    );

    // File management routes
    this.router.delete("/file/:key", this.controller.deleteFileByKey);
    this.router.delete("/file", this.controller.deleteFileByUrl);
    this.router.get("/file/:key/metadata", this.controller.getFileMetadata);
    this.router.get("/file/:key/exists", this.controller.checkFileExists);

    // Configuration routes
    this.router.get("/config", this.controller.getConfig);
    this.router.patch("/config", this.controller.updateConfig);

    // Health check
    this.router.get("/health", this.controller.healthCheck);
  }

  public getRouter(): express.Router {
    return this.router;
  }
}
