import { Request, Response, NextFunction } from "express";
import { validateWithZod } from "../../utils/validation.js";
import { DatabaseConnection } from "../../core/db/database.js";
import {
  handleMultipleFiles,
  processFileUploads,
  extractS3Key,
} from "../middlewares/uploadMiddleware.js";
import { deleteFile } from "../../utils/s3Upload.js";
import { PrismaClient } from "@prisma/client";

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
  updateMany: (args: any) => Promise<{ count: number }>;
  deleteMany: (args: any) => Promise<{ count: number }>;
};

// interface for HATEOAS links
interface Link {
  href: string;
  rel: string;
  method: string;
}

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

    // Exclude soft-deleted records unless `withDeleted` is true
    const where: Record<string, any> = {
      ...(!withDeleted && { deletedAt: null }),
      ...jsonFilter,
    };

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

  private _generateLinks(req: Request, id?: string): Link[] {
    const baseUrl = `${req.protocol}://${req.get("host")}${req.baseUrl}`;
    const links: Link[] = [
      {
        href: `${baseUrl}`,
        rel: "self",
        method: "GET",
      },
      {
        href: `${baseUrl}`,
        rel: "create",
        method: "POST",
      },
    ];

    if (id) {
      links.push(
        {
          href: `${baseUrl}/${id}`,
          rel: "self",
          method: "GET",
        },
        {
          href: `${baseUrl}/${id}`,
          rel: "update",
          method: "PUT",
        },
        {
          href: `${baseUrl}/${id}`,
          rel: "delete",
          method: "DELETE",
        },
        {
          href: `${baseUrl}/${id}/soft`,
          rel: "soft-delete",
          method: "DELETE",
        },
        {
          href: `${baseUrl}/${id}/restore`,
          rel: "restore",
          method: "POST",
        }
      );
    }

    return links;
  } //add to add methods

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
      }

      const item = await this.getModelClient().findUnique({
        where: { id: req.params.id },
        ...(select && { select }),
        ...(include && { include: JSON.parse(include) }),
      });

      if (!item) throw new Error("Not found");
      res.json(item);
    } catch (error) {
      next(error); // Delegate to errorHandler
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
    } catch (error) {
      next(error); // Delegate to errorHandler
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

      if (!updatedItem) throw new Error("Not found");
      res.json(updatedItem);
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

      res.status(204).end();
    } catch (error) {
      next(error); // Delegate to errorHandler
    }
  };

  // ========================
  // Soft Delete & Restore
  // ========================
  softDelete = async (req: Request, res: Response, next: NextFunction) => {
    try {
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

      res.status(204).end();
    } catch (error) {
      next(error); // Delegate to errorHandler
    }
  };

  restore = async (req: Request, res: Response, next: NextFunction) => {
    try {
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

      res.status(204).end();
    } catch (error) {
      next(error); // Delegate to errorHandler
    }
  };

  // ========================
  // Bulk Operations
  // ========================
  bulkCreate = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const items = req.body; // Expects an array of items
      const validatedItems = await Promise.all(
        items.map((item: any) => this._validateWithModelSchema(item))
      );

      const nestedItems = items.map((item: any) =>
        this._processNestedFields(item, false)
      );

      const createdItems = await Promise.all(
        validatedItems.map((validatedData, index) =>
          this.getModelClient().create({
            data: {
              ...validatedData,
              ...nestedItems[index],
            },
          })
        )
      );

      res.status(201).json(createdItems);
    } catch (error) {
      next(error); // Delegate to errorHandler
    }
  };

  bulkUpdate = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updates = req.body; // Expects an array of { id, ...data }
      const validatedUpdates = await Promise.all(
        updates.map((update: any) =>
          this._validateWithModelSchema(update.data, true)
        )
      );

      const nestedUpdates = updates.map((update: any) =>
        this._processNestedFields(update.data, true)
      );

      const updatedItems = await Promise.all(
        updates.map((update: any, index: number) =>
          this.getModelClient().update({
            where: { id: update.id },
            data: {
              ...validatedUpdates[index],
              ...nestedUpdates[index],
            },
          })
        )
      );

      res.json(updatedItems);
    } catch (error) {
      next(error); // Delegate to errorHandler
    }
  };

  bulkSoftDelete = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ids = req.body.ids; // Expects an array of IDs
      const result = await this.getModelClient().updateMany({
        where: { id: { in: ids }, deletedAt: null }, // Only soft-delete non-deleted items
        data: { deletedAt: new Date() },
      });

      res.json({ count: result.count });
    } catch (error) {
      next(error); // Delegate to errorHandler
    }
  };

  bulkRestore = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ids = req.body.ids; // Expects an array of IDs
      const result = await this.getModelClient().updateMany({
        where: { id: { in: ids }, deletedAt: { not: null } }, // Only restore soft-deleted items
        data: { deletedAt: null },
      });

      res.json({ count: result.count });
    } catch (error) {
      next(error); // Delegate to errorHandler
    }
  };

  bulkHardDelete = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ids = req.body.ids; // Expects an array of IDs
      const existingItems = await this.getModelClient().findMany({
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

      const result = await this.getModelClient().deleteMany({
        where: { id: { in: ids } },
      });

      res.json({ count: result.count });
    } catch (error) {
      next(error); // Delegate to errorHandler
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
      } catch (error) {
        next(error); // Delegate to errorHandler
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

        if (!updatedItem) throw new Error("Not found");
        res.json(updatedItem);
      } catch (error) {
        next(error); // Delegate to errorHandler
      }
    },
  ];
}
