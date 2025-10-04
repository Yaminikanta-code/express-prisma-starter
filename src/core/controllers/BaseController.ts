import { Request, Response, NextFunction } from "express";
import { validateWithZod } from "../../utils/validation.js";
import { DatabaseConnection } from "../../core/db/database.js";
import {
  handleMultipleFiles,
  processFileUploads,
  extractS3Key,
  handleUploadErrors,
  cleanupUploadedFiles,
  RequestWithFiles,
} from "../middlewares/uploadMiddleware.js";
import { deleteFile, isS3Configured } from "../../utils/s3Upload.js";
import { PrismaClient } from "@prisma/client";
import { BaseModel } from "../models/BaseModel.js";

// Security configuration interface
interface QuerySecurityConfig {
  allowedFilters: string[];
  allowedSortFields: string[];
  allowedIncludeRelations: string[];
  allowedSelectFields: string[];
  maxIncludeDepth: number;
  maxLimit: number;
  hasSoftDelete: boolean; // Added hasSoftDelete
  maximumNestedDepth?: number;
}

// Default security configuration (very restrictive by default)
const DEFAULT_SECURITY_CONFIG: QuerySecurityConfig = {
  allowedFilters: [],
  allowedSortFields: [],
  allowedIncludeRelations: [],
  allowedSelectFields: [],
  maxIncludeDepth: 1,
  maxLimit: 50,
  hasSoftDelete: false, // Default to false
  maximumNestedDepth: 1,
};

// Augment Express Request type to include uploadedFiles
declare global {
  namespace Express {
    interface Request {
      uploadedFiles?: Record<string, string>;
    }
  }
}

// Extend PrismaClient to support dynamic model access
type PrismaModelClient = {
  findMany: (args: any) => Promise<any[]>;
  findUnique: (args: any) => Promise<any>;
  create: (args: any) => Promise<any>;
  update: (args: any) => Promise<any>;
  delete: (args: any) => Promise<any>;
  count: (args: any) => Promise<number>;
  updateMany: (args: any) => Promise<{ count: number }>;
  deleteMany: (args: any) => Promise<{ count: number }>;
};

// interface for HATEOAS links
interface Link {
  href: string;
  rel: string;
  method: string;
  type?: string; // Optional: content type
  title?: string; // Optional: human-readable description
}

interface HATEOASResponse {
  //make it  StandardResponse for readability
  data?: any;
  meta?: {
    timestamp: string;
    operation: string;
    [key: string]: any;
  };
  links: Link[];
}

export class BaseController {
  private prisma: PrismaClient;
  private model: typeof BaseModel;
  private securityConfig: QuerySecurityConfig;
  private validRelations: string[];

  constructor(
    model: typeof BaseModel,
    securityConfig: Partial<QuerySecurityConfig> = {}
  ) {
    this.prisma = new Proxy({} as PrismaClient, {
      get: (target, prop: keyof PrismaClient) => {
        const client = DatabaseConnection.getClient();
        const value = client[prop];
        return typeof value === "function" ? value.bind(client) : value;
      },
    });
    this.model = model;
    this.securityConfig = { ...DEFAULT_SECURITY_CONFIG, ...securityConfig };
    this.validRelations = Array.isArray(model.relationFields)
      ? model.relationFields
      : [];
  }

  // ========================
  // Security Validation Methods
  // ========================

  // private async _validateSoftDeleteSupport(): Promise<void> {
  //   try {
  //     // This will work even if deletedAt column is empty (all null) or table is empty
  //     // The where clause { deletedAt: null } validates that the column exists in schema
  //     await this.getModelClient().findMany({
  //       where: { deletedAt: null }, // Validates column existence, not data content
  //       take: 1, // Just try to get one record (may return empty array if no matches)
  //       select: { id: true }, // Minimal selection
  //     });
  //   } catch (error: any) {
  //     if (
  //       error.message?.includes("deletedAt") ||
  //       error.message?.includes("Unknown field") ||
  //       error.message?.includes("Invalid field") ||
  //       error.message?.includes("does not exist") ||
  //       error.code === "P2009" ||
  //       error.code === "P2012"
  //     ) {
  //       throw new Error(
  //         `❌ Configuration error: hasSoftDelete=true for model '${this.model.modelName}' ` +
  //           `but the model does not have a 'deletedAt' field. ` +
  //           `Either set hasSoftDelete=false or add deletedAt field to your Prisma schema.`
  //       );
  //     }
  //     // Re-throw other errors (like connection errors, etc.)
  //     // throw error;
  //   }
  // }

  private _validateFilterFields(where: Record<string, any>): void {
    if (!where) return;

    Object.keys(where).forEach((key) => {
      if (key === "AND" || key === "OR" || key === "NOT") {
        // Handle logical operators recursively
        if (Array.isArray(where[key])) {
          where[key].forEach((condition: any) =>
            this._validateFilterFields(condition)
          );
        } else if (typeof where[key] === "object") {
          this._validateFilterFields(where[key]);
        }
      } else if (
        key !== "deletedAt" &&
        !this.securityConfig.allowedFilters.includes(key)
      ) {
        throw new Error(`Filtering by '${key}' is not allowed`);
      }
    });
  }

  private _validateSortFields(orderBy: Record<string, "asc" | "desc">): void {
    Object.keys(orderBy).forEach((key) => {
      if (!this.securityConfig.allowedSortFields.includes(key)) {
        throw new Error(`Sorting by '${key}' is not allowed`);
      }
    });
  }

  private _validateIncludeRelations(
    include: any,
    currentDepth: number = 1
  ): void {
    if (!include || currentDepth > this.securityConfig.maxIncludeDepth) {
      if (currentDepth > this.securityConfig.maxIncludeDepth) {
        throw new Error("Include depth exceeds maximum allowed");
      }
      return;
    }

    Object.keys(include).forEach((key) => {
      if (!this.securityConfig.allowedIncludeRelations.includes(key)) {
        throw new Error(`Including '${key}' relation is not allowed`);
      }

      // Recursively validate nested includes
      if (
        include[key] &&
        typeof include[key] === "object" &&
        include[key].include
      ) {
        this._validateIncludeRelations(include[key].include, currentDepth + 1);
      }
    });
  }

  private _validateSelectFields(select: Record<string, boolean>): void {
    Object.keys(select).forEach((key) => {
      if (!this.securityConfig.allowedSelectFields.includes(key)) {
        throw new Error(`Selecting field '${key}' is not allowed`);
      }
    });
  }

  private _validateQueryParams(params: any): void {
    if (params.where) {
      this._validateFilterFields(params.where);
    }

    if (params.orderBy) {
      this._validateSortFields(params.orderBy);
    }

    if (params.include) {
      this._validateIncludeRelations(params.include);
    }

    if (params.select) {
      this._validateSelectFields(params.select);
    }

    // Validate limit
    if (params.take > this.securityConfig.maxLimit) {
      throw new Error(
        `Limit exceeds maximum allowed value of ${this.securityConfig.maxLimit}`
      );
    }
  }

  // ========================
  // Internal Helpers
  // ========================
  private getModelClient(): PrismaModelClient {
    return (this.prisma as any)[this.model.modelName!];
  }

  private _isValidRelation(fieldPath: string): boolean {
    // Use BaseModel's relation metadata if available
    const firstLevelField = fieldPath.split(".")[0];

    if (this.model.getRelationModel) {
      const relatedModel = this.model.getRelationModel(firstLevelField);
      if (relatedModel) {
        return true; // Valid relation with metadata
      }
    }

    // Fallback to original validation
    return this.validRelations.includes(firstLevelField);
  }

  private async _validateWithModelSchema(
    data: any,
    isUpdate: boolean = false
  ): Promise<any> {
    const schema = isUpdate
      ? this.model.getPartialZodSchema()
      : this.model.getZodSchema();
    return validateWithZod(schema, data);
  }
  private async _validateWithModelSchemaRecursive(
    data: any,
    isUpdate: boolean = false
  ): Promise<any> {
    // FIRST try to use BaseModel's enhanced validation
    if (this.model.validateNestedData) {
      return await this.model.validateNestedData(data, isUpdate);
    }

    // FALLBACK to the original simple validation
    return await this._validateWithModelSchema(data, isUpdate);
  }

  //input sanitization

  private _sanitizeInput(value: any): any {
    if (typeof value !== "string") return value;

    // Remove potentially dangerous characters
    const sanitized = value.replace(/[<>"'`;\\]/g, "");

    // Additional security: limit JSON parsing to prevent DoS
    if (
      (sanitized.startsWith("{") && sanitized.endsWith("}")) ||
      (sanitized.startsWith("[") && sanitized.endsWith("]"))
    ) {
      try {
        // Limit JSON size to prevent DoS
        if (sanitized.length > 10000) {
          throw new Error("JSON payload too large");
        }
        return JSON.parse(sanitized);
      } catch {
        return sanitized; // Return sanitized string if parsing fails
      }
    }

    return sanitized;
  }

  private _parseQueryParams(req: Request) {
    const {
      page = 1,
      limit = 10,
      sort,
      fields,
      filter,
      include,
      withDeleted = false, // New: Flag to include soft-deleted records
      ...simpleFilters
    } = req.query;

    let jsonFilter: Record<string, any> = {};
    if (filter) {
      try {
        jsonFilter = typeof filter === "string" ? JSON.parse(filter) : filter;
      } catch {
        throw new Error("Invalid JSON filter parameter");
      }
    }

    let parsedInclude: any;
    if (include) {
      try {
        parsedInclude =
          typeof include === "string" ? JSON.parse(include) : include;
      } catch {
        throw new Error("Invalid JSON include parameter");
      }
    }

    const parsedPage = Math.max(
      1,
      typeof page === "string" ? parseInt(page, 10) : Number(page) || 1
    );
    const parsedLimit = Math.min(
      typeof limit === "string" ? parseInt(limit, 10) : Number(limit) || 10,
      this.securityConfig.maxLimit
    );
    const skip = (parsedPage - 1) * parsedLimit;

    let orderBy: Record<string, "asc" | "desc"> = {};
    if (sort) {
      const sortStr = typeof sort === "string" ? sort : String(sort);
      sortStr.split(",").forEach((sortField) => {
        const [field, direction = "asc"] = sortField.split(":");
        if (field && ["asc", "desc"].includes(direction)) {
          orderBy[field] = direction as "asc" | "desc";
        }
      });
    }

    let select: Record<string, boolean> | undefined;
    if (fields) {
      const fieldsStr = typeof fields === "string" ? fields : String(fields);
      select = fieldsStr.split(",").reduce((acc, field) => {
        acc[field.trim()] = true;
        return acc;
      }, {} as Record<string, boolean>);
    }

    // Exclude soft-deleted records only if soft delete is supported AND not requesting deleted records
    const where: Record<string, any> = {
      ...jsonFilter,
    };

    if (this.securityConfig.hasSoftDelete && !withDeleted) {
      where.deletedAt = null;
    }

    // Generic value parser that detects type automatically
    const parseValue = (value: any): any => {
      if (typeof value !== "string") {
        return value;
      }

      // Handle boolean values
      if (value.toLowerCase() === "true") return true;
      if (value.toLowerCase() === "false") return false;

      // Handle null values
      if (value.toLowerCase() === "null") return null;

      // Handle numeric values (integers and floats)
      if (/^-?\d+$/.test(value)) {
        return parseInt(value, 10);
      }
      if (/^-?\d+\.\d+$/.test(value)) {
        return parseFloat(value);
      }

      // Handle ISO date strings and common date formats
      const date = new Date(value);
      if (!isNaN(date.getTime())) {
        return date;
      }

      // Handle JSON objects/arrays
      if (
        (value.startsWith("{") && value.endsWith("}")) ||
        (value.startsWith("[") && value.endsWith("]"))
      ) {
        try {
          return JSON.parse(value);
        } catch {
          // If JSON parsing fails, return as string
        }
      }

      // Return as string for everything else
      return this._sanitizeInput(value);
    };

    // Parse operator values in filter conditions
    const parseOperatorValue = (operator: string, value: string): any => {
      // For string operations, keep as string to avoid unwanted conversions
      if (
        ["contains", "startsWith", "endsWith", "search", "mode"].includes(
          operator
        )
      ) {
        return value;
      }

      // For array operations, parse each element
      if (["in", "notIn"].includes(operator)) {
        return value.split(",").map((item) => parseValue(item.trim()));
      }

      // For other operations, parse the value normally
      return parseValue(value);
    };

    for (const [key, value] of Object.entries(simpleFilters)) {
      if (typeof value === "string" && value.includes(":")) {
        const [operator, val] = value.split(":");
        const parsedVal = parseOperatorValue(operator, val);

        switch (operator) {
          case "gt":
          case "gte":
          case "lt":
          case "lte":
          case "equals":
          case "not":
            where[key] = { ...where[key], [operator]: parsedVal };
            break;
          case "contains":
          case "startsWith":
          case "endsWith":
          case "search":
            where[key] = { ...where[key], [operator]: val }; // Keep original string
            break;
          case "in":
          case "notIn":
            where[key] = { ...where[key], [operator]: parsedVal };
            break;
          case "mode":
            where[key] = { ...where[key], [operator]: val }; // Keep string for mode
            break;
          default:
            // For custom operators, try to parse the value
            where[key] = { ...where[key], [operator]: parseValue(val) };
        }
      } else {
        // Parse simple equality values
        where[key] = parseValue(value);
      }
    }

    const queryParams = {
      skip,
      take: parsedLimit,
      ...(Object.keys(orderBy).length > 0 && { orderBy }),
      ...(select && { select }),
      ...(parsedInclude && { include: parsedInclude }),
      where: Object.keys(where).length > 0 ? where : undefined,
    };

    // Apply security validation
    this._validateQueryParams(queryParams);

    return queryParams;
  }

  private _processNestedFields(
    data: Record<string, any>,
    isUpdate: boolean = false,
    currentDepth: number = 0,
    maxDepth: number = this.securityConfig.maximumNestedDepth || 1
  ): Record<string, any> {
    const nestedData: Record<string, any> = {};

    if (currentDepth >= maxDepth) return nestedData;

    for (const [field, value] of Object.entries(data)) {
      if (value == null) continue;

      if (
        this._isValidRelation(field) &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        // This field is a valid relation
        if (isUpdate) {
          nestedData[field] = {};
          if (value.create) {
            nestedData[field].create = this._processNestedFields(
              value.create,
              false,
              currentDepth + 1,
              maxDepth
            );
          }
          if (value.connect) nestedData[field].connect = value.connect;
          if (value.disconnect) nestedData[field].disconnect = value.disconnect;
          if (value.delete) nestedData[field].delete = value.delete;
          if (value.update) {
            nestedData[field].update = this._processNestedFields(
              value.update,
              true,
              currentDepth + 1,
              maxDepth
            );
          }

          // Handle implicit update syntax
          if (
            !value.create &&
            !value.connect &&
            !value.disconnect &&
            !value.update &&
            !value.delete
          ) {
            nestedData[field].update = this._processNestedFields(
              value,
              true,
              currentDepth + 1,
              maxDepth
            );
          }
        } else {
          // Create operation
          if (value.create || value.connect) {
            nestedData[field] = {};
            if (value.create) {
              nestedData[field].create = this._processNestedFields(
                value.create,
                false,
                currentDepth + 1,
                maxDepth
              );
            }
            if (value.connect) nestedData[field].connect = value.connect;
          } else {
            // Implicit create syntax
            nestedData[field] = {
              create: this._processNestedFields(
                value,
                false,
                currentDepth + 1,
                maxDepth
              ),
            };
          }
        }
      } else if (
        currentDepth > 0 &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        // Nested object within a relation
        nestedData[field] = this._processNestedFields(
          value,
          isUpdate,
          currentDepth + 1,
          maxDepth
        );
      } else {
        // Regular field
        nestedData[field] = value;
      }
    }

    return nestedData;
  }

  private _generateLinks(req: Request, id?: string, data?: any): Link[] {
    const baseUrl = `${req.protocol}://${req.get("host")}${req.baseUrl}`;
    const links: Link[] = [
      {
        href: `${baseUrl}`,
        rel: "self",
        method: req.method,
        title: `Current ${this.model.modelName} operation`,
      },
      {
        href: `${baseUrl}`,
        rel: "collection",
        method: "GET",
        title: `Get all ${this.model.modelName}s`,
      },
      {
        href: `${baseUrl}`,
        rel: "create",
        method: "POST",
        title: `Create new ${this.model.modelName}`,
      },
    ];

    if (id) {
      const itemLinks: Link[] = [
        {
          href: `${baseUrl}/${id}`,
          rel: "self",
          method: "GET",
          title: `Get this ${this.model.modelName}`,
        },
        {
          href: `${baseUrl}/${id}`,
          rel: "update",
          method: "PUT",
          title: `Update this ${this.model.modelName}`,
        },
        {
          href: `${baseUrl}/${id}`,
          rel: "delete",
          method: "DELETE",
          title: `Delete this ${this.model.modelName}`,
        },
      ];

      // Only add soft delete links if supported by security config
      if (this.securityConfig.hasSoftDelete) {
        itemLinks.push(
          {
            href: `${baseUrl}/${id}/soft`,
            rel: "soft-delete",
            method: "DELETE",
            title: `Soft delete this ${this.model.modelName}`,
          },
          {
            href: `${baseUrl}/${id}/restore`,
            rel: "restore",
            method: "POST",
            title: `Restore this ${this.model.modelName}`,
          }
        );
      }

      links.push(...itemLinks);
    }

    return links;
  }

  // ========================
  // Public CRUD Methods
  // ========================
  getAll = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const queryOptions = this._parseQueryParams(req);
      const modelClient = this.getModelClient();
      const [items, total] = await Promise.all([
        modelClient.findMany(queryOptions),
        modelClient.count({ where: queryOptions.where }),
      ]);
      const response: HATEOASResponse = {
        data: items,
        meta: {
          total,
          page: parseInt(req.query.page as string) || 1,
          limit: queryOptions.take,
          totalPages: Math.max(1, Math.ceil(total / queryOptions.take)),
          timestamp: new Date().toISOString(),
          operation: "list",
        },
        links: this._generateLinks(req),
      };

      res.json(response);
    } catch (error) {
      next(error); // Delegate to errorHandler
    }
  };

  getOne = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { fields, include } = req.query as {
        fields?: string;
        include?: string;
      };

      let select: Record<string, boolean> | undefined;
      if (fields) {
        select = fields.split(",").reduce((acc, field) => {
          acc[field.trim()] = true;
          return acc;
        }, {} as Record<string, boolean>);
        this._validateSelectFields(select);
      }

      let parsedInclude: any;
      if (include) {
        try {
          parsedInclude =
            typeof include === "string" ? JSON.parse(include) : include;
          this._validateIncludeRelations(parsedInclude);
        } catch {
          throw new Error("Invalid JSON include parameter");
        }
      }

      const item = await this.getModelClient().findUnique({
        where: { id: req.params.id },
        ...(select && { select }),
        ...(parsedInclude && { include: parsedInclude }),
      });

      if (!item) throw new Error("Not found");

      const response: HATEOASResponse = {
        data: item,
        meta: {
          timestamp: new Date().toISOString(),
          operation: "retrieve",
        },
        links: this._generateLinks(req, req.params.id, item),
      };

      res.json(response);
    } catch (error) {
      next(error); // Delegate to errorHandler
    }
  };

  create = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validatedData = await this._validateWithModelSchemaRecursive(
        req.body
      );
      const nestedData = this._processNestedFields(req.body, false);

      const newItem = await this.getModelClient().create({
        data: {
          ...validatedData,
          ...nestedData,
        },
      });

      const response: HATEOASResponse = {
        data: newItem,
        meta: {
          timestamp: new Date().toISOString(),
          operation: "create",
        },
        links: this._generateLinks(req, newItem.id, newItem),
      };

      res.status(201).json(response);
    } catch (error) {
      next(error); // Delegate to errorHandler
    }
  };

  update = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validatedData = await this._validateWithModelSchemaRecursive(
        req.body,
        true
      );
      const nestedData = this._processNestedFields(req.body, true);

      const updatedItem = await this.getModelClient().update({
        where: { id: req.params.id },
        data: {
          ...validatedData,
          ...nestedData,
        },
      });

      if (!updatedItem) throw new Error("Not found");
      const response: HATEOASResponse = {
        data: updatedItem,
        meta: {
          timestamp: new Date().toISOString(),
          operation: "update",
        },
        links: this._generateLinks(req, req.params.id, updatedItem),
      };

      res.json(response);
    } catch (error) {
      next(error); // Delegate to errorHandler
    }
  };

  // Hard delete (kept as is)
  delete = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existingItem = await this.getModelClient().findUnique({
        where: { id: req.params.id },
      });

      if (!existingItem) throw new Error("Not found");

      if (this.model.fileFields?.length) {
        for (const field of this.model.fileFields) {
          if (existingItem[field]) {
            const key = extractS3Key(existingItem[field]);
            if (key) {
              await deleteFile(key).catch((error) => {
                console.error(`Failed to delete S3 file ${key}:`, error);
              });
            }
          }
        }
      }

      await this.getModelClient().delete({
        where: { id: req.params.id },
      });

      const response: HATEOASResponse = {
        data: {
          id: req.params.id,
          message: "Item permanently deleted successfully",
          deletedAt: new Date().toISOString(),
        },
        meta: {
          timestamp: new Date().toISOString(),
          operation: "hard_delete",
        },
        links: this._generateLinks(req),
      };
      res.status(200).json(response);
    } catch (error) {
      next(error); // Delegate to errorHandler
    }
  };

  // ========================
  // Soft Delete & Restore
  // ========================
  softDelete = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!this.securityConfig.hasSoftDelete) {
        throw new Error("Soft delete is not supported for this model");
      }

      const existingItem = await this.getModelClient().findUnique({
        where: { id: req.params.id },
      });

      if (!existingItem || existingItem.deletedAt) {
        throw new Error("Not found or already deleted");
      }

      await this.getModelClient().update({
        where: { id: req.params.id },
        data: { deletedAt: new Date() },
      });

      const response: HATEOASResponse = {
        data: {
          id: req.params.id,
          message: "Item soft deleted successfully",
          deletedAt: new Date().toISOString(),
        },
        meta: {
          timestamp: new Date().toISOString(),
          operation: "soft_delete",
        },
        links: this._generateLinks(req, req.params.id),
      };
      res.status(200).json(response);
    } catch (error) {
      next(error); // Delegate to errorHandler
    }
  };

  restore = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!this.securityConfig.hasSoftDelete) {
        throw new Error("Restore is not supported for this model");
      }

      const existingItem = await this.getModelClient().findUnique({
        where: { id: req.params.id },
      });

      if (!existingItem || !existingItem.deletedAt) {
        throw new Error("Not found or not deleted");
      }

      await this.getModelClient().update({
        where: { id: req.params.id },
        data: { deletedAt: null },
      });
      const response: HATEOASResponse = {
        data: {
          id: req.params.id,
          message: "Item restored successfully",
          restoredAt: new Date().toISOString(),
        },
        meta: {
          timestamp: new Date().toISOString(),
          operation: "restore",
        },
        links: this._generateLinks(req, req.params.id),
      };
      res.status(200).json(response);
    } catch (error) {
      next(error); // Delegate to errorHandler
    }
  };

  // ========================
  // Bulk Operations with transactions
  // ========================
  bulkCreate = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const items = req.body; // Expects an array of items

      // Validate request body structure
      if (!Array.isArray(items)) {
        return res.status(400).json({
          error: "Invalid request body. Expected an array of items.",
          example: [{ name: "Item 1" }, { name: "Item 2" }],
        });
      }

      if (items.length === 0) {
        return res.status(400).json({
          error: "Items array cannot be empty",
        });
      }

      // Validate each item before processing
      const invalidItems = items.filter(
        (item) => !item || typeof item !== "object" || Array.isArray(item)
      );

      if (invalidItems.length > 0) {
        return res.status(400).json({
          error: "All items must be valid objects",
          invalidItems,
        });
      }

      // Validate items against schema
      const validatedItems = await Promise.all(
        items.map((item: any) => this._validateWithModelSchemaRecursive(item))
      );

      // Process nested fields
      const processedItems = validatedItems.map((validatedData) =>
        this._processNestedFields(validatedData, false)
      );

      // Execute in transaction - ALL or NOTHING
      const createdItems = await this.model.runInTransaction(
        async (tx) => {
          return await Promise.all(
            processedItems.map((processedData) =>
              (tx as any)[this.model.modelName!].create({
                data: processedData,
              })
            )
          );
        },
        {
          isolationLevel: "Serializable",
          timeoutMs: 30000,
          maxRetries: 3,
        }
      );

      const response: HATEOASResponse = {
        data: {
          success: true,
          count: createdItems.length,
          items: createdItems,
          message: `Successfully created ${createdItems.length} items`,
        },
        links: this._generateLinks(req),
      };
      return res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  };

  bulkUpdate = async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Validate each item before processing
      if (!req.body || !Array.isArray(req.body)) {
        return res.status(400).json({
          error: "Request body must be an array of update objects",
        });
      }

      const updates = req.body; // Expects an array of { id, ...data }

      if (updates.length === 0) {
        return res.status(400).json({
          error: "Update array cannot be empty",
        });
      }

      // Validate each update object has required fields
      const invalidUpdates = updates.filter(
        (update) =>
          !update || typeof update !== "object" || !update.id || !update.data
      );

      if (invalidUpdates.length > 0) {
        return res.status(400).json({
          error: "Each update must contain 'id' and 'data' fields",
          invalidUpdates,
        });
      }

      const validatedUpdates = await Promise.all(
        updates.map((update: any) =>
          this._validateWithModelSchemaRecursive(update.data, true)
        )
      );

      const nestedUpdates = updates.map((update: any) =>
        this._processNestedFields(update.data, true)
      );

      // Execute in transaction - ALL or NOTHING
      const updatedItems = await this.model.runInTransaction(
        async (tx) => {
          return await Promise.all(
            updates.map((update: any, index: number) =>
              (tx as any)[this.model.modelName!].update({
                where: { id: update.id },
                data: {
                  ...validatedUpdates[index],
                  ...nestedUpdates[index],
                },
              })
            )
          );
        },
        {
          isolationLevel: "RepeatableRead",
          timeoutMs: 20000,
          maxRetries: 3,
        }
      );

      const response: HATEOASResponse = {
        data: {
          success: true,
          updatedCount: updatedItems.length,
          updatedItems: updatedItems,
          message: `Successfully updated ${updatedItems.length} items`,
        },
        meta: {
          timestamp: new Date().toISOString(),
          operation: "bulk_update",
          totalAttempted: updates.length,
        },
        links: this._generateLinks(req),
      };

      res.json(response);
    } catch (error) {
      next(error); // Delegate to errorHandler
    }
  };

  bulkSoftDelete = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!this.securityConfig.hasSoftDelete) {
        throw new Error("Bulk soft delete is not supported for this model");
      }

      // Add proper validation for request body
      if (!req.body || !req.body.ids) {
        return res.status(400).json({
          error: "Missing 'ids' field in request body",
        });
      }

      const { ids } = req.body;

      // Validate that ids is an array
      if (!Array.isArray(ids)) {
        return res.status(400).json({
          error: "'ids' must be an array",
        });
      }

      // Validate that all IDs are valid (adjust based on your ID type)
      if (ids.length === 0) {
        return res.status(400).json({
          error: "'ids' array cannot be empty",
        });
      }

      // Optional: Validate ID format (example for numeric IDs)
      const invalidIds = ids.filter(
        (id) => typeof id !== "number" || id <= 0 || !Number.isInteger(id)
      );

      if (invalidIds.length > 0) {
        return res.status(400).json({
          error: "Invalid ID format",
          invalidIds,
        });
      }

      // Execute in transaction - ALL or NOTHING
      const result = await this.model.runInTransaction(
        async (tx) => {
          return await (tx as any)[this.model.modelName!].updateMany({
            where: {
              id: { in: ids },
              deletedAt: null,
            },
            data: {
              deletedAt: new Date(),
            },
          });
        },
        {
          isolationLevel: "ReadCommitted",
          timeoutMs: 15000,
          maxRetries: 2,
        }
      );

      const response: HATEOASResponse = {
        data: {
          success: true,
          deletedCount: result.count,
          message: `Soft deleted ${result.count} item(s)`,
          deletedAt: new Date().toISOString(),
        },
        meta: {
          timestamp: new Date().toISOString(),
          operation: "bulk_soft_delete",
          totalAttempted: ids.length,
        },
        links: this._generateLinks(req),
      };

      res.json(response);
    } catch (error) {
      next(error); // Delegate to errorHandler
    }
  };

  bulkRestore = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!this.securityConfig.hasSoftDelete) {
        throw new Error("Bulk restore is not supported for this model");
      }

      // Add proper validation for request body
      if (!req.body || !req.body.ids) {
        return res.status(400).json({
          error: "Missing 'ids' field in request body",
        });
      }

      const { ids } = req.body;

      // Validate that ids is an array
      if (!Array.isArray(ids)) {
        return res.status(400).json({
          error: "'ids' must be an array",
        });
      }

      // Validate that all IDs are valid
      if (ids.length === 0) {
        return res.status(400).json({
          error: "'ids' array cannot be empty",
        });
      }

      // Execute in transaction - ALL or NOTHING
      const result = await this.model.runInTransaction(
        async (tx) => {
          return await (tx as any)[this.model.modelName!].updateMany({
            where: {
              id: { in: ids },
              deletedAt: { not: null }, // Only restore soft-deleted items
            },
            data: {
              deletedAt: null,
            },
          });
        },
        {
          isolationLevel: "ReadCommitted",
          timeoutMs: 15000,
          maxRetries: 2,
        }
      );

      const response: HATEOASResponse = {
        data: {
          success: true,
          restoredCount: result.count,
          message: `Restored ${result.count} item(s)`,
          restoredAt: new Date().toISOString(),
        },
        meta: {
          timestamp: new Date().toISOString(),
          operation: "bulk_restore",
          totalAttempted: ids.length,
        },
        links: this._generateLinks(req),
      };

      res.json(response);
    } catch (error) {
      next(error); // Delegate to errorHandler
    }
  };

  bulkHardDelete = async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Add proper validation for request body
      if (!req.body || !req.body.ids) {
        return res.status(400).json({
          error: "Missing 'ids' field in request body",
        });
      }

      const { ids } = req.body;

      // Validate that ids is an array
      if (!Array.isArray(ids)) {
        return res.status(400).json({
          error: "'ids' must be an array",
        });
      }

      // Validate that all IDs are valid
      if (ids.length === 0) {
        return res.status(400).json({
          error: "'ids' array cannot be empty",
        });
      }

      // Execute in transaction - ALL or NOTHING
      const result = await this.model.runInTransaction(
        async (tx) => {
          // Get items first for file cleanup
          const existingItems = await (tx as any)[
            this.model.modelName!
          ].findMany({
            where: { id: { in: ids } },
          });

          // Clean up files if needed
          if (this.model.fileFields?.length) {
            for (const item of existingItems) {
              for (const field of this.model.fileFields) {
                if (item[field]) {
                  const key = extractS3Key(item[field]);
                  if (key) await deleteFile(key).catch(console.error);
                }
              }
            }
          }

          // Perform the actual deletion
          return await (tx as any)[this.model.modelName!].deleteMany({
            where: { id: { in: ids } },
          });
        },
        {
          isolationLevel: "Serializable",
          timeoutMs: 25000,
          maxRetries: 3,
        }
      );

      const response: HATEOASResponse = {
        data: {
          success: true,
          deletedCount: result.count,
          message: `Permanently deleted ${result.count} item(s)`,
          deletedAt: new Date().toISOString(),
        },
        meta: {
          timestamp: new Date().toISOString(),
          operation: "bulk_hard_delete",
          totalAttempted: ids.length,
        },
        links: this._generateLinks(req),
      };

      res.json(response);
    } catch (error) {
      next(error);
    }
  };

  // ========================
  // File Upload Methods
  // ========================
  // Enhanced createWithFiles method
  createWithFiles = [
    (req: Request, res: Response, next: NextFunction) => {
      // Check if S3 is configured
      if (!isS3Configured()) {
        return res.status(500).json({
          success: false,
          message: "File upload is not configured. S3 credentials are missing.",
        });
      }
      return handleMultipleFiles(this.model.fileFields || [])(req, res, next);
    },
    processFileUploads,
    handleUploadErrors,
    cleanupUploadedFiles,
    async (req: RequestWithFiles, res: Response, next: NextFunction) => {
      try {
        // Your existing create logic
        const validatedData = await this._validateWithModelSchemaRecursive(
          req.body
        );
        const nestedData = this._processNestedFields(req.body, false);

        // Check for upload errors
        if (req.uploadErrors && req.uploadErrors.length > 0) {
          const response: HATEOASResponse = {
            data: {
              message: "File upload failed",
              errors: req.uploadErrors,
              uploadedFiles: req.uploadedFiles,
            },
            meta: {
              timestamp: new Date().toISOString(),
              operation: "create_with_files_error",
            },
            links: this._generateLinks(req),
          };
          res.status(400).json(response);
          return;
        }

        const newItem = await this.getModelClient().create({
          data: {
            ...validatedData,
            ...nestedData,
            ...req.uploadedFiles,
          },
        });

        const response: HATEOASResponse = {
          data: newItem,
          meta: {
            timestamp: new Date().toISOString(),
            operation: "create_with_files",
            uploadedFiles: Object.keys(req.uploadedFiles || {}),
            totalFiles: Object.keys(req.uploadedFiles || {}).length,
          },
          links: this._generateLinks(req, newItem.id, newItem),
        };

        res.status(201).json(response);
      } catch (error) {
        next(error); // Delegate to errorHandler
      }
    },
  ];

  // Enhanced updateWithFiles method in BaseController
  updateWithFiles = [
    (req: Request, res: Response, next: NextFunction) => {
      // Check if S3 is configured
      if (!isS3Configured()) {
        return res.status(500).json({
          success: false,
          message: "File upload is not configured. S3 credentials are missing.",
        });
      }
      return handleMultipleFiles(this.model.fileFields || [])(req, res, next);
    },
    processFileUploads,
    handleUploadErrors,
    cleanupUploadedFiles,
    async (req: RequestWithFiles, res: Response, next: NextFunction) => {
      try {
        const validatedData = await this._validateWithModelSchemaRecursive(
          req.body,
          true
        );
        const nestedData = this._processNestedFields(req.body, true);

        // Check for upload errors
        if (req.uploadErrors && req.uploadErrors.length > 0) {
          const response: HATEOASResponse = {
            data: {
              message: "File upload failed",
              errors: req.uploadErrors,
              uploadedFiles: req.uploadedFiles,
            },
            meta: {
              timestamp: new Date().toISOString(),
              operation: "update_with_files_error",
            },
            links: this._generateLinks(req, req.params.id),
          };
          res.status(400).json(response);
          return;
        }

        const existingItem = await this.getModelClient().findUnique({
          where: { id: req.params.id },
        });

        // Only attempt file deletion if S3 is configured and files exist
        if (isS3Configured() && existingItem && this.model.fileFields?.length) {
          for (const field of this.model.fileFields) {
            if (req.uploadedFiles?.[field] && existingItem[field]) {
              const oldKey = extractS3Key(existingItem[field]);
              if (oldKey) await deleteFile(oldKey).catch(console.error);
            }
          }
        }

        const updatedItem = await this.getModelClient().update({
          where: { id: req.params.id },
          data: {
            ...validatedData,
            ...nestedData,
            ...req.uploadedFiles,
          },
        });

        if (!updatedItem) throw new Error("Not found");

        const response: HATEOASResponse = {
          data: updatedItem,
          meta: {
            timestamp: new Date().toISOString(),
            operation: "update_with_files",
            uploadedFiles: Object.keys(req.uploadedFiles || {}),
            totalFiles: Object.keys(req.uploadedFiles || {}).length,
          },
          links: this._generateLinks(req, req.params.id, updatedItem),
        };

        res.json(response);
      } catch (error) {
        next(error); // Delegate to errorHandler
      }
    },
  ];
}
