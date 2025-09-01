// Example usage in a specific controller
// export class UserController extends SecureBaseController {
// constructor() {
// // You'll need to define these schemas in your actual implementation
// const userSchema = {} as any;
// const userPartialSchema = {} as any;

// const userModel = {
// modelName: "user",
// relationFields: ["posts", "profile"],
// fileFields: ["avatar"],
// getZodSchema: () => userSchema,
// getPartialZodSchema: () => userPartialSchema,
// };

// const securityConfig: Partial<QuerySecurityConfig> = {
// allowedFilters: ["email", "status", "createdAt", "updatedAt"],
// allowedSortFields: ["email", "createdAt", "updatedAt"],
// allowedIncludeRelations: ["posts", "profile"],
// allowedSelectFields: ["id", "email", "name", "createdAt", "updatedAt"],
// maxIncludeDepth: 2,
// maxLimit: 100,
// };

// super(userModel, securityConfig);
// }
// }

// // Example usage in a product controller
// export class ProductController extends SecureBaseController {
// constructor() {
// // You'll need to define these schemas in your actual implementation
// const productSchema = {} as any;
// const productPartialSchema = {} as any;

// const productModel = {
// modelName: "product",
// relationFields: ["category", "reviews"],
// fileFields: ["image"],
// getZodSchema: () => productSchema,
// getPartialZodSchema: () => productPartialSchema,
// };

// const securityConfig: Partial<QuerySecurityConfig> = {
// allowedFilters: ["name", "price", "categoryId", "status"],
// allowedSortFields: ["name", "price", "createdAt"],
// allowedIncludeRelations: ["category"],
// allowedSelectFields: ["id", "name", "price", "description", "createdAt"],
// maxIncludeDepth: 1,
// maxLimit: 50,
// };

// super(productModel, securityConfig);
// }
// }
