import express from "express";
import { rateLimit, RateLimitRequestHandler } from "express-rate-limit";
import { BaseController } from "../controllers/BaseController.js";

interface RouterConfig {
  rateLimiting?: boolean;
  enableFileRoutes?: boolean;
  enableBulkRoutes?: boolean;
  enableSoftDeleteRoutes?: boolean;
}

export class BaseRouter {
  private router: express.Router;
  private controller: BaseController;
  private config: RouterConfig;

  constructor(controller: BaseController, config: RouterConfig = {}) {
    this.router = express.Router();
    this.controller = controller;
    this.config = {
      rateLimiting: true,
      enableFileRoutes: false,
      enableBulkRoutes: true,
      enableSoftDeleteRoutes: true,
      ...config,
    };

    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Rate limiting (optional)
    if (this.config.rateLimiting) {
      this.router.use(this.createRateLimiter());
    }

    // Standard CRUD routes
    this.router.get("/", this.controller.getAll);
    this.router.post("/", this.controller.create);
    this.router.get("/:id", this.controller.getOne);
    this.router.put("/:id", this.controller.update);
    this.router.delete("/:id", this.controller.delete);

    // Soft delete & restore routes (optional)
    if (this.config.enableSoftDeleteRoutes) {
      this.router.delete("/:id/soft", this.controller.softDelete);
      this.router.post("/:id/restore", this.controller.restore);
    }
    // Bulk operation routes (optional)
    if (this.config.enableBulkRoutes) {
      this.router.post("/bulk", this.controller.bulkCreate);
      this.router.put("/bulk", this.controller.bulkUpdate);
      this.router.delete("/bulk", this.controller.bulkHardDelete);
      this.router.post("/bulk-soft-delete", this.controller.bulkSoftDelete);
      this.router.post("/bulk-restore", this.controller.bulkRestore);
    }

    // File upload routes (optional)
    if (this.config.enableFileRoutes) {
      if (this.controller.createWithFiles)
        this.router.post("/upload", this.controller.createWithFiles);
      if (this.controller.updateWithFiles)
        this.router.put("/:id/upload", this.controller.updateWithFiles);
    }
  }

  private createRateLimiter(): RateLimitRequestHandler {
    return rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100, // Limit each IP to 100 requests per window
      standardHeaders: true, // Return rate limit info in headers
      legacyHeaders: false, // Disable deprecated headers
      message: "Too many requests from this IP, please try again later",
    });
  }

  public getRouter(): express.Router {
    return this.router;
  }
}
