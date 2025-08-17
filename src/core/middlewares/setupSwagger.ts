import swaggerUi from "swagger-ui-express";
import { Express } from "express";

export function setupSwagger(app: Express) {
  const swaggerSpec = {
    openapi: "3.0.0",
    info: {
      title: "API Documentation",
      version: "1.0.0",
      description: "Auto-generated API docs",
    },
    servers: [{ url: "http://localhost:3000" }], // Update with your base URL
    paths: {}, // Will be populated by your routers
  };

  // Serve Swagger UI
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
}
