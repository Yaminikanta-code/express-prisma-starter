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

type JoinConfig = {
  allowed: boolean;
  tables: string[]; // Specific tables that can be joined with
  types?: string[]; // INNER, LEFT, RIGHT, FULL
};

type SortConfig = {
  allowed: boolean;
  maxColumns?: number;
  allowedColumns?: string[] | "*";
};

type QueryWhitelist = {
  rawQueryEnabled: boolean;
  tables: string[];
  columns: Record<string, string[] | "*">;
  allowedOperations?: string[]; // SELECT, INSERT, UPDATE, DELETE
  maxQueryLength?: number;
  parameterizedOnly?: boolean;
  joins?: Record<string, JoinConfig> | boolean; // Table-specific or global join config
  sorting?: Record<string, SortConfig> | boolean; // Table-specific or global sort config
  maxResultRows?: number; // Limit result set size
};

// Relation metadata type
type RelationMetadata = {
  model: typeof BaseModel;
  relationType: "oneToOne" | "oneToMany" | "manyToOne" | "manyToMany";
};

export class BaseModel {
  static modelName: string = "";
  static relationFields: string[] = [];
  static zodSchema: any = null;
  static fileFields: string[] = [];
  static queryWhitelist: QueryWhitelist = {
    rawQueryEnabled: false, // Disabled by default
    tables: [],
    columns: {},
    allowedOperations: ["SELECT"], // Default to read-only
    maxQueryLength: 5000,
    parameterizedOnly: true,
    joins: false, // Disabled by default
    sorting: false, // Disabled by default
    maxResultRows: 1000,
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
   * Enhanced SQL Injection-Safe Raw Query with JOIN and SORT support
   */
  static async queryRaw(query: string, values: any[] = []): Promise<any[]> {
    if (!this.queryWhitelist.rawQueryEnabled) {
      throw new Error("Raw queries are not enabled for this model");
    }

    // Validate basic query structure
    if (typeof query !== "string" || query.trim() === "") {
      throw new Error("Query must be a non-empty string");
    }

    if (!Array.isArray(values)) {
      throw new Error("Values must be an array");
    }

    // Query length limit
    if (
      this.queryWhitelist.maxQueryLength &&
      query.length > this.queryWhitelist.maxQueryLength
    ) {
      throw new Error("Query exceeds maximum allowed length");
    }

    // Force parameterized queries
    if (this.queryWhitelist.parameterizedOnly) {
      this.validateParameterizedOnly(query);
    }

    const queryLower = query.toLowerCase().trim();
    const operation = queryLower.split(/\s+/)[0];

    if (
      !this.queryWhitelist.allowedOperations?.includes(operation.toUpperCase())
    ) {
      throw new Error(`Disallowed SQL operation: ${operation}`);
    }

    // Enhanced validation with JOIN and SORT support
    await this.validateQuery(queryLower, operation);

    logger.info(`[${this.modelName}] Raw query`, {
      query: queryLower,
      operation,
    });

    try {
      const result = await this.prisma.$queryRaw(Prisma.sql([query], values));

      // Apply result size limit if configured
      if (this.queryWhitelist.maxResultRows && Array.isArray(result)) {
        return result.slice(0, this.queryWhitelist.maxResultRows);
      }
      if (Array.isArray(result)) {
        return result;
      } else {
        throw new Error("Unexpected result type");
      }
    } catch (error: any) {
      logger.error(`[${this.modelName}] Raw query failed`, {
        error: error.message,
        query: queryLower,
      });
      throw new Error("Database query failed");
    }
  }

  /**
   * Validate that only parameterized queries are used
   */
  private static validateParameterizedOnly(query: string): void {
    const inlineValuePatterns = [/'[^']*'/g, /"[^"]*"/g, /\b\d+\b/g, /null/gi];

    const testQuery = query.replace(/\?/g, "");
    for (const pattern of inlineValuePatterns) {
      if (pattern.test(testQuery)) {
        throw new Error(
          "Only parameterized queries are allowed. Use ? placeholders for values."
        );
      }
    }
  }

  /**
   * Comprehensive query validation with JOIN and SORT support
   */
  private static async validateQuery(
    query: string,
    operation: string
  ): Promise<void> {
    // Extract all tables from the query
    const tables = this.extractAllTables(query);
    const uniqueTables = [...new Set(tables)];

    // Validate all tables
    for (const table of uniqueTables) {
      if (!this.queryWhitelist.tables.includes(table)) {
        throw new Error(`Disallowed table: ${table}`);
      }
    }

    // Validate JOINs if enabled
    if (this.queryWhitelist.joins) {
      await this.validateJoins(query, uniqueTables);
    }

    // Validate SORT/ORDER BY if enabled
    if (this.queryWhitelist.sorting) {
      await this.validateSorting(query, uniqueTables);
    }

    // Operation-specific validation
    switch (operation) {
      case "select":
        await this.validateSelectQuery(query, uniqueTables);
        break;
      case "insert":
        await this.validateInsertQuery(query);
        break;
      case "update":
        await this.validateUpdateQuery(query);
        break;
      case "delete":
        await this.validateDeleteQuery(query);
        break;
    }
  }

  /**
   * Extract all tables from various SQL clauses
   */
  private static extractAllTables(query: string): string[] {
    const tablePatterns = [
      /from\s+([a-z_][a-z0-9_]*)/gi,
      /join\s+([a-z_][a-z0-9_]*)/gi,
      /insert\s+into\s+([a-z_][a-z0-9_]*)/gi,
      /update\s+([a-z_][a-z0-9_]*)/gi,
      /delete\s+from\s+([a-z_][a-z0-9_]*)/gi,
    ];

    const tables: string[] = [];
    for (const pattern of tablePatterns) {
      const matches = query.matchAll(pattern);
      for (const match of matches) {
        tables.push(match[1].toLowerCase());
      }
    }

    return tables;
  }

  /**
   * Validate JOIN operations
   */
  private static async validateJoins(
    query: string,
    tables: string[]
  ): Promise<void> {
    const joinMatches = query.matchAll(
      /(inner|left|right|full)\s+join\s+([a-z_][a-z0-9_]*)/gi
    );

    for (const match of joinMatches) {
      const joinType = match[1]?.toLowerCase() || "inner";
      const joinTable = match[2].toLowerCase();

      // Get join configuration
      const joinConfig = this.getJoinConfig(joinTable);

      if (!joinConfig || !joinConfig.allowed) {
        throw new Error(`JOIN not allowed with table: ${joinTable}`);
      }

      // Validate join types
      if (joinConfig.types && !joinConfig.types.includes(joinType)) {
        throw new Error(
          `JOIN type '${joinType}' not allowed for table: ${joinTable}`
        );
      }

      // Validate specific table relationships if configured
      if (joinConfig.tables && joinConfig.tables.length > 0) {
        const canJoinWith = tables.some(
          (table) => table !== joinTable && joinConfig.tables!.includes(table)
        );

        if (!canJoinWith) {
          throw new Error(
            `Table ${joinTable} cannot be joined with the specified tables`
          );
        }
      }
    }
  }

  /**
   * Get join configuration for a table
   */
  private static getJoinConfig(table: string): JoinConfig | null {
    if (typeof this.queryWhitelist.joins === "boolean") {
      return this.queryWhitelist.joins ? { allowed: true, tables: [] } : null;
    }

    return this.queryWhitelist.joins?.[table] || null;
  }

  /**
   * Validate ORDER BY/SORT operations
   */
  private static async validateSorting(
    query: string,
    tables: string[]
  ): Promise<void> {
    const orderByMatch = query.match(/order\s+by\s+([^;]+)(?:\s|;|$)/i);
    if (!orderByMatch) return;

    const orderByClause = orderByMatch[1];
    const columnMatches = orderByClause.matchAll(
      /([a-z_][a-z0-9_]*)(?:\.([a-z_][a-z0-9_]*))?/gi
    );

    let columnCount = 0;

    for (const match of columnMatches) {
      const tableName = match[1];
      const columnName = match[2] || match[1]; // Handle both table.column and column formats

      columnCount++;

      // Get sort configuration
      const sortConfig = this.getSortConfig(tableName);

      if (!sortConfig || !sortConfig.allowed) {
        throw new Error(`Sorting not allowed for table: ${tableName}`);
      }

      // Validate column count limit
      if (sortConfig.maxColumns && columnCount > sortConfig.maxColumns) {
        throw new Error(
          `Exceeded maximum sort columns limit: ${sortConfig.maxColumns}`
        );
      }

      // Validate specific columns if configured
      if (sortConfig.allowedColumns && sortConfig.allowedColumns !== "*") {
        if (!sortConfig.allowedColumns.includes(columnName)) {
          throw new Error(`Sorting not allowed on column: ${columnName}`);
        }
      }

      // Ensure the column exists in whitelist
      const tableColumns = this.queryWhitelist.columns[tableName];
      if (
        tableColumns &&
        tableColumns !== "*" &&
        !tableColumns.includes(columnName)
      ) {
        throw new Error(`Column not in whitelist: ${tableName}.${columnName}`);
      }
    }
  }

  /**
   * Get sort configuration for a table
   */
  private static getSortConfig(table: string): SortConfig | null {
    if (typeof this.queryWhitelist.sorting === "boolean") {
      return this.queryWhitelist.sorting ? { allowed: true } : null;
    }

    return this.queryWhitelist.sorting?.[table] || null;
  }

  /**
   * Enhanced SELECT validation with JOIN awareness
   */
  private static async validateSelectQuery(
    query: string,
    tables: string[]
  ): Promise<void> {
    for (const table of tables) {
      const allowedColumns = this.queryWhitelist.columns[table];
      if (allowedColumns === "*") continue;

      // Enhanced column pattern matching for complex queries with JOINs
      const columnPatterns = [
        new RegExp(`\\b${table}\\.([a-z_][a-z0-9_]*)\\b`, "gi"),
        new RegExp(`\\b([a-z_][a-z0-9_]*)\\.${table}\\b`, "gi"),
        new RegExp(`\\b([a-z_][a-z0-9_]*)\\s+as\\s+${table}\\.`, "gi"), // Aliases
      ];

      for (const pattern of columnPatterns) {
        const columnMatches = query.matchAll(pattern);
        for (const match of columnMatches) {
          const column = match[1];
          if (!allowedColumns.includes(column)) {
            throw new Error(`Disallowed column for table ${table}: ${column}`);
          }
        }
      }
    }
  }

  private static async validateInsertQuery(query: string): Promise<void> {
    const tableMatch = query.match(/insert\s+into\s+([a-z_][a-z0-9_]*)/i);
    if (!tableMatch) return;

    const table = tableMatch[1].toLowerCase();
    const allowedColumns = this.queryWhitelist.columns[table];

    if (allowedColumns && allowedColumns !== "*") {
      const columnMatch = query.match(/\(([^)]+)\)\s*values/i);
      if (columnMatch) {
        const columns = columnMatch[1].split(",").map((col) => col.trim());
        for (const column of columns) {
          if (!allowedColumns.includes(column)) {
            throw new Error(`Disallowed column for INSERT: ${column}`);
          }
        }
      }
    }
  }

  private static async validateUpdateQuery(query: string): Promise<void> {
    const tableMatch = query.match(/update\s+([a-z_][a-z0-9_]*)/i);
    if (!tableMatch) return;

    const table = tableMatch[1].toLowerCase();
    const allowedColumns = this.queryWhitelist.columns[table];

    if (allowedColumns && allowedColumns !== "*") {
      const setMatches = query.matchAll(/set\s+([a-z_][a-z0-9_]*)\s*=/gi);
      for (const match of setMatches) {
        const column = match[1].toLowerCase();
        if (!allowedColumns.includes(column)) {
          throw new Error(`Disallowed column for UPDATE: ${column}`);
        }
      }
    }
  }

  private static async validateDeleteQuery(query: string): Promise<void> {
    // Basic validation - primarily handled by table whitelisting
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
      { error: lastError?.message }
    );

    throw lastError || new Error("Transaction failed");
  }

  /**
   * Helper method for nested validation
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
