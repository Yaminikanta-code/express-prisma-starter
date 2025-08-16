import express from "express";
import { rateLimit, RateLimitRequestHandler } from "express-rate-limit";
import { BaseController } from "../controllers/BaseController.js"; // Assuming BaseController is typed

interface RouterConfig {
  rateLimiting?: boolean;
  enableFileRoutes?: boolean;
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
      ...config,
    };

    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Rate limiting (optional)
    if (this.config.rateLimiting) {
      this.router.use(this._createRateLimiter());
    }

    // Standard CRUD routes
    this.router.get("/", this.controller.getAll);
    this.router.post("/", this.controller.create);
    this.router.get("/:id", this.controller.getOne);
    this.router.put("/:id", this.controller.update);
    this.router.delete("/:id", this.controller.delete);

    // File upload routes (optional)
    if (
      this.config.enableFileRoutes &&
      this.controller.createWithFiles &&
      this.controller.updateWithFiles
    ) {
      this.router.post("/upload", this.controller.createWithFiles);
      this.router.put("/:id/upload", this.controller.updateWithFiles);
    }
  }

  private _createRateLimiter(): RateLimitRequestHandler {
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
