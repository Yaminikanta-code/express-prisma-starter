import { PrismaModel } from "@/core/controllers/BaseController.js";
import { BaseModel } from "@/core/models/BaseModel.js";

export function createModelConfigFromModel(
  modelClass: typeof BaseModel
): PrismaModel {
  if (!modelClass.modelName) {
    throw new Error("BaseModel must have a modelName defined");
  }

  return {
    modelName: modelClass.modelName.toLowerCase(),
    relationFields: modelClass.relationFields,
    fileFields: modelClass.fileFields,
    getZodSchema: () => modelClass.getZodSchema(),
    getPartialZodSchema: () => modelClass.getPartialZodSchema(),
  };
}
