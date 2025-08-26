import express, { Express, Request, Response, NextFunction } from "express";
import { DatabaseConnection } from "./core/db/database.js";
import config from "./config.js";
import {
  errorHandler,
  notFoundHandler,
} from "./core/middlewares/errorHandler.js";
import { httpLogger } from "./utils/logger.js";
import { setupSwagger } from "./core/middlewares/setupSwagger.js";
import { createApiRouter } from "./apiRouter.js";
// import { createProductRouter } from "./domains/products/ProductRoute";

export async function createApp(): Promise<Express> {
  await DatabaseConnection.initialize(config.db);
  const app: Express = express();

  // Middleware
  app.use(httpLogger);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Health check endpoint
  app.get("/health", async (req: Request, res: Response) => {
    try {
      await DatabaseConnection.getClient().$queryRaw`SELECT 1`;
      res.json({
        status: "ok",
        database: "connected",
        timestamp: new Date(),
      });
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({
        status: "error",
        database: "disconnected",
        error: errorMessage,
      });
    }
  });

  // API routes (delegated to apiRouter.ts)
  app.use("/api", createApiRouter());

  // Swagger documentation
  setupSwagger(app);
  // Error handling
  app.use(notFoundHandler);
  app.use(errorHandler);

  // Graceful shutdown
  const gracefulShutdown = async (signal: string) => {
    console.log(`${signal} received: closing server`);
    await DatabaseConnection.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  return app;
}
