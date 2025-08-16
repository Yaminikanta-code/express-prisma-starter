interface DBConfig {
  url: string;
  pool: {
    min: number;
    max: number;
  };
}

interface S3Config {
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  region: string;
  endpoint?: string;
}

interface AppConfig {
  port: number;
  env: "development" | "production" | "test";
}

const config = {
  db: {
    url:
      process.env.DATABASE_URL ||
      "postgresql://user:password@localhost:5432/myapp",
    pool: {
      min: 2,
      max: 10,
    },
  },
  s3: process.env.S3_ACCESS_KEY_ID
    ? {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
        bucketName: process.env.S3_BUCKET_NAME || "",
        region: process.env.S3_REGION || "",
        endpoint: process.env.S3_ENDPOINT,
      }
    : undefined,
  app: {
    port: parseInt(process.env.PORT || "3000", 10),
    env: (process.env.NODE_ENV || "development") as AppConfig["env"],
  },
};

export default config as {
  db: DBConfig;
  s3?: S3Config;
  app: AppConfig;
};
