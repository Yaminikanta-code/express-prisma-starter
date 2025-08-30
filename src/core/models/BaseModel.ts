import { DatabaseConnection } from "../db/database.js";
import { createPartialZodSchema } from "../../utils/schemaValidator.js";
import { logger } from "../../utils/logger.js";
import { RETRYABLE_ERRORS } from "../../constants/Prisma.errors.js";
import { Prisma } from "@prisma/client";

type TransactionFn<T = any> = (tx: Prisma.TransactionClient) => Promise<T>;
type TransactionOptions = {
  maxRetries?: number;
  timeoutMs?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
};

type QueryWhitelist = {
  rawQueryEnabled: boolean;
  tables: string[];
  columns: Record<string, string[] | "*">;
  allowedOperations?: string[]; // SELECT, INSERT, UPDATE, DELETE
};

// Relation metadata type
type RelationMetadata = {
  model: typeof BaseModel;
  relationType: "oneToOne" | "oneToMany" | "manyToOne" | "manyToMany";
};

export class BaseModel {
  static modelName: string | null = null;
  static relationFields: string[] = [];
  static zodSchema: any = null;
  static fileFields: string[] = [];
  static queryWhitelist: QueryWhitelist = {
    rawQueryEnabled: false, // Disabled by default
    tables: [],
    columns: {},
    allowedOperations: ["SELECT"], // Default to read-only
  };

  // Relation metadata for nested validation
  static relationMetadata: Record<string, RelationMetadata> = {};

  static get prisma() {
    return DatabaseConnection.getClient();
  }

  static getZodSchema() {
    if (!this.zodSchema) {
      throw new Error("zodSchema must be defined in child class");
    }
    return this.zodSchema;
  }

  static getPartialZodSchema() {
    if (!this.zodSchema) {
      throw new Error("zodSchema must be defined in child class");
    }
    return createPartialZodSchema(this.zodSchema);
  }

  /**
   * Get related model for nested validation
   */
  static getRelationModel(relationField: string): typeof BaseModel | undefined {
    return this.relationMetadata[relationField]?.model;
  }

  /**
   * Enhanced SQL Injection-Safe Raw Query with Better Validation
   */
  static async queryRaw(query: string, values: any[] = []): Promise<any[]> {
    if (!this.queryWhitelist.rawQueryEnabled) {
      throw new Error("Raw queries are not enabled for this model");
    }

    if (typeof query !== "string" || query.trim() === "") {
      throw new Error("Query must be a non-empty string");
    }

    if (!Array.isArray(values)) {
      throw new Error("Values must be an array");
    }

    // Basic SQL operation validation
    const queryLower = query.toLowerCase().trim();
    const operation = queryLower.split(/\s+/)[0];

    if (
      !this.queryWhitelist.allowedOperations?.includes(operation.toUpperCase())
    ) {
      throw new Error(`Disallowed SQL operation: ${operation}`);
    }

    // For SELECT queries, validate tables and columns
    if (operation === "select") {
      await this.validateSelectQuery(queryLower);
    }

    logger.info(`[${this.modelName}] Raw query`, {
      query: queryLower,
      operation,
    });

    try {
      return await this.prisma.$queryRaw(Prisma.sql([query], values));
    } catch (error: any) {
      logger.error(`[${this.modelName}] Raw query failed`, {
        error: error.message,
        query: queryLower,
      });
      throw new Error("Database query failed");
    }
  }

  /**
   * Validate SELECT query structure
   */
  private static async validateSelectQuery(query: string): Promise<void> {
    // Extract tables from FROM and JOIN clauses
    const tableMatches = [
      ...query.matchAll(/from\s+([a-z_][a-z0-9_]*)/gi),
      ...query.matchAll(/join\s+([a-z_][a-z0-9_]*)/gi),
    ];

    const tables = tableMatches.map((match) => match[1]);

    for (const table of tables) {
      if (!this.queryWhitelist.tables.includes(table)) {
        throw new Error(`Disallowed table: ${table}`);
      }
    }

    // Validate columns for each allowed table
    for (const table of this.queryWhitelist.tables) {
      const allowedColumns = this.queryWhitelist.columns[table];
      if (allowedColumns === "*") continue;

      // Simple column validation - look for table.column patterns
      const columnPattern = new RegExp(
        `\\b${table}\\.([a-z_][a-z0-9_]*)\\b`,
        "gi"
      );
      const columnMatches = query.matchAll(columnPattern);

      for (const match of columnMatches) {
        const column = match[1];
        if (!allowedColumns.includes(column)) {
          throw new Error(`Disallowed column for table ${table}: ${column}`);
        }
      }
    }
  }

  /**
   * Safe Transaction with Retries and Better Error Handling
   */
  static async runInTransaction<T>(
    fn: TransactionFn<T>,
    options: TransactionOptions = {}
  ): Promise<T> {
    if (typeof fn !== "function") {
      throw new Error("Transaction callback must be a function");
    }

    const {
      maxRetries = 3,
      timeoutMs = 5000,
      isolationLevel = "ReadCommitted", // More conservative default
    } = options;

    let lastError: Error | null = null;

    for (let retry = 0; retry < maxRetries; retry++) {
      try {
        return await this.prisma.$transaction(
          async (tx: Prisma.TransactionClient) => {
            // Create a timeout promise
            const timeoutPromise = new Promise<never>((_, reject) =>
              setTimeout(
                () =>
                  reject(new Error(`Transaction timeout after ${timeoutMs}ms`)),
                timeoutMs
              )
            );

            // Race between transaction and timeout
            const result = await Promise.race([fn(tx), timeoutPromise]);
            return result;
          },
          {
            isolationLevel,
            maxWait: timeoutMs,
            timeout: timeoutMs,
          }
        );
      } catch (error: any) {
        lastError = error;

        if (
          !RETRYABLE_ERRORS.includes(error.code) ||
          retry === maxRetries - 1
        ) {
          break;
        }

        const backoffMs = 100 * Math.pow(2, retry);
        logger.warn(`[${this.modelName}] Transaction retry ${retry + 1}`, {
          error: error.message,
          backoffMs,
        });

        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    logger.error(
      `[${this.modelName}] Transaction failed after ${maxRetries} retries`,
      {
        error: lastError?.message,
      }
    );

    throw lastError || new Error("Transaction failed");
  }

  /**
   * Helper method for nested validation (to be used with BaseController)
   */
  static async validateNestedData(
    data: any,
    isUpdate: boolean = false,
    relationField?: string
  ): Promise<any> {
    const schema = isUpdate ? this.getPartialZodSchema() : this.getZodSchema();

    if (relationField) {
      const relatedModel = this.getRelationModel(relationField);
      if (relatedModel) {
        // Recursive validation for nested relations
        return await relatedModel.validateNestedData(data, isUpdate);
      }
    }

    // Use your existing validation utility
    const validateWithZod = await import("../../utils/validation.js").then(
      (m) => m.validateWithZod
    );
    return validateWithZod(schema, data);
  }
}
