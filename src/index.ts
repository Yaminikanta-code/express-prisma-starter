import { createApp } from "./app";
import config from "./config";

async function startServer(): Promise<void> {
  try {
    const app = await createApp();
    const server = app.listen(config.app.port, () => {
      console.log(`Server running on port ${config.app.port}`);
      console.log(`Environment: ${config.app.env}`);
    });

    process.on("unhandledRejection", (err: unknown) => {
      console.error(
        "Unhandled Rejection:",
        err instanceof Error ? err.message : err
      );
      server.close(() => process.exit(1));
    });

    process.on("SIGTERM", () => {
      console.log("SIGTERM received. Shutting down gracefully...");
      server.close(() => {
        console.log("Server closed");
        process.exit(0);
      });
    });
  } catch (error: unknown) {
    console.error(
      "Failed to start server:",
      error instanceof Error ? error.message : error
    );
    process.exit(1);
  }
}

startServer().catch((err) => {
  console.error("Unexpected error in server startup:", err);
  process.exit(1);
});
