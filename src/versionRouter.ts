//use for versioning
import { Router } from "express";
// import { createProductRouter } from "../domains/products/ProductRoute"; // Uncomment and adjust the path as needed

export const createVersionRouter = (): Router => {
  const router = Router();

  // Product routes
  //   router.use("/products", createProductRouter()); // Uncomment and adjust as needed

  // Add other routes here
  // router.use("/users", createUserRouter());
  // router.use("/orders", createOrderRouter());

  return router;
};

//in apiRouter add router.use("/v1", createVersionRouter());
