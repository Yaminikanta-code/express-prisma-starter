import express from "express";
import { rateLimit, RateLimitRequestHandler } from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
import { BaseController } from "../controllers/BaseController.js";

interface RouterConfig {
  rateLimiting?: boolean;
  enableFileRoutes?: boolean;
  enableBulkRoutes?: boolean;
  enableSoftDeleteRoutes?: boolean;
  enableSwagger?: boolean;
  apiPrefix?: string;
  swaggerConfig?: {
    title?: string;
    version?: string;
    description?: string;
  };
}

export class BaseRouter {
  private router: express.Router;
  private controller: BaseController;
  private config: RouterConfig;
  private static swaggerInitialized = false;

  constructor(controller: BaseController, config: RouterConfig = {}) {
    this.router = express.Router();
    this.controller = controller;
    this.config = {
      rateLimiting: true,
      enableFileRoutes: false,
      enableBulkRoutes: true,
      enableSoftDeleteRoutes: true,
      enableSwagger: false, // Disabled by default for backward compatibility
      apiPrefix: "/api",
      ...config,
    };

    this.setupRoutes();
    this.setupSwagger();
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

  private setupSwagger(): void {
    if (!this.config.enableSwagger || BaseRouter.swaggerInitialized) return;

    const spec = {
      openapi: "3.0.0",
      info: {
        title: this.config.swaggerConfig?.title || "API Documentation",
        version: this.config.swaggerConfig?.version || "1.0.0",
        description:
          this.config.swaggerConfig?.description || "Auto-generated API docs",
      },
      servers: [{ url: `http://localhost:3000${this.config.apiPrefix}` }],
      paths: this.generatePathSpecs(),
      components: {
        schemas: {
          Resource: {
            type: "object",
            properties: {
              id: {
                type: "string",
                format: "uuid",
                example: "550e8400-e29b-41d4-a716-446655440000",
              },
              createdAt: { type: "string", format: "date-time" },
            },
          },
          ErrorResponse: {
            type: "object",
            properties: {
              error: { type: "string" },
              details: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    };

    this.router.use("/docs", swaggerUi.serve, swaggerUi.setup(spec));
    BaseRouter.swaggerInitialized = true;
  }

  private generatePathSpecs(): Record<string, any> {
    const paths: Record<string, any> = {};
    const routeStack = this.router.stack;

    routeStack.forEach((layer) => {
      if (!layer.route) return;

      const path = layer.route.path;
      const methods = Object.keys((layer.route as any).methods)
        .filter((method) => method !== "_all")
        .map((method) => method.toLowerCase());

      methods.forEach((method) => {
        if (!paths[path]) paths[path] = {};

        paths[path][method] = {
          summary: `${method.toUpperCase()} ${path}`,
          responses: {
            200: { description: "Success" },
            400: { $ref: "#/components/schemas/ErrorResponse" },
            404: { description: "Not Found" },
          },
        };

        // Auto-detect path parameters
        const pathParams = path.match(/:\w+/g);
        if (pathParams) {
          paths[path][method].parameters = pathParams.map((param) => ({
            name: param.slice(1),
            in: "path",
            required: true,
            schema: { type: "string" },
          }));
        }
      });
    });

    return paths;
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

  public getSwaggerPath(): string {
    return `${this.config.apiPrefix}/docs`;
  }
}
