// import { PrismaModel } from "@/core/controllers/BaseController.js";
// import { BaseModel } from "@/core/models/BaseModel.js";

// export function createModelConfigFromModel(
//   modelClass: typeof BaseModel
// ): PrismaModel {
//   if (!modelClass.modelName) {
//     throw new Error("BaseModel must have a modelName defined");
//   }

//   return {
//     modelName: modelClass.modelName.toLowerCase(),
//     relationFields: modelClass.relationFields,
//     fileFields: modelClass.fileFields,
//     getZodSchema: () => modelClass.getZodSchema(),
//     getPartialZodSchema: () => modelClass.getPartialZodSchema(),
//     // Add the new methods for enhanced functionality
//     getRelationModel: (field: string) => {
//       if (typeof modelClass.getRelationModel === "function") {
//         return modelClass.getRelationModel(field);
//       }
//       return undefined;
//     },
//     validateNestedData: async (
//       data: any,
//       isUpdate?: boolean,
//       relationField?: string
//     ) => {
//       if (typeof modelClass.validateNestedData === "function") {
//         return modelClass.validateNestedData(data, isUpdate, relationField);
//       }
//       // Fallback to basic validation if enhanced method not available
//       const schema = isUpdate
//         ? modelClass.getPartialZodSchema()
//         : modelClass.getZodSchema();
//       const { validateWithZod } = await import("@/utils/validation.js");
//       return validateWithZod(schema, data);
//     },
//   };
// }
