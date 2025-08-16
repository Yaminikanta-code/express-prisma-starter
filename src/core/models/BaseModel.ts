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
  rawQueryEnabled: boolean; // Whether raw queries are allowed for this model
  tables: string[]; // Allowed tables (if rawQueryEnabled is true)
  columns: Record<string, string[] | "*">; // Allowed columns per table (if rawQueryEnabled is true)
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
  };

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
   * SQL Injection-Safe Raw Query with Table and Column Validation
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

    const queryLower = query.toLowerCase();
    const fromMatch = queryLower.match(/from\s+([a-z_]+)/i);
    if (fromMatch && !this.queryWhitelist.tables.includes(fromMatch[1])) {
      throw new Error(`Disallowed table: ${fromMatch[1]}`);
    }

    if (fromMatch) {
      const table = fromMatch[1];
      const allowedColumns = this.queryWhitelist.columns[table];
      if (allowedColumns !== "*") {
        const selectMatch = queryLower.match(/select\s+(.+?)\s+from/i);
        if (selectMatch) {
          const selectedColumns = selectMatch[1]
            .split(",")
            .map((col) => col.trim().replace(/^[\s`'"]+|[\s`'"]+$/g, ""));
          for (const col of selectedColumns) {
            if (col === "*") {
              throw new Error(`Wildcard (*) is not allowed for table ${table}`);
            }
            if (!allowedColumns.includes(col)) {
              throw new Error(`Disallowed column for table ${table}: ${col}`);
            }
          }
        }
      }
    }

    logger.info(`[${this.modelName}] Raw query`, { query: queryLower });
    try {
      return await this.prisma.$queryRaw(Prisma.sql([query], values));
    } catch (error: any) {
      logger.error(`[${this.modelName}] Raw query failed`, {
        error: error.message,
      });
      throw new Error("Database query failed");
    }
  }

  /**
   * Safe Transaction with Retries
   */
  static async runInTransaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options: TransactionOptions = {}
  ): Promise<T> {
    if (typeof fn !== "function") {
      throw new Error("Transaction callback must be a function");
    }

    const {
      maxRetries = 3,
      timeoutMs = 5000,
      isolationLevel = "Serializable",
    } = options;

    let retries = 0;
    while (retries < maxRetries) {
      try {
        return await this.prisma.$transaction(
          async (tx: Prisma.TransactionClient) => {
            const timeoutPromise = new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error("Transaction timeout")),
                timeoutMs
              )
            );
            return Promise.race([fn(tx), timeoutPromise]);
          },
          { isolationLevel, maxWait: timeoutMs }
        );
      } catch (error: any) {
        retries++;
        logger.warn(
          `[${this.modelName}] Transaction attempt ${retries} failed`,
          { error: error.message }
        );

        if (!RETRYABLE_ERRORS.includes(error.code) || retries >= maxRetries) {
          logger.error(
            `[${this.modelName}] Transaction aborted after ${retries} retries`
          );
          throw error;
        }

        // Exponential backoff
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** retries));
      }
    }
    throw new Error("Transaction failed after maximum retries");
  }
}
