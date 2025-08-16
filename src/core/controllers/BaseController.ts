import { validateWithZod } from "../../utils/validation.js";
import { DatabaseConnection } from "../../core/db/database.js";
import {
  handleMultipleFiles,
  processFileUploads,
  extractS3Key,
} from "../middlewares/uploadMiddleware.js";
import { deleteFile } from "../../utils/s3Upload.js";
import { PrismaClient } from "@prisma/client";
import { Request, Response, NextFunction } from "express";

// Type for the model instance passed to constructor
interface PrismaModel {
  modelName: string;
  relationFields: string[];
  fileFields?: string[];
  getZodSchema: () => any;
  getPartialZodSchema: () => any;
}

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
};

export class BaseController {
  private prisma: PrismaClient;
  private model: PrismaModel;
  private maxLimit: number;
  private validRelations: string[];

  constructor(model: PrismaModel) {
    this.prisma = DatabaseConnection.getClient();
    this.model = model;
    this.maxLimit = 100;
    this.validRelations = Array.isArray(model.relationFields)
      ? model.relationFields
      : [];
  }

  // ========================
  // Internal Helpers
  // ========================
  private getModelClient(): PrismaModelClient {
    return (this.prisma as any)[this.model.modelName];
  }

  private _isValidRelation(fieldName: string): boolean {
    return this.validRelations.includes(fieldName);
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

  private _parseQueryParams(req: Request) {
    const {
      page = 1,
      limit = 10,
      sort,
      fields,
      filter,
      include,
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
      this.maxLimit
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

    const where: Record<string, any> = { ...jsonFilter };
    for (const [key, value] of Object.entries(simpleFilters)) {
      if (typeof value === "string" && value.includes(":")) {
        const [operator, val] = value.split(":");
        switch (operator) {
          case "gt":
          case "gte":
          case "lt":
          case "lte":
          case "contains":
          case "startsWith":
          case "endsWith":
            where[key] = { ...where[key], [operator]: val };
            break;
          case "in":
            where[key] = { ...where[key], in: val.split(",") };
            break;
          default:
            where[key] = value;
        }
      } else {
        where[key] = value;
      }
    }

    return {
      skip,
      take: parsedLimit,
      ...(Object.keys(orderBy).length > 0 && { orderBy }),
      ...(select && { select }),
      ...(parsedInclude && { include: parsedInclude }),
      where: Object.keys(where).length > 0 ? where : undefined,
    };
  }

  private _processNestedFields(
    data: Record<string, any>,
    isUpdate: boolean = false
  ) {
    const nestedData: Record<string, any> = {};

    for (const [field, value] of Object.entries(data)) {
      if (!this._isValidRelation(field) || value == null) continue;

      if (isUpdate) {
        nestedData[field] = {};
        if (value.create) nestedData[field].create = value.create;
        if (value.connect) nestedData[field].connect = value.connect;
        if (value.disconnect) nestedData[field].disconnect = value.disconnect;
        if (value.delete) nestedData[field].delete = value.delete;
        if (value.update) nestedData[field].update = value.update;

        if (
          !value.create &&
          !value.connect &&
          !value.disconnect &&
          !value.update &&
          !value.delete &&
          Object.keys(value).length > 0
        ) {
          nestedData[field].update = value;
        }
      } else {
        if (value.create || value.connect) {
          nestedData[field] = {};
          if (value.create) nestedData[field].create = value.create;
          if (value.connect) nestedData[field].connect = value.connect;
        } else {
          nestedData[field] = { create: value };
        }
      }
    }

    return nestedData;
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
      res.json({
        data: items,
        meta: {
          total,
          page: parseInt(req.query.page as string) || 1,
          limit: queryOptions.take,
          totalPages: Math.max(1, Math.ceil(total / queryOptions.take)),
        },
      });
    } catch (error: any) {
      if (error.message.includes("Invalid JSON")) {
        res.status(400).json({ error: error.message });
      } else {
        next(error);
      }
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
      }

      const item = await this.getModelClient().findUnique({
        where: { id: req.params.id },
        ...(select && { select }),
        ...(include && { include: JSON.parse(include) }),
      });

      if (!item) return res.status(404).json({ error: "Not found" });
      res.json(item);
    } catch (error: any) {
      if (error.message.includes("Invalid JSON")) {
        res.status(400).json({ error: error.message });
      } else {
        next(error);
      }
    }
  };

  create = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validatedData = await this._validateWithModelSchema(req.body);
      const nestedData = this._processNestedFields(req.body, false);

      const newItem = await this.getModelClient().create({
        data: {
          ...validatedData,
          ...nestedData,
        },
      });

      res.status(201).json(newItem);
    } catch (error: any) {
      if (error.message.startsWith("[")) {
        res.status(400).json({
          error: "Validation failed",
          details: JSON.parse(error.message),
        });
      } else {
        next(error);
      }
    }
  };

  update = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validatedData = await this._validateWithModelSchema(req.body, true);
      const nestedData = this._processNestedFields(req.body, true);

      const updatedItem = await this.getModelClient().update({
        where: { id: req.params.id },
        data: {
          ...validatedData,
          ...nestedData,
        },
      });

      if (!updatedItem) return res.status(404).json({ error: "Not found" });
      res.json(updatedItem);
    } catch (error: any) {
      if (error.message.startsWith("[")) {
        res.status(400).json({
          error: "Validation failed",
          details: JSON.parse(error.message),
        });
      } else {
        next(error);
      }
    }
  };

  delete = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existingItem = await this.getModelClient().findUnique({
        where: { id: req.params.id },
      });

      if (!existingItem) {
        return res.status(404).json({ error: "Not found" });
      }

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

      res.status(204).end();
    } catch (error) {
      next(error);
    }
  };

  // ========================
  // File Upload Methods
  // ========================
  createWithFiles = [
    (req: Request, res: Response, next: NextFunction) =>
      handleMultipleFiles(this.model.fileFields || [])(req, res, next),
    processFileUploads,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const validatedData = await this._validateWithModelSchema(req.body);
        const nestedData = this._processNestedFields(req.body, false);

        const newItem = await this.getModelClient().create({
          data: {
            ...validatedData,
            ...nestedData,
            ...req.uploadedFiles,
          },
        });

        res.status(201).json(newItem);
      } catch (error: any) {
        if (error.message.startsWith("[")) {
          res.status(400).json({
            error: "Validation failed",
            details: JSON.parse(error.message),
          });
        } else {
          next(error);
        }
      }
    },
  ];

  updateWithFiles = [
    (req: Request, res: Response, next: NextFunction) =>
      handleMultipleFiles(this.model.fileFields || [])(req, res, next),
    processFileUploads,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const validatedData = await this._validateWithModelSchema(
          req.body,
          true
        );
        const nestedData = this._processNestedFields(req.body, true);

        const existingItem = await this.getModelClient().findUnique({
          where: { id: req.params.id },
        });

        if (existingItem && this.model.fileFields?.length) {
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

        if (!updatedItem) return res.status(404).json({ error: "Not found" });
        res.json(updatedItem);
      } catch (error: any) {
        if (error.message.startsWith("[")) {
          res.status(400).json({
            error: "Validation failed",
            details: JSON.parse(error.message),
          });
        } else {
          next(error);
        }
      }
    },
  ];
}
