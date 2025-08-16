import { PrismaClient } from "@prisma/client";
import { logger } from "../../utils/logger.js";

interface DatabaseConfig {
  url: string;
}

export class DatabaseConnection {
  private static instance: DatabaseConnection;
  private static prisma: PrismaClient | null = null;
  private config: DatabaseConfig;

  private constructor(config: DatabaseConfig) {
    this.config = config;
  }

  static async initialize(config: DatabaseConfig): Promise<DatabaseConnection> {
    if (!DatabaseConnection.prisma) {
      DatabaseConnection.prisma = new PrismaClient({
        datasources: {
          db: {
            url: config.url,
          },
        },
        log: [
          { level: "warn", emit: "event" },
          { level: "info", emit: "event" },
          { level: "error", emit: "event" },
        ],
      });

      // Type assertion to bypass TypeScript's limitations
      const prisma = DatabaseConnection.prisma;

      (prisma as any).$on(
        "warn",
        (e: { timestamp: Date; message: string; target: string }) => {
          logger.warn(`[${e.target}] ${e.message}`);
        }
      );

      (prisma as any).$on(
        "info",
        (e: { timestamp: Date; message: string; target: string }) => {
          logger.info(`[${e.target}] ${e.message}`);
        }
      );

      (prisma as any).$on(
        "error",
        (e: { timestamp: Date; message: string; target: string }) => {
          logger.error(`[${e.target}] ${e.message}`);
        }
      );

      logger.info("PostgreSQL connected successfully");
    }

    if (!DatabaseConnection.instance) {
      DatabaseConnection.instance = new DatabaseConnection(config);
    }

    return DatabaseConnection.instance;
  }

  static getClient(): PrismaClient {
    if (!DatabaseConnection.prisma) {
      throw new Error("Database not initialized");
    }
    return DatabaseConnection.prisma;
  }

  static async close(): Promise<void> {
    if (DatabaseConnection.prisma) {
      await DatabaseConnection.prisma.$disconnect();
      DatabaseConnection.prisma = null;
      DatabaseConnection.instance = null!;
      logger.info("PostgreSQL connection closed");
    }
  }
}
