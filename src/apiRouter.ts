import { Router } from "express";
// domains/products/productRoutes.js

import { createProductRouter } from "./domain/products/ProductRoute.js";

export const createApiRouter = (): Router => {
  const router = Router();

  // Product routes
  router.use("/products", createProductRouter()); // Uncomment and adjust as needed

  // Add other routes here
  // router.use("/users", createUserRouter());
  // router.use("/orders", createOrderRouter());

  return router;
};
