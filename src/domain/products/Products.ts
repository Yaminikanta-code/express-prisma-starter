import { z } from "zod";
import { BaseModel } from "../../core/models/BaseModel.js";
// import { createModelConfigFromModel } from "@/utils/createModelConfigFromBaseModel.js";

export class Product extends BaseModel {
  static modelName = "Product";
  static relationFields = []; // Add your actual relation fields here
  static fileFields = []; // Add file fields if you have any (e.g., ["image"])

  static zodSchema = z.object({
    name: z.string().min(2, "Name must be at least 2 characters"),
    price: z.number().positive("Price must be positive"),
    description: z.string().optional(),
    category: z.string().min(1, "Category is required"),
    inStock: z.boolean().default(true),
    stockQuantity: z.number().int().nonnegative().default(0),
  });
}

// export const Products = createModelConfigFromModel(Product);
