import { BaseController } from "../../core/controllers/BaseController.js";
import { Product, Products } from "./Products.js";

// Create the configuration object expected by BaseController
// const productModelConfig = {
//   modelName: Product.modelName.toLowerCase(), // Prisma expects lowercase model names
//   relationFields: Product.relationFields,
//   fileFields: Product.fileFields,
//   getZodSchema: () => Product.zodSchema,
//   getPartialZodSchema: () => Product.zodSchema.partial(),
// };

// Optional: Add security configuration
const productSecurityConfig = {
  allowedFilters: ["name", "price", "category", "inStock"],
  allowedSortFields: ["name", "price", "createdAt"],
  allowedIncludeRelations: Product.relationFields,
  allowedSelectFields: [
    "id",
    "name",
    "price",
    "description",
    "category",
    "inStock",
    "stockQuantity",
  ],
  maxIncludeDepth: 2,
  maxLimit: 100,
  hasSoftDelete: true, // Set to true only if your Product model has deletedAt field
};

export const productController = new BaseController(
  Products,
  productSecurityConfig
);
