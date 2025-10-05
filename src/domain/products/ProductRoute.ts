// domains/products/productRoutes.js
import { BaseRouter } from "../../core/base/BaseRouter.js";
import { productController } from "./ProductController.js";

export function createProductRouter() {
  return new BaseRouter(productController).getRouter(); // ✅ Returns Express.Router()
}
